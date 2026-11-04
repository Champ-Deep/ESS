import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/postgres';
import { shiftGroups, holidayCalendars, holidays } from '$lib/server/db/schema';
import { updatePolicyDocument, logActivity } from '$lib/server/db/mongo';
import { eq, and, desc } from 'drizzle-orm';
import { requireCap } from '$lib/server/capabilities';

interface PublishTable {
	shift_group_key: string;
	shift_group_label: string;
	holidays: Array<{ date: string; name: string; type: 'PUBLIC' | 'RESTRICTED' | 'OPTIONAL' }>;
}

/**
 * Super Admin confirms the (possibly hand-edited) extracted holiday calendar and
 * publishes it. For each shift group table: get-or-create the shift_group, create
 * a new holiday_calendars version, insert its holiday rows. Employees resolve their
 * calendar via employeeProfiles.shiftGroupId -> holiday_calendars.shiftGroupId, so
 * this is the ONLY write path admins need — nothing per-employee to touch.
 */
export const POST: RequestHandler = async (event) => {
	const user = requireCap(event, 'policies.publish');
	const documentId = event.params.id;

	const body = await event.request.json();
	const { year, effectiveFrom, tables } = body as {
		year: number;
		effectiveFrom: string;
		tables: PublishTable[];
	};

	if (!year || !effectiveFrom || !Array.isArray(tables) || tables.length === 0) {
		throw error(400, 'year, effectiveFrom, and tables[] are required');
	}

	const publishedCalendars = [];

	for (const table of tables) {
		if (!table.shift_group_key || !Array.isArray(table.holidays)) continue;

		let [group] = await db
			.select()
			.from(shiftGroups)
			.where(eq(shiftGroups.key, table.shift_group_key))
			.limit(1);

		if (!group) {
			[group] = await db
				.insert(shiftGroups)
				.values({ key: table.shift_group_key, name: table.shift_group_label ?? table.shift_group_key })
				.returning();
		}

		const [existing] = await db
			.select()
			.from(holidayCalendars)
			.where(and(eq(holidayCalendars.shiftGroupId, group.id), eq(holidayCalendars.year, year)))
			// Newest first: ascending order read the oldest version, so a third
			// upload for the same group and year reused an earlier number.
			.orderBy(desc(holidayCalendars.version));

		const nextVersion = existing ? existing.version + 1 : 1;

		// Archive any prior published calendar for this shift group + year
		await db
			.update(holidayCalendars)
			.set({ status: 'archived' })
			.where(and(eq(holidayCalendars.shiftGroupId, group.id), eq(holidayCalendars.year, year)));

		const [calendar] = await db
			.insert(holidayCalendars)
			.values({
				shiftGroupId: group.id,
				year,
				version: nextVersion,
				status: 'published',
				effectiveFrom,
				sourceDocumentId: documentId,
				publishedBy: user.id,
				publishedAt: new Date()
			})
			.returning();

		if (table.holidays.length > 0) {
			await db.insert(holidays).values(
				table.holidays.map((h) => ({
					calendarId: calendar.id,
					date: h.date,
					name: h.name,
					type: h.type ?? 'PUBLIC'
				}))
			);
		}

		publishedCalendars.push({ shiftGroupKey: table.shift_group_key, calendarId: calendar.id, version: nextVersion });
	}

	await updatePolicyDocument(documentId, { status: 'published', publishedAt: new Date() });

	await logActivity({
		actorUserId: user.id,
		action: 'holiday_calendar.publish',
		targetType: 'policy_document',
		targetId: documentId,
		details: { year, publishedCalendars }
	});

	return json({ publishedCalendars }, { status: 201 });
};

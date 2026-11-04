import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/postgres';
import { holidayCalendars } from '$lib/server/db/schema';
import { logActivity } from '$lib/server/db/mongo';
import { and, eq, ne } from 'drizzle-orm';
import { requireCap } from '$lib/server/capabilities';

/**
 * Publishes an archived holiday calendar again. One calendar per shift group
 * and year is live at a time, so whichever one was published for that group
 * and year is archived in its place.
 */
export const POST: RequestHandler = async (event) => {
	const user = requireCap(event, 'policies.publish');
	const calendarId = event.params.id;

	const [existing] = await db.select().from(holidayCalendars).where(eq(holidayCalendars.id, calendarId)).limit(1);
	if (!existing) throw error(404, 'Holiday calendar not found');

	const restored = await db.transaction(async (tx) => {
		await tx
			.update(holidayCalendars)
			.set({ status: 'archived' })
			.where(
				and(
					eq(holidayCalendars.shiftGroupId, existing.shiftGroupId),
					eq(holidayCalendars.year, existing.year),
					ne(holidayCalendars.id, calendarId)
				)
			);
		const [row] = await tx
			.update(holidayCalendars)
			.set({ status: 'published', publishedBy: user.id, publishedAt: new Date() })
			.where(eq(holidayCalendars.id, calendarId))
			.returning();
		return row;
	});

	await logActivity({
		actorUserId: user.id,
		action: 'holiday_calendar.restore',
		targetType: 'holiday_calendar',
		targetId: calendarId,
		details: { year: existing.year, version: existing.version }
	});

	return json({ calendar: restored });
};

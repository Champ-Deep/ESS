import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db/client';
import { employeeProfiles, holidayCalendars, holidays, leaveTypes, shiftGroups } from '$lib/server/db/schema';
import { eq, and } from 'drizzle-orm';

/**
 * Resolves the current employee's own holiday calendar via their shiftGroupId —
 * the ONLY thing that varies per employee. The calendar rows themselves are shared,
 * published once by Super Admin (see (app)/admin/policies).
 */
export const load: PageServerLoad = async ({ locals }) => {
	const user = locals.user!;

	const [profile] = await db
		.select()
		.from(employeeProfiles)
		.where(eq(employeeProfiles.userId, user.id))
		.limit(1);

	let resolvedCalendar: {
		shiftGroupName: string;
		year: number;
		publishedAt: string | null;
		holidays: (typeof holidays.$inferSelect)[];
	} | null = null;

	if (profile?.shiftGroupId) {
		const [group] = await db.select().from(shiftGroups).where(eq(shiftGroups.id, profile.shiftGroupId)).limit(1);
		const [calendar] = await db
			.select()
			.from(holidayCalendars)
			.where(and(eq(holidayCalendars.shiftGroupId, profile.shiftGroupId), eq(holidayCalendars.status, 'published')))
			.orderBy(holidayCalendars.year);

		if (calendar && group) {
			const rows = await db.select().from(holidays).where(eq(holidays.calendarId, calendar.id));
			resolvedCalendar = {
				shiftGroupName: group.name,
				year: calendar.year,
				publishedAt: calendar.publishedAt?.toISOString() ?? null,
				holidays: rows.sort((a, b) => a.date.localeCompare(b.date))
			};
		}
	}

	const types = await db.select().from(leaveTypes).where(eq(leaveTypes.isActive, true));

	return {
		hasShiftAssignment: Boolean(profile?.shiftGroupId),
		resolvedCalendar,
		leaveTypes: types
	};
};

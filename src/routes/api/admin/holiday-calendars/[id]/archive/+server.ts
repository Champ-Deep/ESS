import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/postgres';
import { holidayCalendars } from '$lib/server/db/schema';
import { logActivity } from '$lib/server/db/mongo';
import { eq } from 'drizzle-orm';
import { requireCap } from '$lib/server/capabilities';

export const POST: RequestHandler = async (event) => {
	const user = requireCap(event, 'policies.publish');
	const calendarId = event.params.id;

	const [existing] = await db.select().from(holidayCalendars).where(eq(holidayCalendars.id, calendarId)).limit(1);
	if (!existing) {
		throw error(404, 'Holiday calendar not found');
	}

	const [archived] = await db
		.update(holidayCalendars)
		.set({ status: 'archived' })
		.where(eq(holidayCalendars.id, calendarId))
		.returning();

	await logActivity({
		actorUserId: user.id,
		action: 'holiday_calendar.archive',
		targetType: 'holiday_calendar',
		targetId: calendarId,
		details: { year: existing.year, version: existing.version }
	});

	return json({ calendar: archived });
};

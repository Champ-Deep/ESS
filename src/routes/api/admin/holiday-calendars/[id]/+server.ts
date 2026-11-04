import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/postgres';
import { holidayCalendars, holidays } from '$lib/server/db/schema';
import { logActivity } from '$lib/server/db/mongo';
import { eq } from 'drizzle-orm';
import { requireCap } from '$lib/server/capabilities';

/**
 * Permanently deletes a holiday calendar and its holidays — published or
 * archived. Employees on that shift group stop seeing those holidays at once;
 * upload the corrected calendar to publish a replacement.
 */
export const DELETE: RequestHandler = async (event) => {
	const user = requireCap(event, 'policies.publish');
	const calendarId = event.params.id;

	const [existing] = await db.select().from(holidayCalendars).where(eq(holidayCalendars.id, calendarId)).limit(1);
	if (!existing) throw error(404, 'Holiday calendar not found');

	const removed = await db.transaction(async (tx) => {
		const rows = await tx.delete(holidays).where(eq(holidays.calendarId, calendarId)).returning({ id: holidays.id });
		await tx.delete(holidayCalendars).where(eq(holidayCalendars.id, calendarId));
		return rows.length;
	});

	await logActivity({
		actorUserId: user.id,
		action: 'holiday_calendar.delete',
		targetType: 'holiday_calendar',
		targetId: calendarId,
		details: { year: existing.year, version: existing.version, status: existing.status, holidays: removed }
	});

	return json({ ok: true, holidaysRemoved: removed });
};

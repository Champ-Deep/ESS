import { db } from '$lib/server/db/client';
import { attendance, devicePunches } from '$lib/server/db/schema';
import { and, eq, gte, isNotNull } from 'drizzle-orm';
import { loadShifts, officeToday } from '$lib/server/shifts';
import { openShift, CHECKOUT_GRACE_MINUTES, CHECKOUT_REMINDER_MINUTES } from '$lib/shift-hours';
import { deliverNotification } from '$lib/server/chat/notify';

/**
 * Check-out alerts for people with the portal closed (an open portal shows
 * ShiftReminder's pop-up itself; deliverNotification only pushes when no tab
 * is open):
 *
 *   9h after check-in      "Time to punch out"
 *   9h 30m, no check-out   "Biometric check-out missed?" → raise a correction
 *
 * Each alert goes once per shift. What was sent is remembered in memory; a
 * restart forgets it, so only shifts that crossed a threshold within the last
 * WINDOW_MINUTES are alerted, which bounds a repeat to that window.
 */

const WINDOW_MINUTES = 30;
const sent = new Set<string>();

const minutesSince = (at: Date, now: Date) => (now.getTime() - at.getTime()) / 60_000;

export async function sendShiftAlerts(now = new Date()) {
	const since = new Date(now.getTime() - 26 * 3_600_000);
	const today = officeToday(now);
	const yesterday = new Date(`${today}T00:00:00Z`);
	yesterday.setUTCDate(yesterday.getUTCDate() - 1);
	const yesterdayKey = yesterday.toISOString().slice(0, 10);

	// Anyone who punched in the last day, or has a portal check-in for it.
	const [punchers, portal] = await Promise.all([
		db
			.selectDistinct({ userId: devicePunches.matchedUserId })
			.from(devicePunches)
			.where(and(isNotNull(devicePunches.matchedUserId), gte(devicePunches.punchedAt, since))),
		db
			.selectDistinct({ userId: attendance.userId })
			.from(attendance)
			.where(and(eq(attendance.source, 'manual'), gte(attendance.date, yesterdayKey), isNotNull(attendance.checkInAt)))
	]);
	const ids = [...new Set([...punchers.map((p) => p.userId), ...portal.map((p) => p.userId)])].filter(
		(id): id is string => !!id
	);
	if (ids.length === 0) return;

	const shifts = await loadShifts(ids, yesterdayKey, today, now);
	for (const [userId, list] of shifts) {
		const open = openShift(list, now);
		if (!open?.checkInAt) continue;
		const elapsed = minutesSince(open.checkInAt, now);
		const checkIn = open.checkInAt.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });

		const due = (threshold: number) => elapsed >= threshold && elapsed < threshold + WINDOW_MINUTES;
		const once = (kind: string) => {
			const key = `${userId}|${open.checkInAt!.toISOString()}|${kind}`;
			if (sent.has(key)) return false;
			sent.add(key);
			return true;
		};

		if (due(CHECKOUT_GRACE_MINUTES) && once('missed')) {
			await deliverNotification([userId], {
				kind: 'system',
				urgent: true,
				title: 'Biometric check-out missed?',
				body: `You checked in at ${checkIn} and no check-out has reached the portal after 9h 30m. If you forgot to punch out, raise a correction.`,
				url: `/attendance?raise=${open.date}`
			});
		} else if (due(CHECKOUT_REMINDER_MINUTES) && once('remind')) {
			await deliverNotification([userId], {
				kind: 'system',
				urgent: true,
				title: 'Time to punch out',
				body: `You checked in at ${checkIn} — that's 9 hours. Remember to punch out on the biometric device.`,
				url: '/attendance'
			});
		}
	}

	// Keys for shifts long finished are no use; keep the set small.
	if (sent.size > 5000) sent.clear();
}

import { db } from '$lib/server/db/client';
import { attendance, devicePunches, employeeProfiles } from '$lib/server/db/schema';
import { and, gte, lt, lte } from 'drizzle-orm';
import { inArray } from '$lib/server/db/sql';
import { buildShifts, officeDateKey, parseShiftWindow, type PunchInput, type ShiftDay } from '$lib/shift-hours';
import { deviceUtcOffsetMinutes } from '$lib/server/easytime-import';

const addDays = (dateKey: string, days: number) => {
	const d = new Date(`${dateKey}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
};

/**
 * Days of punches read either side of the requested range: enough for a shift
 * crossing the range's edge to come out whole, and for the person's usual
 * shift to be learnt when the range is short (a single day).
 */
const MARGIN_DAYS = 2;
const LEARN_DAYS = 21;

/** The office calendar day for an instant, in the devices' zone. */
export function officeToday(now = new Date()): string {
	return officeDateKey(now, deviceUtcOffsetMinutes());
}

/**
 * Each person's shifts credited to days in [from, to] ('YYYY-MM-DD',
 * inclusive), built from every biometric punch plus portal attendance
 * (corrections and sheet uploads), so a shift that runs past midnight is
 * reported once, whole, on the day it started.
 */
export async function loadShifts(
	userIds: string[],
	from: string,
	to: string,
	now = new Date()
): Promise<Map<string, ShiftDay[]>> {
	const out = new Map<string, ShiftDay[]>();
	const ids = [...new Set(userIds)];
	if (ids.length === 0) return out;

	const offset = deviceUtcOffsetMinutes();
	const spanDays = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
	const readFrom = addDays(from, -Math.max(MARGIN_DAYS, LEARN_DAYS - spanDays));
	const readTo = addDays(to, MARGIN_DAYS);
	// Office midnight at each end, as instants.
	const fromInstant = new Date(Date.parse(`${readFrom}T00:00:00Z`) - offset * 60_000);
	const toInstant = new Date(Date.parse(`${addDays(readTo, 1)}T00:00:00Z`) - offset * 60_000);

	const [punchRows, rows, profiles] = await Promise.all([
		db
			.select({ userId: devicePunches.matchedUserId, at: devicePunches.punchedAt, direction: devicePunches.direction })
			.from(devicePunches)
			.where(
				and(
					inArray(devicePunches.matchedUserId, ids),
					gte(devicePunches.punchedAt, fromInstant),
					lt(devicePunches.punchedAt, toInstant)
				)
			),
		db
			.select({ userId: attendance.userId, checkInAt: attendance.checkInAt, checkOutAt: attendance.checkOutAt, source: attendance.source })
			.from(attendance)
			.where(and(inArray(attendance.userId, ids), gte(attendance.date, readFrom), lte(attendance.date, readTo))),
		db
			.select({ userId: employeeProfiles.userId, officeTimings: employeeProfiles.officeTimings })
			.from(employeeProfiles)
			.where(inArray(employeeProfiles.userId, ids))
	]);

	const punches = new Map<string, PunchInput[]>(ids.map((id) => [id, []]));
	for (const p of punchRows) {
		if (!p.userId) continue;
		punches.get(p.userId)!.push({ at: p.at, direction: p.direction === 'in' || p.direction === 'out' ? p.direction : null });
	}
	for (const r of rows) {
		const list = punches.get(r.userId)!;
		// A portal record (an approved correction) says which punch is which. A
		// biometric row is the device's first and last punch of a calendar day —
		// already among the raw punches, and its labels are the very thing that
		// goes wrong across midnight — so it adds instants, not directions.
		const manual = r.source === 'manual';
		if (r.checkInAt) list.push({ at: r.checkInAt, direction: manual ? 'in' : null });
		if (r.checkOutAt) list.push({ at: r.checkOutAt, direction: manual ? 'out' : null });
	}
	const windowOf = new Map(profiles.map((p) => [p.userId, parseShiftWindow(p.officeTimings)]));

	for (const id of ids) {
		const shifts = buildShifts(punches.get(id)!, { window: windowOf.get(id) ?? null, now, offsetMinutes: offset });
		out.set(
			id,
			shifts.filter((s) => s.date >= from && s.date <= to)
		);
	}
	return out;
}

/** One person's shifts for [from, to]. */
export async function loadShiftsFor(userId: string, from: string, to: string, now = new Date()): Promise<ShiftDay[]> {
	return (await loadShifts([userId], from, to, now)).get(userId) ?? [];
}

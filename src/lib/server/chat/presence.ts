import { db } from '$lib/server/db/client';
import {
	attendance,
	employeeProfiles,
	holidayCalendars,
	holidays,
	leaveApplications,
	prohanceDays,
	users
} from '$lib/server/db/schema';
import { and, eq, gte, isNotNull, lte } from 'drizzle-orm';
import { loadWeekOffFor } from '$lib/server/week-off';
import { formatMinutes, isNightShift, isQuietTime, istDateKey, istMinutes, parseOfficeHours, withinWindow } from '$lib/chat/rules';
import { kv } from './bus';

/**
 * The status beside every name in Champ Chat, worked out from ESS rather than
 * typed by the person: on leave, holiday, week off, in today, off shift.
 * "Online" (the portal is open right now) is separate: a heartbeat from each
 * open tab, kept in Redis for 70 seconds.
 *
 * Worked out for everyone at once and cached for a minute: at ~250 people it
 * is a handful of queries, far cheaper than asking per name.
 */

export type WorkStatus = {
	state: 'in' | 'left' | 'leave' | 'holiday' | 'weekoff' | 'off' | 'night' | 'not_in';
	label: string;
	/** Notifications wait: outside their hours, or they are away today. */
	quiet: boolean;
};

let cache: { at: number; byUser: Map<string, WorkStatus> } | null = null;

const time = (d: Date) =>
	d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });

export async function workStatuses(now = new Date()): Promise<Map<string, WorkStatus>> {
	if (cache && now.getTime() - cache.at < 60_000) return cache.byUser;
	const today = istDateKey(now);

	const [people, att, pro, leave, hols] = await Promise.all([
		db
			.select({ id: users.id, officeTimings: employeeProfiles.officeTimings, shiftGroupId: employeeProfiles.shiftGroupId })
			.from(users)
			.leftJoin(employeeProfiles, eq(employeeProfiles.userId, users.id))
			.where(eq(users.isActive, true)),
		db.select({ userId: attendance.userId, inAt: attendance.checkInAt, outAt: attendance.checkOutAt }).from(attendance).where(eq(attendance.date, today)),
		db
			.select({ userId: prohanceDays.matchedUserId, firstLogin: prohanceDays.firstLogin, lastLogout: prohanceDays.lastLogout })
			.from(prohanceDays)
			.where(and(eq(prohanceDays.sessionDate, today), isNotNull(prohanceDays.matchedUserId))),
		db
			.select({ userId: leaveApplications.userId, endDate: leaveApplications.endDate })
			.from(leaveApplications)
			.where(and(eq(leaveApplications.status, 'approved'), lte(leaveApplications.startDate, today), gte(leaveApplications.endDate, today))),
		db
			.select({ shiftGroupId: holidayCalendars.shiftGroupId, name: holidays.name })
			.from(holidays)
			.innerJoin(holidayCalendars, eq(holidayCalendars.id, holidays.calendarId))
			.where(and(eq(holidays.date, today), eq(holidayCalendars.status, 'published')))
	]);
	const weekOff = await loadWeekOffFor(people.map((p) => p.id));

	const attBy = new Map(att.map((a) => [a.userId, a]));
	const proBy = new Map(pro.filter((p) => p.userId).map((p) => [p.userId!, p]));
	const leaveBy = new Map(leave.map((l) => [l.userId, l.endDate]));
	const holBy = new Map(hols.map((h) => [h.shiftGroupId, h.name]));
	const minute = istMinutes(now);

	const byUser = new Map<string, WorkStatus>();
	for (const p of people) {
		const hours = parseOfficeHours(p.officeTimings);
		const quietNow = isQuietTime(p.officeTimings, now);
		const leaveEnd = leaveBy.get(p.id);
		if (leaveEnd) {
			const until = leaveEnd === today ? 'today' : new Date(leaveEnd + 'T00:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
			byUser.set(p.id, { state: 'leave', label: `On leave until ${until}`, quiet: true });
			continue;
		}
		const holiday = p.shiftGroupId ? holBy.get(p.shiftGroupId) : undefined;
		if (holiday) {
			byUser.set(p.id, { state: 'holiday', label: `Holiday: ${holiday}`, quiet: true });
			continue;
		}
		const a = attBy.get(p.id);
		const pr = proBy.get(p.id);
		const inAt = a?.inAt ?? pr?.firstLogin ?? null;
		const outAt = a?.inAt ? a.outAt : (pr?.lastLogout ?? null);
		if (inAt && !outAt) {
			byUser.set(p.id, { state: 'in', label: `In since ${time(new Date(inAt))}`, quiet: false });
			continue;
		}
		if (weekOff.resolverFor(p.id)(today)) {
			byUser.set(p.id, { state: 'weekoff', label: 'Week off today', quiet: true });
			continue;
		}
		if (inAt && outAt) {
			byUser.set(p.id, { state: 'left', label: `Left at ${time(new Date(outAt))}`, quiet: quietNow });
			continue;
		}
		const h = hours ?? { start: 540, end: 1080 };
		if (isNightShift(hours) && !withinWindow(minute, h.start, h.end)) {
			byUser.set(p.id, { state: 'night', label: `Night shift, starts ${formatMinutes(h.start)}`, quiet: quietNow });
			continue;
		}
		if (!withinWindow(minute, h.start, h.end)) {
			byUser.set(p.id, { state: 'off', label: `Off shift, back at ${formatMinutes(h.start)}`, quiet: quietNow });
			continue;
		}
		byUser.set(p.id, { state: 'not_in', label: 'Not checked in yet', quiet: false });
	}
	cache = { at: now.getTime(), byUser };
	return byUser;
}

/* ---------- online ---------- */

const ONLINE_TTL_S = 70;

export async function heartbeat(userId: string) {
	try {
		await kv().set(`chat:online:${userId}`, '1', 'EX', ONLINE_TTL_S);
	} catch {
		localOnline.set(userId, Date.now());
	}
}

const localOnline = new Map<string, number>();

export async function onlineSet(ids: string[]): Promise<Set<string>> {
	if (ids.length === 0) return new Set();
	try {
		const vals = await kv().mget(ids.map((id) => `chat:online:${id}`));
		return new Set(ids.filter((_, i) => vals[i]));
	} catch {
		const cut = Date.now() - ONLINE_TTL_S * 1000;
		return new Set(ids.filter((id) => (localOnline.get(id) ?? 0) > cut));
	}
}

export async function presenceFor(ids: string[]) {
	const [work, online] = await Promise.all([workStatuses(), onlineSet(ids)]);
	return ids.map((id) => ({ id, online: online.has(id), ...(work.get(id) ?? { state: 'off', label: '', quiet: false }) }));
}

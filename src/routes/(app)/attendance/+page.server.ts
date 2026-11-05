import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db/client';
import {
	attendance,
	devicePunches,
	employeeProfiles,
	holidayCalendars,
	holidays,
	leaveApplications,
	leaveTypes,
	prohanceDays,
	attendanceDeviations,
	compOffCredits,
	users as usersTable
} from '$lib/server/db/schema';
import { DEVIATION_MONTHLY_CAP, lapseExpiredCompOffs } from '$lib/server/comp-off';
import { eq, ne, and, or, gte, lt, lte, desc, sql } from 'drizzle-orm';
import { inArray } from '$lib/server/db/sql';
import { isProhanceConfigured } from '$lib/server/prohance';
import {
	CYCLE_END_DAY,
	cycleDates,
	cycleForDate,
	cycleForKey,
	daysSoFar
} from '$lib/attendance-cycle';
import { STANDARD_SHIFT_MINUTES, officeDateKey } from '$lib/shift-hours';
import { loadShiftsFor, officeToday } from '$lib/server/shifts';
import { deviceUtcOffsetMinutes } from '$lib/server/easytime-import';
import { loadWeekOffFor } from '$lib/server/week-off';
import { reviewableUserIds } from '$lib/server/approval-chain';
import { prohancePresence } from '$lib/attendance-markers';
import { notHidden } from '$lib/server/hidden-users';

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * `attendance.date` is a Postgres `date`, but node-postgres hands it back as a
 * Date at local midnight. Formatting that with toISOString() (or String().slice)
 * shifts it a day west of UTC, so the calendar day is read from the local date
 * parts instead.
 */
function attendanceDateKey(value: string | Date): string {
	if (value instanceof Date) {
		return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
	}
	return String(value).slice(0, 10);
}

export const load: PageServerLoad = async ({ locals, url }) => {
	const user = locals.user!;
	const now = new Date();
	// The office's calendar day — not UTC's, which is still "yesterday" until
	// 05:30 IST.
	const todayStr = officeToday(now);

	// Attendance runs on the payroll cycle — the 26th of one month to the 25th
	// of the next — not the calendar month. `?month=YYYY-MM` still identifies a
	// cycle by the month it ends in, so existing links keep working.
	const rawMonth = url.searchParams.get('month') ?? '';
	const currentCycle = cycleForDate(now);
	const viewMonth = /^\d{4}-(0[1-9]|1[0-2])$/.test(rawMonth) ? rawMonth : currentCycle.key;
	const cycle = cycleForKey(viewMonth);
	const [vy, vm] = viewMonth.split('-').map(Number);
	const monthStart = cycle.startDate;
	const monthEnd = cycle.endDate;
	// Exclusive upper bound for the punch timestamp query — the day after the
	// cycle's last date.
	const cycleEnd = new Date(vy, vm - 1, CYCLE_END_DAY + 1);
	const nextMonthStart = `${cycleEnd.getFullYear()}-${pad(cycleEnd.getMonth() + 1)}-${pad(cycleEnd.getDate())}`;

	const records = await db
		.select()
		.from(attendance)
		.where(
			and(
				eq(attendance.userId, user.id),
				gte(attendance.date, monthStart),
				lte(attendance.date, monthEnd)
			)
		)
		.orderBy(desc(attendance.date));

	// Raw biometric punches for the month, folded to one summary per office
	// calendar day (IST) for the day panel's "Biometric sync" line. Hours come
	// from the shifts below, never from these per-day summaries.
	const offset = deviceUtcOffsetMinutes();
	const officeMidnight = (key: string) => new Date(Date.parse(`${key}T00:00:00Z`) - offset * 60_000);
	const punches = await db
		.select({ punchedAt: devicePunches.punchedAt })
		.from(devicePunches)
		.where(
			and(
				eq(devicePunches.matchedUserId, user.id),
				gte(devicePunches.punchedAt, officeMidnight(monthStart)),
				lt(devicePunches.punchedAt, officeMidnight(nextMonthStart))
			)
		);

	const punchDayMap = new Map<string, { date: string; firstAt: Date; lastAt: Date; count: number }>();
	for (const p of punches) {
		const key = officeDateKey(p.punchedAt, offset);
		const day = punchDayMap.get(key);
		if (!day) {
			punchDayMap.set(key, { date: key, firstAt: p.punchedAt, lastAt: p.punchedAt, count: 1 });
		} else {
			if (p.punchedAt < day.firstAt) day.firstAt = p.punchedAt;
			if (p.punchedAt > day.lastAt) day.lastAt = p.punchedAt;
			day.count += 1;
		}
	}
	const punchDays = [...punchDayMap.values()];

	// Holidays from the published calendar for the viewer's shift group & year.
	let monthHolidays: Array<{ date: string; name: string; type: string }> = [];
	const [profile] = await db
		.select({
			shiftGroupId: employeeProfiles.shiftGroupId
		})
		.from(employeeProfiles)
		.where(eq(employeeProfiles.userId, user.id))
		.limit(1);
	if (profile?.shiftGroupId) {
		// A cycle can straddle a year end (26 Dec – 25 Jan), so both years'
		// published calendars are considered rather than just the end year's.
		const startYear = Number(monthStart.slice(0, 4));
		const calendarYears = startYear === vy ? [vy] : [startYear, vy];

		const calendars = await db
			.select({ id: holidayCalendars.id })
			.from(holidayCalendars)
			.where(
				and(
					eq(holidayCalendars.shiftGroupId, profile.shiftGroupId),
					inArray(holidayCalendars.year, calendarYears),
					eq(holidayCalendars.status, 'published')
				)
			)
			.orderBy(desc(holidayCalendars.version));

		if (calendars.length > 0) {
			monthHolidays = await db
				.select({ date: holidays.date, name: holidays.name, type: holidays.type })
				.from(holidays)
				.where(
					and(
						inArray(
							holidays.calendarId,
							calendars.map((c) => c.id)
						),
						gte(holidays.date, monthStart),
						lte(holidays.date, monthEnd)
					)
				);
		}
	}

	// The viewer's own leave overlapping the month (so absent days on approved
	// leave don't read as absences).
	const monthLeaves = await db
		.select({
			id: leaveApplications.id,
			startDate: leaveApplications.startDate,
			endDate: leaveApplications.endDate,
			status: leaveApplications.status,
			// `days` distinguishes a half day (0.5) from a full one; `typeCode` is
			// the stable code from the published policy (EL, SL, PINK…) and drives
			// the calendar's day marker, so a new policy type needs no code change.
			days: leaveApplications.days,
			typeName: leaveTypes.name,
			typeCode: leaveTypes.code
		})
		.from(leaveApplications)
		.innerJoin(leaveTypes, eq(leaveApplications.leaveTypeId, leaveTypes.id))
		.where(
			and(
				eq(leaveApplications.userId, user.id),
				inArray(leaveApplications.status, ['pending', 'approved', 'escalated']),
				lte(leaveApplications.startDate, monthEnd),
				gte(leaveApplications.endDate, monthStart)
			)
		);

	// ProHance activity for the cycle (polled from their Web Services API and
	// matched to this user by employee code — see $lib/server/prohance).
	const monthProhance = await db
		.select({
			sessionDate: prohanceDays.sessionDate,
			firstLogin: prohanceDays.firstLogin,
			lastLogout: prohanceDays.lastLogout,
			timeOnSystemMinutes: prohanceDays.timeOnSystemMinutes,
			dayType: prohanceDays.dayType
		})
		.from(prohanceDays)
		.where(
			and(
				eq(prohanceDays.matchedUserId, user.id),
				gte(prohanceDays.sessionDate, monthStart),
				lte(prohanceDays.sessionDate, monthEnd)
			)
		);

	// Week offs come from the roster assigned to this employee — Saturday +
	// Sunday only when they have none — so the grid and the counters below agree
	// on which days were days off.
	const weekOff = await loadWeekOffFor([user.id]);
	const isWeekOff = weekOff.resolverFor(user.id);

	// Stats follow the viewed cycle so the counters agree with the grid. Every
	// elapsed day counts, week offs included: presence is credited for any day with
	// a check-in, so excluding week offs from the denominator alone let someone who
	// worked a Saturday read as 17 of 16.
	const businessDaysSoFar =
		viewMonth === currentCycle.key
			? daysSoFar(cycle, now)
			: viewMonth < currentCycle.key
				? daysSoFar(cycle, new Date(vy, vm - 1, CYCLE_END_DAY))
				: 0;

	// Shifts are built from every punch and credited to the day they started,
	// so a shift that runs past midnight is one day's hours on its own date —
	// not a 23-hour "day" on the next one (see $lib/shift-hours).
	const shifts = await loadShiftsFor(user.id, monthStart, monthEnd, now);
	const shiftByDate = new Map(shifts.map((s) => [s.date, s]));

	// The "Today" tile: the shift credited to today, or — for someone whose
	// shift started yesterday evening — the one still running.
	const currentShift =
		shiftByDate.get(todayStr) ??
		shifts.find((s) => s.inProgress) ??
		null;
	const todaySource = records.find((r) => attendanceDateKey(r.date) === (currentShift?.date ?? todayStr))?.source ?? 'biometric';

	// Counted from shifts, not raw rows: an overnight shift touches two
	// calendar days but is one day present. A check-out whose check-in was
	// missed still means the person was at work. Days with no record but enough
	// ProHance time-on-system count too, matching the calendar's P rule.
	const shiftDates = new Set(shifts.map((s) => s.date));
	const presentDates = new Set(shiftDates);
	for (const p of monthProhance) {
		if (prohancePresence(p.timeOnSystemMinutes) === 'present') {
			presentDates.add(attendanceDateKey(p.sessionDate));
		}
	}

	// A week off counts as present without anyone badging for it: nobody is
	// expected in, so it is paid time and must not read as a day missed. Only
	// elapsed days are credited — crediting a week off still in the future would
	// have the count run ahead of the month.
	//
	// Bounded by the same date as the denominator so the two always describe the
	// same span; a set is used, so a week off that WAS worked stays one day.
	const countedUpTo =
		viewMonth === currentCycle.key
			? attendanceDateKey(now)
			: viewMonth < currentCycle.key
				? attendanceDateKey(new Date(vy, vm - 1, CYCLE_END_DAY))
				: null;
	if (countedUpTo) {
		for (const key of cycleDates(cycle)) {
			if (key <= countedUpTo && isWeekOff(key)) presentDates.add(key);
		}
	}

	const presentDays = presentDates.size;

	const measured = shifts.filter((s) => s.workedMinutes !== null);
	const avgHours =
		measured.length > 0
			? measured.reduce((sum, s) => sum + (s.workedMinutes ?? 0), 0) / measured.length / 60
			: 0;

	// --- SOP: comp-off credits & attendance deviations ---
	// Lapse first so an expired credit is never rendered as spendable (SOP §1).
	await lapseExpiredCompOffs(user.id);
	const myCompOffs = await db
		.select()
		.from(compOffCredits)
		.where(eq(compOffCredits.userId, user.id))
		.orderBy(desc(compOffCredits.workedDate));

	const myDeviations = await db
		.select()
		.from(attendanceDeviations)
		.where(eq(attendanceDeviations.userId, user.id))
		.orderBy(desc(attendanceDeviations.createdAt));

	// SOP §2: the cap counts only live biometric-related requests in the current month.
	const currentMonthKey = new Date().toISOString().slice(0, 7);
	const deviationMonthlyUsed = myDeviations.filter(
		(d) =>
			d.monthKey === currentMonthKey &&
			d.countsTowardMonthlyCap &&
			['pending', 'needs_manager_approval', 'approved'].includes(d.status)
	).length;

	// --- SOP review queue (Team Lead / HR / Super Admin) ---
	// Leads see their own team; HR and Super Admin see everyone. Nobody reviews
	// their own request, so the reviewer's own rows are excluded from the queue.
	// Not a role check: someone named as a colleague's reporting manager or
	// concerned HR may hold no admin role, and gating on role hid their queue.
	// The queues below are empty for anyone with nobody assigned to them, so
	// this stays true only for people who actually have something to decide.
	const canReview = true;
	let deviationQueue: {
		deviation: typeof attendanceDeviations.$inferSelect;
		employeeName: string;
	}[] = [];
	let compOffQueue: { credit: typeof compOffCredits.$inferSelect; employeeName: string }[] = [];

	if (canReview) {
		// Queues follow the reporting line rather than role and team. Previously a
		// Super Admin's own request was excluded from everyone's queue and simply
		// sat pending; now their manager sees it, with HR as the fallback when no
		// manager is on record.
		const [manageable, hrReviewable] = await Promise.all([
			reviewableUserIds(user, 'manager'),
			reviewableUserIds(user, 'hr')
		]);

		// Deviations are two-step: first sign-off is the manager's, and anything
		// already manager-approved is HR's to finish.
		const devRows =
			manageable.length || hrReviewable.length
				? await db
						.select({ deviation: attendanceDeviations, employeeName: usersTable.fullName })
						.from(attendanceDeviations)
						.innerJoin(usersTable, eq(attendanceDeviations.userId, usersTable.id))
						.where(
							and(
								notHidden,
								or(
									and(
										inArray(attendanceDeviations.status, ['pending', 'needs_manager_approval']),
										manageable.length
											? inArray(attendanceDeviations.userId, manageable)
											: sql`false`
									),
									and(
										eq(attendanceDeviations.status, 'manager_approved'),
										hrReviewable.length
											? inArray(attendanceDeviations.userId, hrReviewable)
											: sql`false`
									)
								)
							)
						)
						.orderBy(desc(attendanceDeviations.createdAt))
				: [];

		// Comp-off is one step — the manager decides and that credits it.
		// Comp-off is two-step like the rest: 'pending' is the manager's to sign
		// off, 'manager_approved' is the concerned HR's to credit.
		const coRows =
			manageable.length || hrReviewable.length
				? await db
						.select({ credit: compOffCredits, employeeName: usersTable.fullName })
						.from(compOffCredits)
						.innerJoin(usersTable, eq(compOffCredits.userId, usersTable.id))
						.where(
							and(
								notHidden,
								or(
									and(
										eq(compOffCredits.status, 'pending'),
										manageable.length ? inArray(compOffCredits.userId, manageable) : sql`false`
									),
									and(
										eq(compOffCredits.status, 'manager_approved'),
										hrReviewable.length ? inArray(compOffCredits.userId, hrReviewable) : sql`false`
									)
								)
							)
						)
						.orderBy(desc(compOffCredits.workedDate))
				: [];

		// A request waiting on HR is not yours to close if you gave the manager
		// sign-off yourself — it is the concerned HR's, and listing it here invited
		// exactly the same-person double approval the review API now refuses.
		deviationQueue = devRows
			.filter((r) => !(r.deviation.status === 'manager_approved' && r.deviation.reviewerId === user.id))
			.map((r) => ({
				...r,
				deviation: { ...r.deviation, date: attendanceDateKey(r.deviation.date) }
			}));
		compOffQueue = coRows
			.filter((r) => !(r.credit.status === 'manager_approved' && r.credit.approverId === user.id))
			.map((r) => ({
				...r,
				credit: {
					...r.credit,
					workedDate: attendanceDateKey(r.credit.workedDate),
					expiresOn: attendanceDateKey(r.credit.expiresOn)
				}
			}));
	}

	return {
		today: currentShift
			? { checkInAt: currentShift.checkInAt, checkOutAt: currentShift.checkOutAt, source: todaySource }
			: null,
		viewMonth,
		isCurrentMonth: viewMonth === currentCycle.key,
		// Dates normalised to a plain 'YYYY-MM-DD' string. Left as Date objects
		// they serialise through toISOString() and land a day early for anyone
		// east of UTC, which silently misfiles every row in the calendar.
		records: records.map((r) => ({ ...r, date: attendanceDateKey(r.date) })),
		punchDays,
		// Same normalisation as records — these are `date` columns too.
		monthHolidays: monthHolidays.map((h) => ({ ...h, date: attendanceDateKey(h.date) })),
		monthLeaves: monthLeaves.map((l) => ({
			...l,
			startDate: attendanceDateKey(l.startDate),
			endDate: attendanceDateKey(l.endDate)
		})),
		monthProhance: monthProhance.map((p) => ({
			...p,
			sessionDate: attendanceDateKey(p.sessionDate)
		})),
		prohanceEnabled: isProhanceConfigured(),
		weekOffRosters: weekOff.rosters,
		weekOffAssignments: weekOff.assignmentsByUser.get(user.id) ?? [],
		presentDays,
		businessDaysSoFar,
		avgHours,
		shifts,
		standardShiftMinutes: STANDARD_SHIFT_MINUTES,
		// SOP: comp-off credits and the employee's own deviation history.
		compOffCredits: myCompOffs.map((c) => ({
			...c,
			workedDate: attendanceDateKey(c.workedDate),
			expiresOn: attendanceDateKey(c.expiresOn),
			usedOn: c.usedOn ? attendanceDateKey(c.usedOn) : null
		})),
		myDeviations: myDeviations.map((d) => ({ ...d, date: attendanceDateKey(d.date) })),
		deviationMonthlyUsed,
		deviationMonthlyCap: DEVIATION_MONTHLY_CAP,
		// The queue section shows only when there is genuinely something in it, or
		// for the roles that expect to see an empty queue rather than no section.
		canReview:
			deviationQueue.length > 0 ||
			compOffQueue.length > 0 ||
			user.role === 'team_lead' ||
			user.role === 'admin' ||
			user.role === 'super_admin',
		deviationQueue,
		compOffQueue
	};
};

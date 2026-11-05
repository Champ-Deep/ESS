import { and, eq, gte, lte, or } from 'drizzle-orm';
import { inArray } from '$lib/server/db/sql';
import { alias } from 'drizzle-orm/sqlite-core';
import { db } from './db/client';
import {
	compOffCredits,
	departments,
	employeeProfiles,
	holidayCalendars,
	holidays,
	leaveAllocations,
	leaveApplications,
	leaveTypes,
	payrollAdjustments,
	prohanceDays,
	shiftGroups,
	teams,
	users
} from './db/schema';
import { cycleDates, cycleForKey, cycleLabel, shiftCycle, type AttendanceCycle } from '$lib/attendance-cycle';
import { loadShifts, officeToday } from './shifts';
import { notHidden } from './hidden-users';
import { currentRosterByUser, loadWeekOffFor } from './week-off';
import { ensureLeaveAllocations } from './leave-accrual';
import {
	cycleShortLabel,
	effectiveSalaryAction,
	leaveBalance,
	payrollDay,
	round2,
	summarizeDays,
	type DayKind,
	type DayLeave,
	type DaySummary,
	type LeaveBalanceResult,
	type SalaryAction
} from '$lib/payroll';

/**
 * Builds a payroll month from what the portal already records: biometric
 * shifts, ProHance time on system, week-off rosters, published holidays,
 * approved leave and comp-off, leave balances — plus Finance's own entries
 * (payroll_adjustments, last working days). Rules live in $lib/payroll.
 */

const pad = (n: number) => String(n).padStart(2, '0');
/** node-postgres can hand a `date` back as a local-midnight Date; read its calendar day. */
function dateKey(v: string | Date | null | undefined): string | null {
	if (!v) return null;
	if (v instanceof Date) return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
	return String(v).slice(0, 10);
}

export interface PayrollDayCell {
	code: string;
	kind: DayKind;
	/** Biometric minutes worked, ProHance minutes on system. */
	bio: number | null;
	pro: number | null;
	/** Name of the leave or holiday behind the code, for the cell's tooltip. */
	note?: string;
}

export interface PayrollEmployee {
	userId: string;
	empCode: string;
	name: string;
	doj: string | null;
	gender: string;
	department: string;
	team: string;
	designation: string;
	shift: string;
	weekOff: string;
	manager: string;
	status: 'Active' | 'Inactive';
	lwd: string | null;
	days: PayrollDayCell[];
	summary: DaySummary;
	balance: LeaveBalanceResult & {
		opening: number;
		openingOverridden: boolean;
		el: number;
		sl: number;
		compOff: number;
	};
	action: SalaryAction;
	/** True when Finance chose the action rather than the portal deriving it. */
	actionChosen: boolean;
	comment: string;
	remarks: string;
}

export interface StopSalaryBlock {
	cycleKey: string;
	label: string;
	rows: { userId: string; empCode: string; name: string; department: string; lwd: string | null; doj: string | null; action: SalaryAction; remarks: string }[];
}

export interface PayrollReport {
	cycleKey: string;
	cycleLabel: string;
	shortLabel: string;
	startDate: string;
	endDate: string;
	/** As-of date: today while the month runs, else its last day. */
	asOf: string;
	inProgress: boolean;
	dates: string[];
	employees: PayrollEmployee[];
	/** This month's stop/hold list first, then the five months before it. */
	stopSalary: StopSalaryBlock[];
}

/** Accruing types: the ones that build a balance (EL, SL…), not quotas or comp-off. */
function isAccruing(t: { code: string | null; accrualPerMonth: string; monthlyQuotaDays: string | null }) {
	return Boolean(t.code) && Number(t.accrualPerMonth) > 0 && t.monthlyQuotaDays == null;
}

export async function loadPayroll(cycleKey: string, now = new Date()): Promise<PayrollReport> {
	const cycle = cycleForKey(cycleKey);
	const dates = cycleDates(cycle);
	const today = officeToday(now);
	const asOf = today < cycle.endDate ? (today < cycle.startDate ? cycle.startDate : today) : cycle.endDate;

	/* ---- who is on this month's payroll: active staff, plus anyone whose last
	   working day falls inside or after the month; never someone joining after it. */
	const manager = alias(users, 'manager');
	const people = await db
		.select({
			userId: users.id,
			name: users.fullName,
			isActive: users.isActive,
			empCode: employeeProfiles.employeeCode,
			doj: employeeProfiles.dateOfJoining,
			gender: employeeProfiles.gender,
			designation: employeeProfiles.designation,
			teamAndFloor: employeeProfiles.teamAndFloor,
			subDept: employeeProfiles.subProcessDepartment,
			shiftType: employeeProfiles.shiftType,
			officeTimings: employeeProfiles.officeTimings,
			shiftGroupId: employeeProfiles.shiftGroupId,
			shiftGroupName: shiftGroups.name,
			lwd: employeeProfiles.lastWorkingDay,
			teamName: teams.name,
			deptName: departments.name,
			managerName: manager.fullName,
			directAuthority: employeeProfiles.directReportingAuthority
		})
		.from(users)
		.leftJoin(employeeProfiles, eq(employeeProfiles.userId, users.id))
		.leftJoin(shiftGroups, eq(shiftGroups.id, employeeProfiles.shiftGroupId))
		.leftJoin(teams, eq(teams.id, users.teamId))
		.leftJoin(departments, eq(departments.id, teams.departmentId))
		.leftJoin(manager, eq(manager.id, users.reportsTo))
		.where(and(notHidden, or(eq(users.isActive, true), gte(employeeProfiles.lastWorkingDay, cycle.startDate))));

	const roster = people
		.map((p) => ({ ...p, doj: dateKey(p.doj), lwd: dateKey(p.lwd) }))
		.filter((p) => !(p.doj && p.doj > cycle.endDate))
		.sort((a, b) => (a.empCode ?? '~').localeCompare(b.empCode ?? '~') || a.name.localeCompare(b.name));
	const ids = roster.map((p) => p.userId);

	const empty: PayrollReport = {
		cycleKey,
		cycleLabel: cycleLabel(cycle),
		shortLabel: cycleShortLabel(cycleKey),
		startDate: cycle.startDate,
		endDate: cycle.endDate,
		asOf,
		inProgress: today <= cycle.endDate,
		dates,
		employees: [],
		stopSalary: []
	};
	if (ids.length === 0) return empty;

	// Balances must be current before they are read.
	await ensureLeaveAllocations(ids);

	const endYear = cycle.endYear;
	const startYear = Number(cycle.startDate.slice(0, 4));
	const [shiftsByUser, proRows, weekOffs, rosterNames, calendars, leaveRows, compOffRows, types, allocations, adjustments] =
		await Promise.all([
			loadShifts(ids, cycle.startDate, cycle.endDate, now),
			db
				.select({ userId: prohanceDays.matchedUserId, date: prohanceDays.sessionDate, minutes: prohanceDays.timeOnSystemMinutes })
				.from(prohanceDays)
				.where(and(inArray(prohanceDays.matchedUserId, ids), gte(prohanceDays.sessionDate, cycle.startDate), lte(prohanceDays.sessionDate, cycle.endDate))),
			loadWeekOffFor(ids),
			currentRosterByUser(ids, cycle.endDate),
			db
				.select({ id: holidayCalendars.id, shiftGroupId: holidayCalendars.shiftGroupId, year: holidayCalendars.year, version: holidayCalendars.version })
				.from(holidayCalendars)
				.where(and(eq(holidayCalendars.status, 'published'), inArray(holidayCalendars.year, [...new Set([startYear, endYear])]))),
			db
				.select({
					userId: leaveApplications.userId,
					start: leaveApplications.startDate,
					end: leaveApplications.endDate,
					days: leaveApplications.days,
					code: leaveTypes.code,
					name: leaveTypes.name,
					leaveTypeId: leaveApplications.leaveTypeId
				})
				.from(leaveApplications)
				.innerJoin(leaveTypes, eq(leaveTypes.id, leaveApplications.leaveTypeId))
				// Leave from the cycle's start onwards: in-cycle days fill the
				// tracker, and later ones are added back to rebuild the opening balance.
				.where(and(inArray(leaveApplications.userId, ids), eq(leaveApplications.status, 'approved'), gte(leaveApplications.endDate, cycle.startDate))),
			db
				.select({ userId: compOffCredits.userId })
				.from(compOffCredits)
				.where(
					and(
						inArray(compOffCredits.userId, ids),
						inArray(compOffCredits.status, ['approved', 'used', 'lapsed']),
						gte(compOffCredits.workedDate, cycle.startDate),
						lte(compOffCredits.workedDate, cycle.endDate)
					)
				),
			db.select().from(leaveTypes),
			db.select().from(leaveAllocations).where(and(inArray(leaveAllocations.userId, ids), eq(leaveAllocations.year, endYear))),
			db.select().from(payrollAdjustments).where(eq(payrollAdjustments.cycleKey, cycleKey))
		]);

	/* ---- holidays: the newest published calendar per shift group and year, public days only. */
	const newest = new Map<string, (typeof calendars)[number]>();
	for (const c of calendars) {
		const k = `${c.shiftGroupId}:${c.year}`;
		if (!newest.has(k) || newest.get(k)!.version < c.version) newest.set(k, c);
	}
	const calendarIds = [...newest.values()].map((c) => c.id);
	const holidayRows = calendarIds.length
		? await db
				.select({ calendarId: holidays.calendarId, date: holidays.date, name: holidays.name, type: holidays.type })
				.from(holidays)
				.where(and(inArray(holidays.calendarId, calendarIds), gte(holidays.date, cycle.startDate), lte(holidays.date, cycle.endDate)))
		: [];
	const groupOfCalendar = new Map([...newest.values()].map((c) => [c.id, c.shiftGroupId]));
	const holidaysByGroup = new Map<string, Map<string, string>>();
	for (const h of holidayRows) {
		if ((h.type ?? 'PUBLIC').toUpperCase() !== 'PUBLIC') continue;
		const g = groupOfCalendar.get(h.calendarId)!;
		if (!holidaysByGroup.has(g)) holidaysByGroup.set(g, new Map());
		holidaysByGroup.get(g)!.set(dateKey(h.date)!, h.name);
	}

	/* ---- per-user lookups */
	const proBy = new Map<string, number>();
	for (const r of proRows) if (r.userId) proBy.set(`${r.userId}:${dateKey(r.date)}`, r.minutes ?? 0);

	const leaveBy = new Map<string, DayLeave>();
	const usedSinceStart = new Map<string, number>(); // `${userId}:${leaveTypeId}` → days
	for (const l of leaveRows) {
		const start = dateKey(l.start)!;
		const end = dateKey(l.end)!;
		const half = Number(l.days) === 0.5;
		if (start >= cycle.startDate) {
			const k = `${l.userId}:${l.leaveTypeId}`;
			usedSinceStart.set(k, (usedSinceStart.get(k) ?? 0) + Number(l.days));
		}
		for (const d of dates) if (d >= start && d <= end) leaveBy.set(`${l.userId}:${d}`, { code: l.code, name: l.name, half });
	}

	const compOffBy = new Map<string, number>();
	for (const c of compOffRows) compOffBy.set(c.userId, (compOffBy.get(c.userId) ?? 0) + 1);

	const typeById = new Map(types.map((t) => [t.id, t]));
	const adjBy = new Map(adjustments.map((a) => [a.userId, a]));

	// Months of accrual already credited from this cycle's month to now: the
	// allocations include them, so they come off to get back to the opening.
	const nowYear = now.getFullYear();
	const monthsCreditedSince = nowYear === endYear ? Math.max(0, now.getMonth() + 1 - cycle.endMonth + 1) : 0;

	const employees: PayrollEmployee[] = roster.map((p) => {
		const isWeekOff = weekOffs.resolverFor(p.userId);
		const groupHolidays = (p.shiftGroupId && holidaysByGroup.get(p.shiftGroupId)) || new Map<string, string>();
		const shifts = shiftsByUser.get(p.userId) ?? [];
		const bioBy = new Map<string, number>();
		for (const s of shifts) if (s.workedMinutes) bioBy.set(s.date, (bioBy.get(s.date) ?? 0) + s.workedMinutes);

		const days: PayrollDayCell[] = dates.map((date) => {
			const leave = leaveBy.get(`${p.userId}:${date}`) ?? null;
			const bio = bioBy.get(date) ?? null;
			const pro = proBy.get(`${p.userId}:${date}`) ?? null;
			const holidayName = groupHolidays.get(date);
			const r = payrollDay({
				date,
				today,
				dateOfJoining: p.doj,
				lastWorkingDay: p.lwd,
				isWeekOff: isWeekOff(date),
				isHoliday: Boolean(holidayName),
				leave,
				bioMinutes: bio,
				proMinutes: pro
			});
			const note = r.kind === 'holiday' ? holidayName : leave && ['leave', 'pink', 'compoff', 'compoff_half', 'half'].includes(r.kind) ? (leave.half ? `Half day · ${leave.name}` : leave.name) : undefined;
			return { code: r.code, kind: r.kind, bio, pro, ...(note ? { note } : {}) };
		});
		const summary = summarizeDays(days);

		/* ---- leave balance: today's balance of accruing leave, rewound to the cycle's start. */
		let available = 0;
		let el = 0;
		let sl = 0;
		let credited = 0;
		let addBack = 0;
		for (const a of allocations) {
			if (a.userId !== p.userId) continue;
			const t = typeById.get(a.leaveTypeId);
			if (!t || !isAccruing(t)) continue;
			const perMonth = Number(t.accrualPerMonth);
			available += Number(a.allocatedDays) - Number(a.usedDays);
			credited += perMonth * monthsCreditedSince;
			addBack += usedSinceStart.get(`${p.userId}:${t.id}`) ?? 0;
			const code = (t.code ?? '').toUpperCase();
			if (code === 'EL') el += perMonth;
			else if (code === 'SL') sl += perMonth;
			else el += perMonth; // any other accruing type credits with earned leave
		}
		const adj = adjBy.get(p.userId);
		const openingOverridden = adj?.openingBalance != null;
		const opening = openingOverridden ? Number(adj!.openingBalance) : round2(available - credited + addBack);
		const compOff = compOffBy.get(p.userId) ?? 0;
		const bal = leaveBalance({ opening, elCredit: el, slCredit: sl, compOffCredit: compOff, summary });

		const action = effectiveSalaryAction(adj?.salaryAction, p.lwd, cycle.endDate);
		const rosterName = rosterNames.get(p.userId);
		return {
			userId: p.userId,
			empCode: p.empCode ?? '',
			name: p.name,
			doj: p.doj,
			gender: p.gender ?? '',
			department: p.subDept || p.deptName || '',
			team: p.teamAndFloor || p.teamName || '',
			designation: p.designation ?? '',
			shift: p.shiftGroupName || p.shiftType || p.officeTimings || '',
			weekOff: rosterName ? `${rosterName.name} (${rosterName.summary})` : 'Sat & Sun',
			manager: p.managerName || p.directAuthority || '',
			status: p.isActive ? 'Active' : 'Inactive',
			lwd: p.lwd,
			days,
			summary,
			balance: { ...bal, opening, openingOverridden, el, sl, compOff },
			action,
			actionChosen: Boolean(adj?.salaryAction),
			comment: adj?.comment ?? '',
			remarks: adj?.remarks ?? ''
		};
	});

	return { ...empty, employees, stopSalary: await loadStopSalary(cycle, employees) };
}

/**
 * The Stop Salary sheet: this month's stopped, held and sabbatical people,
 * then the same for the five months before (leavers by last working day, and
 * anything Finance set by hand), newest first — the way HR keeps the sheet.
 */
async function loadStopSalary(cycle: AttendanceCycle, current: PayrollEmployee[]): Promise<StopSalaryBlock[]> {
	const blocks: StopSalaryBlock[] = [
		{
			cycleKey: cycle.key,
			label: cycleShortLabel(cycle.key),
			rows: current
				.filter((e) => e.action !== 'pay')
				.map((e) => ({ userId: e.userId, empCode: e.empCode, name: e.name, department: e.department, lwd: e.lwd, doj: e.doj, action: e.action, remarks: e.remarks }))
		}
	];

	const earlier = Array.from({ length: 5 }, (_, i) => cycleForKey(shiftCycle(cycle.key, -(i + 1))));
	const oldest = earlier.at(-1)!;
	const [leavers, setByHand] = await Promise.all([
		db
			.select({
				userId: users.id,
				name: users.fullName,
				empCode: employeeProfiles.employeeCode,
				dept: employeeProfiles.subProcessDepartment,
				team: employeeProfiles.teamAndFloor,
				lwd: employeeProfiles.lastWorkingDay,
				doj: employeeProfiles.dateOfJoining
			})
			.from(users)
			.innerJoin(employeeProfiles, eq(employeeProfiles.userId, users.id))
			.where(and(notHidden, gte(employeeProfiles.lastWorkingDay, oldest.startDate), lte(employeeProfiles.lastWorkingDay, earlier[0].endDate))),
		db
			.select({
				userId: payrollAdjustments.userId,
				cycleKey: payrollAdjustments.cycleKey,
				action: payrollAdjustments.salaryAction,
				remarks: payrollAdjustments.remarks,
				name: users.fullName,
				empCode: employeeProfiles.employeeCode,
				dept: employeeProfiles.subProcessDepartment,
				team: employeeProfiles.teamAndFloor,
				lwd: employeeProfiles.lastWorkingDay,
				doj: employeeProfiles.dateOfJoining
			})
			.from(payrollAdjustments)
			.innerJoin(users, eq(users.id, payrollAdjustments.userId))
			.leftJoin(employeeProfiles, eq(employeeProfiles.userId, users.id))
			.where(and(notHidden, inArray(payrollAdjustments.cycleKey, earlier.map((c) => c.key))))
	]);

	for (const c of earlier) {
		const rows = new Map<string, StopSalaryBlock['rows'][number]>();
		for (const l of leavers) {
			const lwd = dateKey(l.lwd);
			if (!lwd || lwd < c.startDate || lwd > c.endDate) continue;
			rows.set(l.userId, { userId: l.userId, empCode: l.empCode ?? '', name: l.name, department: l.dept || l.team || '', lwd, doj: dateKey(l.doj), action: 'stop', remarks: '' });
		}
		for (const a of setByHand) {
			if (a.cycleKey !== c.key) continue;
			const action = effectiveSalaryAction(a.action, dateKey(a.lwd), c.endDate);
			if (action === 'pay') {
				rows.delete(a.userId);
				continue;
			}
			rows.set(a.userId, { userId: a.userId, empCode: a.empCode ?? '', name: a.name, department: a.dept || a.team || '', lwd: dateKey(a.lwd), doj: dateKey(a.doj), action, remarks: a.remarks ?? '' });
		}
		if (rows.size) blocks.push({ cycleKey: c.key, label: cycleShortLabel(c.key), rows: [...rows.values()].sort((x, y) => x.empCode.localeCompare(y.empCode)) });
	}
	return blocks;
}

/** The payroll months offered in the picker: this one and the eleven before it. */
export function recentCycles(now = new Date(), count = 12): { key: string; label: string }[] {
	const today = officeToday(now);
	const [y, m, d] = today.split('-').map(Number);
	let key = `${y}-${pad(m)}`;
	if (d >= 26) key = shiftCycle(key, 1);
	return Array.from({ length: count }, (_, i) => {
		const k = shiftCycle(key, -i);
		return { key: k, label: `${cycleShortLabel(k)} · ${cycleLabel(cycleForKey(k))}` };
	});
}

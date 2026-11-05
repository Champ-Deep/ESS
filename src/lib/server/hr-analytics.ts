/**
 * Data for Admin → HR analytics. Gathers the rows for the chosen months and
 * department, then hands them to the pure functions in $lib/hr-analytics,
 * which hold every definition the page states.
 *
 * Exits: the portal records no leaving date, so a deactivated login counts as
 * an exit in the month it was last updated — the page says so beside the
 * figures.
 */
import { db } from '$lib/server/db/client';
import {
	announcementReads,
	announcements,
	attendance,
	chatMessages,
	departments,
	employeeProfiles,
	holidayCalendars,
	holidays,
	leaveApplications,
	leaveTypes,
	meetings,
	shiftGroups,
	tasks,
	teams,
	users
} from '$lib/server/db/schema';
import { and, eq, gte, isNotNull, isNull, lte, ne, sql } from 'drizzle-orm';
import { inArray } from '$lib/server/db/sql';
import { loadWeekOffFor } from '$lib/server/week-off';
import { officeToday } from '$lib/server/shifts';
import { notHidden } from '$lib/server/hidden-users';
import { officeDateKey } from '$lib/shift-hours';
import {
	AGE_BANDS,
	absenceSeries,
	addDays,
	ageBand,
	ageOn,
	engagementScore,
	genderOf,
	headcountSeries,
	monthsBack,
	pct,
	type GenderLabel
} from '$lib/hr-analytics';

export const RANGE_OPTIONS = [6, 12, 24] as const;
export type GroupBy = 'department' | 'team' | 'designation' | 'shift';

const dateKey = (v: string | Date) => (v instanceof Date ? officeDateKey(v) : String(v).slice(0, 10));
const UNASSIGNED = 'Unassigned';

/** Biggest groups first; anything past `keep` folds into "Other". */
function ranked(counts: Map<string, number>, keep = 10) {
	const all = [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
	if (all.length <= keep + 1) return all;
	const rest = all.slice(keep).reduce((s, g) => s + g.count, 0);
	return [...all.slice(0, keep), { name: `Other (${all.length - keep})`, count: rest }];
}

export async function loadHrAnalytics(opts: { months: number; department: string | null; now?: Date }) {
	const today = officeToday(opts.now ?? new Date());
	const months = monthsBack(today, opts.months);
	const from = months[0].start;
	const to = months.at(-1)!.end;

	// ---------- people ----------
	const rows = await db
		.select({
			id: users.id,
			fullName: users.fullName,
			isActive: users.isActive,
			createdAt: users.createdAt,
			updatedAt: users.updatedAt,
			teamName: teams.name,
			departmentName: departments.name,
			subDepartment: employeeProfiles.subProcessDepartment,
			designation: employeeProfiles.designation,
			gender: employeeProfiles.gender,
			dobActual: employeeProfiles.dobActual,
			dobDocuments: employeeProfiles.dobDocuments,
			dateOfJoining: employeeProfiles.dateOfJoining,
			shiftGroupId: employeeProfiles.shiftGroupId,
			shiftName: shiftGroups.name
		})
		.from(users)
		.leftJoin(employeeProfiles, eq(employeeProfiles.userId, users.id))
		.leftJoin(teams, eq(teams.id, users.teamId))
		.leftJoin(departments, eq(departments.id, teams.departmentId))
		.leftJoin(shiftGroups, eq(shiftGroups.id, employeeProfiles.shiftGroupId))
		.where(notHidden);

	const everyone = rows.map((r) => ({
		...r,
		department: r.departmentName ?? r.subDepartment?.trim() ?? UNASSIGNED,
		hired: r.dateOfJoining ? dateKey(r.dateOfJoining) : dateKey(r.createdAt),
		exited: r.isActive ? null : dateKey(r.updatedAt),
		dob: r.dobActual ? dateKey(r.dobActual) : r.dobDocuments ? dateKey(r.dobDocuments) : null
	}));
	const departmentNames = [...new Set(everyone.map((p) => p.department))].sort((a, b) =>
		a === UNASSIGNED ? 1 : b === UNASSIGNED ? -1 : a.localeCompare(b)
	);
	const department = opts.department && departmentNames.includes(opts.department) ? opts.department : null;
	const people = department ? everyone.filter((p) => p.department === department) : everyone;
	const active = people.filter((p) => !p.exited);
	const ids = people.map((p) => p.id);

	// ---------- headcount, hires, exits ----------
	const headcount = headcountSeries(people, months);

	// ---------- composition (active people) ----------
	const genderOrder: GenderLabel[] = ['Female', 'Male', 'Other', 'Not recorded'];
	const genderTotals = new Map<GenderLabel, number>(genderOrder.map((g) => [g, 0]));
	const genderByDept = new Map<string, Map<GenderLabel, number>>();
	for (const p of active) {
		const g = genderOf(p.gender);
		genderTotals.set(g, (genderTotals.get(g) ?? 0) + 1);
		const d = genderByDept.get(p.department) ?? new Map<GenderLabel, number>();
		d.set(g, (d.get(g) ?? 0) + 1);
		genderByDept.set(p.department, d);
	}

	const ages = active.map((p) => ageOn(p.dob, today)).filter((a): a is number => a !== null).sort((a, b) => a - b);
	const ageCounts = new Map<string, number>(AGE_BANDS.map((b) => [b, 0]));
	for (const a of ages) ageCounts.set(ageBand(a), (ageCounts.get(ageBand(a)) ?? 0) + 1);
	// Age by gender, for the pyramid: women one side, men the other.
	const pyramid = AGE_BANDS.map((band) => ({ band, female: 0, male: 0 }));
	let pyramidOther = 0;
	for (const p of active) {
		const age = ageOn(p.dob, today);
		if (age === null) continue;
		const g = genderOf(p.gender);
		const row = pyramid.find((r) => r.band === ageBand(age))!;
		if (g === 'Female') row.female++;
		else if (g === 'Male') row.male++;
		else pyramidOther++;
	}

	const countBy = (pick: (p: (typeof active)[number]) => string | null | undefined) => {
		const m = new Map<string, number>();
		for (const p of active) {
			const k = pick(p)?.trim() || UNASSIGNED;
			m.set(k, (m.get(k) ?? 0) + 1);
		}
		return ranked(m);
	};

	// ---------- absence ----------
	const weekOff = await loadWeekOffFor(ids);
	const groupIds = [...new Set(people.map((p) => p.shiftGroupId).filter((g): g is string => !!g))];
	const [holidayRows, leaveRows, punchRows, feedRows] = await Promise.all([
		groupIds.length
			? db
					.select({ groupId: holidayCalendars.shiftGroupId, date: holidays.date })
					.from(holidays)
					.innerJoin(holidayCalendars, eq(holidays.calendarId, holidayCalendars.id))
					.where(and(inArray(holidayCalendars.shiftGroupId, groupIds), eq(holidayCalendars.status, 'published'), gte(holidays.date, from), lte(holidays.date, to)))
			: Promise.resolve([]),
		ids.length
			? db
					.select({ userId: leaveApplications.userId, start: leaveApplications.startDate, end: leaveApplications.endDate, typeName: leaveTypes.name })
					.from(leaveApplications)
					.innerJoin(leaveTypes, eq(leaveTypes.id, leaveApplications.leaveTypeId))
					.where(and(inArray(leaveApplications.userId, ids), eq(leaveApplications.status, 'approved'), lte(leaveApplications.startDate, to), gte(leaveApplications.endDate, from)))
			: Promise.resolve([]),
		ids.length
			? db
					.selectDistinct({ userId: attendance.userId, date: attendance.date })
					.from(attendance)
					.where(and(inArray(attendance.userId, ids), gte(attendance.date, from), lte(attendance.date, to)))
			: Promise.resolve([]),
		// Days the feed delivered anything at all, for anyone.
		db.selectDistinct({ date: attendance.date }).from(attendance).where(and(gte(attendance.date, from), lte(attendance.date, to)))
	]);

	const holidaySet = new Set(holidayRows.map((h) => `${h.groupId}:${dateKey(h.date)}`));
	const leaveSet = new Set<string>();
	for (const l of leaveRows) {
		for (let d = dateKey(l.start); d <= dateKey(l.end); d = addDays(d, 1)) leaveSet.add(`${l.userId}:${d}`);
	}
	const punchSet = new Set(punchRows.map((r) => `${r.userId}:${dateKey(r.date)}`));
	const feedSet = new Set(feedRows.map((r) => dateKey(r.date)));

	// Leave days by type and month, counted on working days the way the leave
	// API charges them (week offs and holidays aren't leave days).
	const personById = new Map(people.map((p) => [p.id, p]));
	const leaveDays = new Map<string, Map<string, number>>();
	for (const l of leaveRows) {
		const p = personById.get(l.userId);
		if (!p) continue;
		const isOff = weekOff.resolverFor(p.id);
		const first = dateKey(l.start) < from ? from : dateKey(l.start);
		const last = dateKey(l.end) > to ? to : dateKey(l.end);
		for (let d = first; d <= last; d = addDays(d, 1)) {
			if (isOff(d) || (p.shiftGroupId && holidaySet.has(`${p.shiftGroupId}:${d}`))) continue;
			const byMonth = leaveDays.get(l.typeName) ?? new Map<string, number>();
			byMonth.set(d.slice(0, 7), (byMonth.get(d.slice(0, 7)) ?? 0) + 1);
			leaveDays.set(l.typeName, byMonth);
		}
	}
	// The three most-used types by name; the rest fold into "Other".
	const typeTotals = [...leaveDays].map(([name, m]) => ({ name, total: [...m.values()].reduce((s, n) => s + n, 0) })).sort((a, b) => b.total - a.total);
	const topTypes = typeTotals.slice(0, typeTotals.length > 4 ? 3 : 4).map((t) => t.name);
	const leaveByType = {
		types: [...topTypes, ...(typeTotals.length > topTypes.length ? ['Other'] : [])],
		months: months.map((m) => {
			const row: Record<string, number> = {};
			for (const [name, byMonth] of leaveDays) {
				const k = topTypes.includes(name) ? name : 'Other';
				row[k] = (row[k] ?? 0) + (byMonth.get(m.key) ?? 0);
			}
			return { key: m.key, label: m.label, days: row };
		})
	};

	const absence = absenceSeries(
		people.map((p) => ({
			id: p.id,
			hired: p.hired,
			exited: p.exited,
			isOff: weekOff.resolverFor(p.id),
			isHoliday: (d: string) => !!p.shiftGroupId && holidaySet.has(`${p.shiftGroupId}:${d}`)
		})),
		months,
		today,
		{
			onLeave: (id, d) => leaveSet.has(`${id}:${d}`),
			punched: (id, d) => punchSet.has(`${id}:${d}`),
			feedDay: (d) => feedSet.has(d)
		}
	);

	// ---------- engagement: chat, announcements, tasks ----------
	const monthExpr = (col: typeof chatMessages.createdAt) => sql<string>`strftime('%Y-%m', ${col} / 1000, 'unixepoch', '+5 hours', '+30 minutes')`;
	const fromTs = new Date(`${from}T00:00:00+05:30`);

	const [chatRows, chatInUse, annRows, taskRows, meetingRows] = await Promise.all([
		ids.length
			? db
					.select({ month: monthExpr(chatMessages.createdAt), authors: sql<number>`count(distinct ${chatMessages.authorId})` })
					.from(chatMessages)
					.where(and(inArray(chatMessages.authorId, ids), gte(chatMessages.createdAt, fromTs), isNull(chatMessages.deletedAt)))
					.groupBy(monthExpr(chatMessages.createdAt))
			: Promise.resolve([]),
		db
			.selectDistinct({ month: monthExpr(chatMessages.createdAt) })
			.from(chatMessages)
			.where(and(gte(chatMessages.createdAt, fromTs), isNotNull(chatMessages.authorId))),
		db
			.select({ id: announcements.id, publishAt: announcements.publishAt, createdAt: announcements.createdAt })
			.from(announcements)
			.where(and(eq(announcements.status, 'published'), eq(announcements.audienceAll, true), gte(announcements.createdAt, new Date(fromTs.getTime() - 31 * 86_400_000)))),
		ids.length
			? db
					.select({
						assigneeId: tasks.assigneeId,
						status: tasks.status,
						dueDate: tasks.dueDate,
						completedAt: tasks.completedAt,
						createdAt: tasks.createdAt,
						requestState: tasks.requestState
					})
					.from(tasks)
					.where(and(inArray(tasks.assigneeId, ids), isNotNull(tasks.assigneeId)))
			: Promise.resolve([]),
		db
			.select({ startedAt: meetings.startedAt, hostId: meetings.hostId, attendeeIds: meetings.attendeeIds })
			.from(meetings)
			.where(and(gte(meetings.startedAt, fromTs), ne(meetings.state, 'cancelled')))
	]);

	const chatByMonth = new Map(chatRows.map((r) => [r.month, r.authors]));
	const chatMonths = new Set(chatInUse.map((r) => r.month));

	const annMonth = new Map(annRows.map((a) => [a.id, dateKey(a.publishAt ?? a.createdAt).slice(0, 7)]));
	const annIds = annRows.map((a) => a.id);
	const readRows =
		annIds.length && ids.length
			? await db
					.select({ announcementId: announcementReads.announcementId, reads: sql<number>`count(*)` })
					.from(announcementReads)
					.where(and(inArray(announcementReads.announcementId, annIds), inArray(announcementReads.userId, ids)))
					.groupBy(announcementReads.announcementId)
			: [];
	const postsByMonth = new Map<string, number>();
	for (const m of annMonth.values()) postsByMonth.set(m, (postsByMonth.get(m) ?? 0) + 1);
	const readsByMonth = new Map<string, number>();
	for (const r of readRows) {
		const m = annMonth.get(r.announcementId)!;
		readsByMonth.set(m, (readsByMonth.get(m) ?? 0) + r.reads);
	}

	// Requests still waiting on, or turned down by, a lead aren't assignments yet.
	const assigned = taskRows.filter((t) => t.requestState !== 'pending' && t.requestState !== 'declined');
	const doneKey = (t: (typeof assigned)[number]) => (t.completedAt ? dateKey(t.completedAt) : null);

	const engagement = months.map((m, i) => {
		const heads = Math.max(1, headcount[i].headcount);
		const due = assigned.filter((t) => t.dueDate && dateKey(t.dueDate) >= m.start && dateKey(t.dueDate) <= m.end && dateKey(t.dueDate) <= today);
		const onTime = due.filter((t) => t.status === 'done' && (doneKey(t) ?? '9999') <= dateKey(t.dueDate!)).length;
		const parts = {
			attendance: absence[i].showUp,
			// Only months anyone at all used chat; before that it says nothing.
			chat: chatMonths.has(m.key) ? pct(chatByMonth.get(m.key) ?? 0, heads) : null,
			reads: postsByMonth.get(m.key) ? pct(readsByMonth.get(m.key) ?? 0, (postsByMonth.get(m.key) ?? 0) * heads) : null,
			tasksOnTime: due.length ? pct(onTime, due.length) : null
		};
		return { key: m.key, label: m.label, score: engagementScore(parts), ...parts };
	});

	// ---------- meetings & tasks ----------
	const inScope = new Set(ids);
	const scopedMeetings = meetingRows
		.map((m) => ({ day: dateKey(m.startedAt), people: [...new Set([m.hostId, ...m.attendeeIds].filter((x): x is string => !!x))] }))
		.filter((m) => m.day <= to && (!department || m.people.some((p) => inScope.has(p))));

	const work = months.map((m) => {
		const inMonth = scopedMeetings.filter((x) => x.day >= m.start && x.day <= m.end);
		return {
			key: m.key,
			label: m.label,
			meetings: inMonth.length,
			attendance: inMonth.reduce((s, x) => s + x.people.filter((p) => !department || inScope.has(p)).length, 0),
			assigned: assigned.filter((t) => dateKey(t.createdAt) >= m.start && dateKey(t.createdAt) <= m.end).length,
			completed: assigned.filter((t) => {
				const d = doneKey(t);
				return t.status === 'done' && d !== null && d >= m.start && d <= m.end;
			}).length
		};
	});

	const open = assigned.filter((t) => t.status !== 'done');
	const status = {
		todo: open.filter((t) => t.status === 'todo').length,
		inProgress: open.filter((t) => t.status === 'in_progress').length,
		inReview: open.filter((t) => t.status === 'in_review').length,
		overdue: open.filter((t) => t.dueDate && dateKey(t.dueDate) < today).length
	};

	// One square per day for the last 26 weeks, Monday-first columns.
	const dow = (d: string) => (new Date(d + 'T00:00:00').getDay() + 6) % 7;
	const calStart = addDays(addDays(today, -dow(today)), -25 * 7);
	const perDay = new Map<string, number>();
	for (const m of scopedMeetings) if (m.day >= calStart) perDay.set(m.day, (perDay.get(m.day) ?? 0) + 1);
	const meetingDays: { date: string; count: number }[] = [];
	for (let d = calStart; d <= today; d = addDays(d, 1)) meetingDays.push({ date: d, count: perDay.get(d) ?? 0 });

	// Exits by department and month, for the biggest departments.
	const deptsByHeadcount = [...new Set(people.map((p) => p.department))]
		.map((name) => ({ name, size: people.filter((p) => p.department === name && (!p.exited || p.exited >= from)).length }))
		.sort((a, b) => b.size - a.size)
		.slice(0, 8);
	const attrition = deptsByHeadcount.map((d) => {
		const members = people.filter((p) => p.department === d.name);
		const series = headcountSeries(members, months);
		return { name: d.name, cells: series.map((s) => ({ exits: s.exits, rate: s.turnover })) };
	});

	const meetingsBy = new Map<string, number>();
	for (const m of scopedMeetings) for (const p of m.people) meetingsBy.set(p, (meetingsBy.get(p) ?? 0) + 1);
	const workload = active
		.map((p) => {
			const mine = assigned.filter((t) => t.assigneeId === p.id);
			return {
				id: p.id,
				name: p.fullName,
				group: p.department,
				open: mine.filter((t) => t.status !== 'done').length,
				overdue: mine.filter((t) => t.status !== 'done' && t.dueDate && dateKey(t.dueDate) < today).length,
				done: mine.filter((t) => {
					const d = doneKey(t);
					return t.status === 'done' && d !== null && d >= from;
				}).length,
				meetings: meetingsBy.get(p.id) ?? 0
			};
		})
		.filter((w) => w.open + w.done + w.meetings > 0)
		.sort((a, b) => b.open - a.open || b.meetings - a.meetings || a.name.localeCompare(b.name))
		.slice(0, 5);

	// ---------- headline figures ----------
	const hires = headcount.reduce((s, h) => s + h.hires, 0);
	const exits = headcount.reduce((s, h) => s + h.exits, 0);
	const lastWith = <T>(list: T[], pick: (x: T) => number | null) => {
		for (let i = list.length - 1; i >= 0; i--) {
			const v = pick(list[i]);
			if (v !== null) return { value: v, label: (list[i] as { label: string }).label };
		}
		return null;
	};

	return {
		today,
		months: opts.months,
		from,
		to,
		departments: departmentNames,
		department,
		totals: {
			active: active.length,
			hires,
			exits,
			engagement: lastWith(engagement, (e) => e.score),
			unplanned: lastWith(absence, (a) => a.unplanned),
			medianAge: ages.length ? ages[Math.floor(ages.length / 2)] : null
		},
		headcount,
		engagement,
		absence,
		gender: {
			overall: genderOrder.map((g) => ({ name: g, count: genderTotals.get(g) ?? 0 })),
			byGroup: [...genderByDept]
				.map(([name, counts]) => ({ name, counts: Object.fromEntries(genderOrder.map((g) => [g, counts.get(g) ?? 0])) as Record<GenderLabel, number>, total: [...counts.values()].reduce((s, n) => s + n, 0) }))
				.sort((a, b) => b.total - a.total)
				.slice(0, 8)
		},
		age: { bands: AGE_BANDS.map((b) => ({ name: b, count: ageCounts.get(b) ?? 0 })), known: ages.length, unknown: active.length - ages.length, pyramid, pyramidOther },
		leaveByType,
		meetingDays,
		attrition,
		groups: {
			department: countBy((p) => p.department),
			team: countBy((p) => p.teamName),
			designation: countBy((p) => p.designation),
			shift: countBy((p) => p.shiftName)
		},
		work,
		status,
		workload
	};
}

export type HrAnalytics = Awaited<ReturnType<typeof loadHrAnalytics>>;

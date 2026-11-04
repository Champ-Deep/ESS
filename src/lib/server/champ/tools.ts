import { db } from '$lib/server/db/postgres';
import {
	attendance,
	attendanceDeviations,
	tasks,
	compOffCredits,
	customRoles,
	employeeProfiles,
	holidayCalendars,
	holidays,
	leaveAllocations,
	leaveApplications,
	leaveTypes,
	shiftGroups,
	teams,
	users
} from '$lib/server/db/schema';
import { and, desc, eq, gte, ilike, inArray, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm';
import type { SessionUser, Role } from '$lib/server/auth';
import { hasCap } from '$lib/server/capabilities';
import { ensureLeaveAllocations } from '$lib/server/leave-accrual';
import { reviewableUserIds } from '$lib/server/approval-chain';
import { loadFeed } from '$lib/server/announcements';
import { getMongo } from '$lib/server/db/mongo';
import { workStatuses } from '$lib/server/chat/presence';
import { CAPABILITIES, BASE_ROLE_LABEL, GRANTABLE_KEYS, effectiveCapabilities } from '$lib/capabilities';
import { CHIEF_PICK, MAM_PICK, topLabel, topPositionReference } from '$lib/chief';
import { summaryOf } from '$lib/announcements';
import { istDateKey, parseDay } from '$lib/chat/rules';
import type { ChampCard, ChampReport } from '$lib/champ';
import { notHidden } from '$lib/server/hidden-users';

/**
 * Champ's tools for ESS. Each one reads with the asker's own reach: a tool the
 * asker's role and privileges do not allow is not offered to the model at all,
 * and the ones that are offered filter to what the asker may see.
 *
 * In a channel ("@Champ" where everyone can read the answer) only the tools
 * that are safe to answer in public are offered: holidays, policy,
 * announcements, and the asker's own records.
 *
 * Draft tools return cards, never changes. Aadhaar, PAN, bank details, salary
 * and passwords are never read here, so they cannot reach the model.
 */

export type Caller = { user: SessionUser; mode: 'panel' | 'channel' };

export type ToolResult = { data: unknown; report?: ChampReport; cards?: ChampCard[] };

type Tool = {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	allowed: (c: Caller) => boolean;
	/** Safe to answer where a whole channel can read it. */
	public?: boolean;
	run: (args: Record<string, unknown>, c: Caller) => Promise<ToolResult>;
};

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties: props, required });
const S = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra });

let cardSeq = 0;
const cardId = () => `c${Date.now().toString(36)}${(cardSeq++).toString(36)}`;

const fmt = (d: string) =>
	new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

const isHrLike = (c: Caller) => hasCap(c.user, 'champ.reports');

async function profileOf(userId: string) {
	const [p] = await db
		.select({
			id: users.id,
			fullName: users.fullName,
			role: users.role,
			teamId: users.teamId,
			reportsTo: users.reportsTo,
			shiftGroupId: employeeProfiles.shiftGroupId,
			hrUserId: employeeProfiles.hrUserId,
			reportsToChief: employeeProfiles.reportsToChief,
			topPosition: employeeProfiles.topPosition,
			officeTimings: employeeProfiles.officeTimings
		})
		.from(users)
		.leftJoin(employeeProfiles, eq(employeeProfiles.userId, users.id))
		.where(eq(users.id, userId))
		.limit(1);
	return p;
}

/**
 * Finds one person by email or name within `scope` (ids the asker may act on;
 * undefined = everyone active). Several matches come back as a list so Champ
 * asks which one instead of guessing.
 */
async function findPerson(query: string, scope?: string[]) {
	const q = query.trim();
	if (!q) return { person: null, matches: [] as { id: string; fullName: string; email: string }[] };
	const rows = await db
		.select({ id: users.id, fullName: users.fullName, email: users.email })
		.from(users)
		.where(and(eq(users.isActive, true), notHidden, or(eq(sql`lower(${users.email})`, q.toLowerCase()), ilike(users.fullName, `%${q.replace(/[%_]/g, '')}%`))))
		.limit(10);
	const inScope = scope ? rows.filter((r) => scope.includes(r.id)) : rows;
	const exact = inScope.filter((r) => r.email.toLowerCase() === q.toLowerCase() || r.fullName.toLowerCase() === q.toLowerCase());
	const pick = exact.length === 1 ? exact : inScope;
	return { person: pick.length === 1 ? pick[0] : null, matches: pick };
}

function ambiguous(what: string, matches: { fullName: string; email: string }[]) {
	return {
		data: matches.length
			? { needs_clarification: `More than one ${what} matches. Ask which one.`, matches: matches.map((m) => `${m.fullName} (${m.email})`) }
			: { not_found: `No ${what} by that name is in your reach.` }
	};
}

/* ======================= self-service ======================= */

const myLeave: Tool = {
	name: 'my_leave',
	description: "The asker's own leave balances for this year and their recent leave requests.",
	parameters: obj({}),
	allowed: () => true,
	public: true,
	run: async (_a, c) => {
		const year = new Date().getFullYear();
		await ensureLeaveAllocations([c.user.id]);
		const [bal, apps] = await Promise.all([
			db
				.select({ name: leaveTypes.name, code: leaveTypes.code, allocated: leaveAllocations.allocatedDays, used: leaveAllocations.usedDays })
				.from(leaveAllocations)
				.innerJoin(leaveTypes, eq(leaveTypes.id, leaveAllocations.leaveTypeId))
				.where(and(eq(leaveAllocations.userId, c.user.id), eq(leaveAllocations.year, year), eq(leaveTypes.isActive, true))),
			db
				.select({ type: leaveTypes.name, start: leaveApplications.startDate, end: leaveApplications.endDate, days: leaveApplications.days, status: leaveApplications.status })
				.from(leaveApplications)
				.innerJoin(leaveTypes, eq(leaveTypes.id, leaveApplications.leaveTypeId))
				.where(eq(leaveApplications.userId, c.user.id))
				.orderBy(desc(leaveApplications.createdAt))
				.limit(10)
		]);
		return {
			data: {
				year,
				balances: bal.map((b) => ({ type: b.name, code: b.code, left: Number(b.allocated) - Number(b.used), of: Number(b.allocated) })),
				recent_requests: apps.map((a) => ({ type: a.type, from: a.start, to: a.end, days: Number(a.days), status: a.status }))
			}
		};
	}
};

const myAttendance: Tool = {
	name: 'my_attendance',
	description: "The asker's own attendance for a month: days recorded, first and last punch, and their correction requests. Month defaults to this month.",
	parameters: obj({ month: S('YYYY-MM') }),
	allowed: () => true,
	public: true,
	run: async (a, c) => {
		const month = /^\d{4}-\d{2}$/.test(str(a.month)) ? str(a.month) : istDateKey(new Date()).slice(0, 7);
		const [rows, devs, profile] = await Promise.all([
			db
				.select({ date: attendance.date, inAt: attendance.checkInAt, outAt: attendance.checkOutAt, source: attendance.source })
				.from(attendance)
				.where(and(eq(attendance.userId, c.user.id), gte(attendance.date, `${month}-01`), lte(attendance.date, `${month}-31`)))
				.orderBy(attendance.date),
			db
				.select({ date: attendanceDeviations.date, reason: attendanceDeviations.reason, status: attendanceDeviations.status })
				.from(attendanceDeviations)
				.where(and(eq(attendanceDeviations.userId, c.user.id), eq(attendanceDeviations.monthKey, month))),
			profileOf(c.user.id)
		]);
		const t = (d: Date | null) => (d ? new Date(d).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }) : null);
		return {
			data: {
				month,
				office_timings: profile?.officeTimings ?? 'not set',
				days_recorded: rows.length,
				days: rows.map((r) => ({ date: r.date, first_in: t(r.inAt), last_out: t(r.outAt), source: r.source })),
				correction_requests: devs.map((d) => ({ date: d.date, reason: d.reason, status: d.status }))
			}
		};
	}
};

const holidaysTool: Tool = {
	name: 'holidays',
	description: "Upcoming holidays from the published calendar for the asker's own shift group.",
	parameters: obj({ count: { type: 'number', description: 'How many, default 5' } }),
	allowed: () => true,
	public: true,
	run: async (a, c) => {
		const p = await profileOf(c.user.id);
		if (!p?.shiftGroupId) return { data: { note: 'No shift group is set for you, so no holiday calendar applies. HR can set it.' } };
		const today = istDateKey(new Date());
		const rows = await db
			.select({ date: holidays.date, name: holidays.name, type: holidays.type, shift: shiftGroups.name })
			.from(holidays)
			.innerJoin(holidayCalendars, eq(holidayCalendars.id, holidays.calendarId))
			.innerJoin(shiftGroups, eq(shiftGroups.id, holidayCalendars.shiftGroupId))
			.where(and(eq(holidayCalendars.shiftGroupId, p.shiftGroupId), eq(holidayCalendars.status, 'published'), gte(holidays.date, today)))
			.orderBy(holidays.date)
			.limit(Math.min(Number(a.count) || 5, 15));
		return { data: { shift_group: rows[0]?.shift ?? null, holidays: rows.map((r) => ({ date: r.date, day: fmt(r.date), name: r.name, type: r.type })) } };
	}
};

const leavePolicy: Tool = {
	name: 'leave_policy',
	description: 'The published leave types: how each accrues, fixed days, carry-forward cap and notes.',
	parameters: obj({}),
	allowed: () => true,
	public: true,
	run: async () => {
		const rows = await db.select().from(leaveTypes).where(eq(leaveTypes.isActive, true));
		return {
			data: rows.map((t) => ({
				name: t.name,
				code: t.code,
				accrual_per_month: Number(t.accrualPerMonth),
				fixed_days: t.fixedDays,
				carry_forward_cap_days: t.carryForwardCap,
				monthly_quota_days: t.monthlyQuotaDays ?? null,
				eligibility: t.eligibility ?? null,
				documentation_note: t.documentationNote ?? null,
				notes: t.notes ?? null
			}))
		};
	}
};

const myPeople: Tool = {
	name: 'my_people',
	description: "Who the asker reports to (a person, or Chief or Mam), their concerned HR, and their team.",
	parameters: obj({}),
	allowed: () => true,
	public: true,
	run: async (_a, c) => {
		const p = await profileOf(c.user.id);
		if (!p) return { data: {} };
		const ids = [p.reportsTo, p.hrUserId].filter(Boolean) as string[];
		const names = ids.length ? await db.select({ id: users.id, fullName: users.fullName }).from(users).where(inArray(users.id, ids)) : [];
		const byId = new Map(names.map((n) => [n.id, n.fullName]));
		const [team] = p.teamId ? await db.select({ name: teams.name }).from(teams).where(eq(teams.id, p.teamId)).limit(1) : [];
		return {
			data: {
				reports_to: p.reportsTo ? byId.get(p.reportsTo) : p.reportsToChief ? `${topLabel(p.topPosition)} (your requests go straight to your concerned HR)` : 'not set',
				concerned_hr: p.hrUserId ? byId.get(p.hrUserId) : 'not set, so any HR admin picks up your requests',
				team: team?.name ?? 'none'
			}
		};
	}
};

const announcementsTool: Tool = {
	name: 'announcements',
	description: 'Live announcements meant for the asker: what needs them, what is coming up, recent updates.',
	parameters: obj({}),
	allowed: () => true,
	public: true,
	run: async (_a, c) => {
		const feed = await loadFeed(c.user.id);
		const line = (p: { title: string; summary: string | null; body: string }) => `${p.title}: ${summaryOf(p)}`;
		return {
			data: {
				needs_you: feed.needsYou.map(line),
				coming_up: feed.comingUp.slice(0, 8).map((i) => `${i.eventDate} ${i.title}`),
				updates: feed.updates.slice(0, 5).map(line)
			}
		};
	}
};

/* ======================= drafts for yourself ======================= */

const draftLeave: Tool = {
	name: 'draft_leave',
	description: 'Draft a leave request for the asker. Returns a card; the asker presses Submit. Call leave_policy first if the type is unclear.',
	parameters: obj(
		{
			type: S('Leave type name or code, e.g. "Casual Leave" or "CL"'),
			start: S('First day: YYYY-MM-DD, or words like "Fri", "12 Oct", "tomorrow"'),
			end: S('Last day, same formats. Defaults to the first day.'),
			reason: S('Reason in the asker’s words')
		},
		['type', 'start']
	),
	allowed: (c) => c.mode === 'panel',
	run: async (a, c) => {
		const now = new Date();
		const start = parseDay(str(a.start), now) ?? (/^\d{4}-\d{2}-\d{2}$/.test(str(a.start)) ? str(a.start) : null);
		const end = str(a.end) ? (parseDay(str(a.end), now) ?? str(a.end)) : start;
		if (!start || !end || end < start) return { data: { error: 'I could not read those dates. Ask for the first and last day.' } };
		const t = str(a.type).toLowerCase();
		const types = await db.select().from(leaveTypes).where(eq(leaveTypes.isActive, true));
		const type = types.find((x) => x.code?.toLowerCase() === t || x.name.toLowerCase() === t) ?? types.find((x) => x.name.toLowerCase().includes(t));
		if (!type) return { data: { error: 'No leave type matches.', available: types.map((x) => `${x.name}${x.code ? ` (${x.code})` : ''}`) } };
		const card: ChampCard = {
			id: cardId(),
			kind: 'leave_request',
			label: 'Leave request · not sent yet',
			title: `${type.name} · ${start === end ? fmt(start) : `${fmt(start)} to ${fmt(end)}`}`,
			lines: [str(a.reason) ? `Reason: "${str(a.reason)}"` : 'No reason given', 'Goes to your manager, then HR. The portal checks your balance when you submit.'],
			payload: { leaveTypeId: type.id, startDate: start, endDate: end, reason: str(a.reason) },
			buttons: [{ action: 'submit', label: 'Submit request', primary: true }],
			doneText: 'Submitted · waiting on your manager'
		};
		return { data: { drafted: card.title, note: 'Tell the asker to press Submit on the card.' }, cards: [card] };
	}
};

const REASONS = ['login_not_captured', 'logout_not_captured', 'missing_biometric_punch', 'biometric_system_mismatch', 'prohance_mismatch', 'system_server_issue', 'machine_malfunction', 'technical_error', 'wrong_half_day', 'wrong_absent'];

const draftCorrection: Tool = {
	name: 'draft_correction',
	description: 'Draft an attendance correction for a past day. Returns a card; the asker presses Submit.',
	parameters: obj(
		{
			date: S('YYYY-MM-DD, not in the future'),
			check_in: S('HH:MM, 24-hour, optional'),
			check_out: S('HH:MM, 24-hour, optional'),
			reason: S('One of: ' + REASONS.join(', ')),
			description: S('What happened, at least 10 characters')
		},
		['date', 'reason', 'description']
	),
	allowed: (c) => c.mode === 'panel',
	run: async (a) => {
		const date = str(a.date);
		if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > istDateKey(new Date())) return { data: { error: 'Corrections are for a past day in YYYY-MM-DD.' } };
		const reason = REASONS.includes(str(a.reason)) ? str(a.reason) : 'missing_biometric_punch';
		const desc = str(a.description);
		const card: ChampCard = {
			id: cardId(),
			kind: 'correction',
			label: 'Attendance correction · not sent yet',
			title: `${fmt(date)}${str(a.check_in) ? ` · in ${str(a.check_in)}` : ''}${str(a.check_out) ? ` · out ${str(a.check_out)}` : ''}`,
			lines: [`Reason: ${reason.replace(/_/g, ' ')}`, `"${desc}"`],
			payload: { date, reason, description: desc, claimedCheckIn: str(a.check_in) || null, claimedCheckOut: str(a.check_out) || null },
			buttons: [{ action: 'submit', label: 'Submit correction', primary: true }],
			doneText: 'Submitted · waiting on your manager'
		};
		return { data: { drafted: card.title }, cards: [card] };
	}
};

const draftCompOff: Tool = {
	name: 'draft_comp_off',
	description: 'Draft a comp-off claim for a day the asker worked on a holiday or week off. Returns a card.',
	parameters: obj({ worked_date: S('YYYY-MM-DD'), note: S('What was worked') }, ['worked_date']),
	allowed: (c) => c.mode === 'panel',
	run: async (a) => {
		const d = str(a.worked_date);
		if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return { data: { error: 'Give the worked date as YYYY-MM-DD.' } };
		const card: ChampCard = {
			id: cardId(),
			kind: 'comp_off',
			label: 'Comp-off claim · not sent yet',
			title: `Worked ${fmt(d)}`,
			lines: [str(a.note) ? `"${str(a.note)}"` : 'No note', 'The portal checks the day was a holiday or week off when you submit.'],
			payload: { workedDate: d, note: str(a.note) },
			buttons: [{ action: 'submit', label: 'Submit claim', primary: true }],
			doneText: 'Submitted · waiting on your manager'
		};
		return { data: { drafted: card.title }, cards: [card] };
	}
};

const myRequests: Tool = {
	name: 'my_requests',
	description: 'Tasks given to the asker and tasks the asker handed out, with their status.',
	parameters: obj({}),
	allowed: (c) => c.mode === 'panel',
	run: async (_a, c) => {
		const rows = await db
			.select({ t: tasks, from: users.fullName })
			.from(tasks)
			.innerJoin(users, eq(users.id, tasks.createdBy))
			.where(or(eq(tasks.assigneeId, c.user.id), eq(tasks.createdBy, c.user.id)))
			.orderBy(desc(tasks.createdAt))
			.limit(30);
		return {
			data: rows.map(({ t, from }) => ({
				direction: t.assigneeId === c.user.id ? 'given to you' : 'raised by you',
				from,
				title: t.title,
				due: t.dueDate,
				status: t.requestState === 'pending' ? "waiting for their lead's approval" : t.requestState === 'declined' ? 'declined' : t.status.replace('_', ' '),
				blocked: t.blocked,
				note: t.requestNote
			})),
			note: 'Champ Hub shows these on the task board, with buttons.'
		} as ToolResult;
	}
};

/* ======================= teams and approvals ======================= */

async function teamScope(c: Caller, teamName?: string): Promise<{ ids: string[]; label: string } | null> {
	if (isHrLike(c) && teamName) {
		const [t] = await db.select({ id: teams.id, name: teams.name }).from(teams).where(ilike(teams.name, `%${teamName.replace(/[%_]/g, '')}%`)).limit(1);
		if (!t) return null;
		const ids = await db.select({ id: users.id }).from(users).where(and(eq(users.teamId, t.id), eq(users.isActive, true), notHidden));
		return { ids: ids.map((i) => i.id), label: t.name };
	}
	if (!c.user.teamId) return null;
	const ids = await db.select({ id: users.id }).from(users).where(and(eq(users.teamId, c.user.teamId), eq(users.isActive, true), notHidden));
	const [t] = await db.select({ name: teams.name }).from(teams).where(eq(teams.id, c.user.teamId)).limit(1);
	return { ids: ids.map((i) => i.id), label: t?.name ?? 'your team' };
}

const teamStatus: Tool = {
	name: 'team_status',
	description: 'Who in a team is in, on leave, on week off or not in yet today, plus approved leave in the next 14 days. Team Leads see their own team; HR can name a team.',
	parameters: obj({ team: S('Team name, HR only. Omit for your own team.') }),
	allowed: (c) => c.mode === 'panel' && (c.user.role === 'team_lead' || isHrLike(c)),
	run: async (a, c) => {
		const scope = await teamScope(c, str(a.team) || undefined);
		if (!scope) return { data: { error: str(a.team) ? 'No team by that name.' : 'You are not on a team.' } };
		const today = istDateKey(new Date());
		const soon = new Date(Date.parse(today) + 14 * 86_400_000).toISOString().slice(0, 10);
		const [people, work, leave] = await Promise.all([
			scope.ids.length ? db.select({ id: users.id, fullName: users.fullName }).from(users).where(inArray(users.id, scope.ids)) : [],
			workStatuses(),
			scope.ids.length
				? db
						.select({ userId: leaveApplications.userId, start: leaveApplications.startDate, end: leaveApplications.endDate, type: leaveTypes.name })
						.from(leaveApplications)
						.innerJoin(leaveTypes, eq(leaveTypes.id, leaveApplications.leaveTypeId))
						.where(and(inArray(leaveApplications.userId, scope.ids), eq(leaveApplications.status, 'approved'), lte(leaveApplications.startDate, soon), gte(leaveApplications.endDate, today)))
				: []
		]);
		const name = new Map(people.map((p) => [p.id, p.fullName]));
		return {
			data: {
				team: scope.label,
				today: people.map((p) => ({ name: p.fullName, status: work.get(p.id)?.label ?? 'unknown' })),
				leave_next_14_days: leave.map((l) => ({ name: name.get(l.userId), type: l.type, from: l.start, to: l.end }))
			}
		};
	}
};

const pendingApprovals: Tool = {
	name: 'pending_approvals',
	description: 'Leave requests, attendance corrections and comp-off claims waiting on the asker, as cards with Approve and Reject.',
	parameters: obj({}),
	allowed: (c) => c.mode === 'panel',
	run: async (_a, c) => {
		const [mgr, hr] = await Promise.all([reviewableUserIds(c.user, 'manager'), reviewableUserIds(c.user, 'hr')]);
		const cards: ChampCard[] = [];
		const nameRows = [...new Set([...mgr, ...hr])];
		const names = nameRows.length ? new Map((await db.select({ id: users.id, n: users.fullName }).from(users).where(inArray(users.id, nameRows))).map((r) => [r.id, r.n])) : new Map();
		const add = (kind: 'leave' | 'deviation' | 'comp_off', id: string, who: string, title: string, lines: string[]) =>
			cards.push({
				id: cardId(),
				kind: 'approve',
				label: `${kind === 'leave' ? 'Leave request' : kind === 'deviation' ? 'Attendance correction' : 'Comp-off claim'} · waiting on you`,
				title: `${who} · ${title}`,
				lines,
				payload: { requestKind: kind, id },
				buttons: [
					{ action: 'approve', label: 'Approve', primary: true },
					{ action: 'reject', label: 'Reject' }
				],
				doneText: 'Decided'
			});
		const cond = (col: typeof leaveApplications.userId | typeof attendanceDeviations.userId | typeof compOffCredits.userId, ids: string[]) => (ids.length ? inArray(col, ids) : sql`false`);
		const [leaves, devs, cos] = await Promise.all([
			db
				.select({ a: leaveApplications, t: leaveTypes.name })
				.from(leaveApplications)
				.innerJoin(leaveTypes, eq(leaveTypes.id, leaveApplications.leaveTypeId))
				.where(or(and(eq(leaveApplications.status, 'pending'), cond(leaveApplications.userId, mgr)), and(eq(leaveApplications.status, 'escalated'), cond(leaveApplications.userId, hr))))
				.limit(20),
			db
				.select()
				.from(attendanceDeviations)
				.where(or(and(inArray(attendanceDeviations.status, ['pending', 'needs_manager_approval']), cond(attendanceDeviations.userId, mgr)), and(eq(attendanceDeviations.status, 'manager_approved'), cond(attendanceDeviations.userId, hr))))
				.limit(20),
			db
				.select()
				.from(compOffCredits)
				.where(or(and(eq(compOffCredits.status, 'pending'), cond(compOffCredits.userId, mgr)), and(eq(compOffCredits.status, 'manager_approved'), cond(compOffCredits.userId, hr))))
				.limit(20)
		]);
		for (const { a, t } of leaves) add('leave', a.id, names.get(a.userId) ?? '?', `${t} · ${a.startDate === a.endDate ? fmt(a.startDate) : `${fmt(a.startDate)} to ${fmt(a.endDate)}`}`, [a.reason ? `Reason: "${a.reason}"` : 'No reason given', a.status === 'escalated' ? 'Manager has signed off' : '']);
		for (const d of devs) add('deviation', d.id, names.get(d.userId) ?? '?', `Correction · ${fmt(d.date)}`, [`"${d.description}"`]);
		for (const x of cos) add('comp_off', x.id, names.get(x.userId) ?? '?', `Comp-off · worked ${fmt(x.workedDate)}`, [x.note ? `"${x.note}"` : '']);
		for (const cd of cards) cd.lines = cd.lines.filter(Boolean);
		return { data: { waiting: cards.length, items: cards.map((cd) => cd.title) }, cards };
	}
};

const draftTask: Tool = {
	name: 'draft_task',
	description: "Draft a task for anyone, including the asker. Unless the asker leads that person, the person's lead approves it before it starts. Returns a card with Assign.",
	parameters: obj({ to: S('Name or email of the teammate'), title: S('What needs doing'), due: S('Due day, e.g. "tomorrow", "Fri", YYYY-MM-DD. Optional.') }, ['to', 'title']),
	allowed: (c) => c.mode === 'panel',
	run: async (a) => {
		const { person, matches } = await findPerson(str(a.to), undefined);
		if (!person) return ambiguous('teammate', matches);
		const due = str(a.due) ? parseDay(str(a.due), new Date()) : null;
		const card: ChampCard = {
			id: cardId(),
			kind: 'task',
			label: 'Task · not assigned yet',
			title: `For ${person.fullName}: ${str(a.title)}`,
			lines: [due ? `Due ${fmt(due)}` : 'No due date', 'Goes on their Champ Hub board. Unless you lead them, their lead approves it first.'],
			payload: { toUserId: person.id, title: str(a.title).slice(0, 300), due },
			buttons: [{ action: 'assign', label: 'Assign task', primary: true }],
			doneText: `Assigned to ${person.fullName}`
		};
		return { data: { drafted: card.title }, cards: [card] };
	}
};

/* ======================= HR: counts, reports, audit ======================= */

const peopleSearch: Tool = {
	name: 'people_search',
	description:
		'Counts and lists across the roster. filter: no_manager, no_hr, no_shift, temp_password (never signed in), reports_to_chief, reports_to_mam, joined_since (value: YYYY-MM-DD), team (value: name), role (value: employee|team_lead|admin|super_admin), named_role (value: role name).',
	parameters: obj({ filter: S('One of the filters above'), value: S('For joined_since, team, role or named_role') }, ['filter']),
	allowed: (c) => c.mode === 'panel' && isHrLike(c),
	run: async (a) => {
		const f = str(a.filter);
		const v = str(a.value);
		const base = db
			.select({ id: users.id, fullName: users.fullName, email: users.email, team: teams.name, doj: employeeProfiles.dateOfJoining })
			.from(users)
			.leftJoin(employeeProfiles, eq(employeeProfiles.userId, users.id))
			.leftJoin(teams, eq(teams.id, users.teamId));
		const active = and(eq(users.isActive, true), notHidden);
		let where;
		if (f === 'no_manager') where = and(active, isNull(users.reportsTo), or(isNull(employeeProfiles.reportsToChief), eq(employeeProfiles.reportsToChief, false)), sql`${users.role} <> 'super_admin'`);
		else if (f === 'no_hr') where = and(active, isNull(employeeProfiles.hrUserId));
		else if (f === 'no_shift') where = and(active, isNull(employeeProfiles.shiftGroupId));
		else if (f === 'temp_password') where = and(active, eq(users.mustChangePassword, true), isNotNull(users.temporaryPassword));
		else if (f === 'reports_to_chief') where = and(active, eq(employeeProfiles.reportsToChief, true), isNull(users.reportsTo), ne(employeeProfiles.topPosition, 'mam'));
		else if (f === 'reports_to_mam') where = and(active, eq(employeeProfiles.reportsToChief, true), isNull(users.reportsTo), eq(employeeProfiles.topPosition, 'mam'));
		else if (f === 'joined_since' && /^\d{4}-\d{2}-\d{2}$/.test(v)) where = and(active, gte(employeeProfiles.dateOfJoining, v));
		else if (f === 'team') where = and(active, ilike(teams.name, `%${v.replace(/[%_]/g, '')}%`));
		else if (f === 'role' && ['employee', 'team_lead', 'admin', 'super_admin'].includes(v)) where = and(active, eq(users.role, v as Role));
		else if (f === 'named_role') {
			const [r] = await db.select({ id: customRoles.id }).from(customRoles).where(ilike(customRoles.name, v)).limit(1);
			if (!r) return { data: { error: 'No named role by that name.' } };
			where = and(active, eq(users.customRoleId, r.id));
		} else return { data: { error: 'Unknown filter or missing value.' } };
		const rows = await base.where(where).orderBy(users.fullName).limit(201);
		return {
			data: {
				count: rows.length > 200 ? 'more than 200' : rows.length,
				people: rows.slice(0, 50).map((r) => ({ name: r.fullName, email: r.email, team: r.team, date_of_joining: r.doj })),
				listed: Math.min(rows.length, 50)
			}
		};
	}
};

const REPORT_FIELDS: Record<string, { label: string; sql: ReturnType<typeof sql> }> = {
	full_name: { label: 'Full name', sql: sql`u.full_name` },
	employee_code: { label: 'Employee code', sql: sql`p.employee_code` },
	email: { label: 'Email', sql: sql`u.email` },
	team: { label: 'Team', sql: sql`t.name` },
	designation: { label: 'Designation', sql: sql`p.designation` },
	role: { label: 'Role', sql: sql`coalesce(cr.name, u.role::text)` },
	reports_to: { label: 'Reports to', sql: sql`case when p.reports_to_chief and u.reports_to is null then (case when p.top_position = 'mam' then 'Mam' else 'Chief' end) else m.full_name end` },
	concerned_hr: { label: 'Concerned HR', sql: sql`hr.full_name` },
	shift_group: { label: 'Shift group', sql: sql`sg.name` },
	office_timings: { label: 'Office timings', sql: sql`p.office_timings` },
	date_of_joining: { label: 'Date of joining', sql: sql`to_char(p.date_of_joining, 'DD/MM/YYYY')` },
	on_temp_password: { label: 'Never signed in', sql: sql`case when u.must_change_password and u.temporary_password is not null then 'yes' else 'no' end` },
	leave_left: { label: 'Leave left (all types)', sql: sql`(select coalesce(sum(la.allocated_days - la.used_days), 0)::text from leave_allocations la where la.user_id = u.id and la.year = extract(year from now())::int)` },
	el_left: { label: 'Earned leave left', sql: sql`(select coalesce(sum(la.allocated_days - la.used_days), 0)::text from leave_allocations la join leave_types lt on lt.id = la.leave_type_id where la.user_id = u.id and la.year = extract(year from now())::int and upper(lt.code) = 'EL')` },
	attendance_days_this_month: { label: 'Days in attendance this month', sql: sql`(select count(*)::text from attendance a where a.user_id = u.id and to_char(a.date, 'YYYY-MM') = to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM'))` }
};

const reportFields: Tool = {
	name: 'report_fields',
	description: 'The fields a report can contain. Call before build_report and map each heading the asker gave onto one of these keys.',
	parameters: obj({}),
	allowed: (c) => c.mode === 'panel' && isHrLike(c),
	run: async () => ({
		data: {
			fields: Object.entries(REPORT_FIELDS).map(([k, f]) => ({ key: k, label: f.label })),
			never_available: 'Aadhaar, PAN, bank details, salary and passwords are never available to reports.'
		}
	})
};

const buildReport: Tool = {
	name: 'build_report',
	description: 'Build a roster report from field keys (see report_fields), optionally for one team or role. Shown to the asker as a table with CSV download; do not repeat the rows.',
	parameters: obj(
		{
			title: S('Short title for the table'),
			fields: { type: 'array', items: { type: 'string' }, description: 'Field keys in the order asked' },
			team: S('Team name to limit to, optional'),
			role: S('employee | team_lead | admin | super_admin, optional')
		},
		['fields']
	),
	allowed: (c) => c.mode === 'panel' && isHrLike(c),
	run: async (a) => {
		const keys = (Array.isArray(a.fields) ? a.fields : []).map(String).filter((k) => k in REPORT_FIELDS).slice(0, 12);
		if (keys.length === 0) return { data: { error: 'None of those fields exist. Call report_fields.' } };
		const team = str(a.team);
		const role = str(a.role);
		const cols = sql.join(keys.map((k) => sql`${REPORT_FIELDS[k].sql} as ${sql.identifier(k)}`), sql`, `);
		const res = await db.execute(sql`
			select ${cols}
			from users u
			left join employee_profiles p on p.user_id = u.id
			left join teams t on t.id = u.team_id
			left join users m on m.id = u.reports_to
			left join users hr on hr.id = p.hr_user_id
			left join shift_groups sg on sg.id = p.shift_group_id
			left join custom_roles cr on cr.id = u.custom_role_id
			where u.is_active and u.hidden = false
				${team ? sql`and t.name ilike ${'%' + team.replace(/[%_]/g, '') + '%'}` : sql``}
				${['employee', 'team_lead', 'admin', 'super_admin'].includes(role) ? sql`and u.role = ${role}` : sql``}
			order by u.full_name
			limit 201
		`);
		const rows = res.rows as Record<string, unknown>[];
		const report: ChampReport = {
			title: str(a.title) || 'Roster report',
			columns: keys.map((k) => ({ key: k, label: REPORT_FIELDS[k].label })),
			rows: rows.slice(0, 200).map((r) => keys.map((k) => (r[k] == null ? '' : String(r[k])))),
			truncated: rows.length > 200
		};
		return { data: { rows: report.rows.length, truncated: report.truncated, note: 'The table is shown to the asker. Summarise; do not list rows.' }, report };
	}
};

const searchAudit: Tool = {
	name: 'search_audit',
	description: 'Search the activity log: who did what and when. Filter by person (name or email), an action word (e.g. "password", "role", "leave", "settings"), and days back.',
	parameters: obj({ person: S('Who did it, optional'), about: S('Whose record it was about, optional'), action: S('Action word, optional'), days: { type: 'number', description: 'Days back, default 30' } }),
	allowed: (c) => c.mode === 'panel' && hasCap(c.user, 'champ.audit'),
	run: async (a) => {
		const since = new Date(Date.now() - Math.min(Number(a.days) || 30, 365) * 86_400_000);
		const filter: Record<string, unknown> = { createdAt: { $gte: since } };
		if (str(a.person)) {
			const { person, matches } = await findPerson(str(a.person));
			if (!person) return ambiguous('person', matches);
			filter.actorUserId = person.id;
		}
		if (str(a.about)) {
			const { person, matches } = await findPerson(str(a.about));
			if (!person) return ambiguous('person', matches);
			filter.targetId = person.id;
		}
		if (str(a.action)) filter.action = { $regex: str(a.action).replace(/[^\w.]/g, ''), $options: 'i' };
		const mongo = await getMongo();
		const entries = (await mongo.collection('activity_log').find(filter).sort({ createdAt: -1 }).limit(40).toArray()) as unknown as {
			actorUserId: string;
			action: string;
			targetId?: string;
			details?: Record<string, unknown>;
			createdAt: Date;
		}[];
		const ids = [...new Set(entries.flatMap((e) => [e.actorUserId, e.targetId].filter(Boolean) as string[]))];
		const names = ids.length ? new Map((await db.select({ id: users.id, n: users.fullName }).from(users).where(inArray(users.id, ids))).map((r) => [r.id, r.n])) : new Map();
		return {
			data: entries.map((e) => ({
				when: e.createdAt.toISOString(),
				who: names.get(e.actorUserId) ?? e.actorUserId,
				action: e.action,
				about: e.targetId ? (names.get(e.targetId) ?? e.targetId) : null,
				// Details can carry changed fields; never passwords, which are not logged.
				details: e.details ? JSON.stringify(e.details).slice(0, 300) : null
			}))
		};
	}
};

/* ======================= admin drafts ======================= */

const draftSettings: Tool = {
	name: 'draft_settings_change',
	description:
		"Draft a change to someone's reporting line, concerned HR or shift group. reports_to may be a person, \"Chief\" or \"Mam\". Returns a card with Apply.",
	parameters: obj(
		{
			person: S('Name or email'),
			reports_to: S('Name/email, or "Chief", or "Mam", or "none"'),
			concerned_hr: S('Name/email, or "none"'),
			shift_group: S('Shift group name')
		},
		['person']
	),
	allowed: (c) => c.mode === 'panel' && hasCap(c.user, 'people.edit_settings'),
	run: async (a) => {
		const { person, matches } = await findPerson(str(a.person));
		if (!person) return ambiguous('person', matches);
		const body: Record<string, unknown> = {};
		const lines: string[] = [];
		const rt = str(a.reports_to);
		if (rt) {
			const top = topPositionReference(rt);
			if (top) {
				body.reportsTo = null;
				body.reportsToChief = true;
				body.topPosition = top;
				lines.push(`Reports to → ${topLabel(top)} (requests go straight to concerned HR)`);
			} else if (/^none$/i.test(rt)) {
				body.reportsTo = null;
				body.reportsToChief = false;
				lines.push('Reports to → not set');
			} else {
				const m = await findPerson(rt);
				if (!m.person) return ambiguous('manager', m.matches);
				body.reportsTo = m.person.id;
				body.reportsToChief = false;
				lines.push(`Reports to → ${m.person.fullName}`);
			}
		}
		const hr = str(a.concerned_hr);
		if (hr) {
			if (/^none$/i.test(hr)) {
				body.hrUserId = null;
				lines.push('Concerned HR → any admin');
			} else {
				const h = await findPerson(hr);
				if (!h.person) return ambiguous('HR person', h.matches);
				body.hrUserId = h.person.id;
				lines.push(`Concerned HR → ${h.person.fullName}`);
			}
		}
		const sg = str(a.shift_group);
		if (sg) {
			const [g] = await db.select().from(shiftGroups).where(ilike(shiftGroups.name, `%${sg.replace(/[%_]/g, '')}%`)).limit(1);
			if (!g) return { data: { error: 'No shift group by that name.' } };
			body.shiftGroupId = g.id;
			lines.push(`Shift group → ${g.name}`);
		}
		if (!lines.length) return { data: { error: 'Say what should change: reports to, concerned HR or shift group.' } };
		const card: ChampCard = {
			id: cardId(),
			kind: 'settings_change',
			label: 'Proposed settings change',
			title: person.fullName,
			lines,
			payload: { userId: person.id, body },
			buttons: [{ action: 'apply', label: 'Apply this change', primary: true }],
			doneText: 'Applied · recorded in the activity log'
		};
		return { data: { drafted: lines }, cards: [card] };
	}
};

const draftAnnouncement: Tool = {
	name: 'draft_announcement',
	description: 'Draft an announcement for HR to review in the #announcements composer. kind: urgent | event | update.',
	parameters: obj(
		{
			kind: S('urgent, event or update'),
			title: S('Headline'),
			summary: S('The one line employees see'),
			body: S('Details'),
			event_date: S('YYYY-MM-DD for an event'),
			event_time: S('HH:MM for an event, optional')
		},
		['kind', 'title']
	),
	allowed: (c) => c.mode === 'panel' && hasCap(c.user, 'announcements.post'),
	run: async (a) => {
		const kind = ['urgent', 'event', 'update'].includes(str(a.kind)) ? str(a.kind) : 'update';
		const card: ChampCard = {
			id: cardId(),
			kind: 'announcement_draft',
			label: `${kind === 'urgent' ? 'Urgent' : kind === 'event' ? 'Event' : 'Update'} announcement · draft`,
			title: str(a.title),
			lines: [str(a.summary) || str(a.body).slice(0, 140), kind === 'event' && str(a.event_date) ? `On ${fmt(str(a.event_date))}${str(a.event_time) ? `, ${str(a.event_time)}` : ''}` : ''].filter(Boolean),
			payload: { kind, title: str(a.title), summary: str(a.summary), body: str(a.body), eventDate: str(a.event_date), eventTime: str(a.event_time) },
			buttons: [{ action: 'open', label: 'Open in composer', primary: true }],
			doneText: 'Opened in the composer'
		};
		return { data: { drafted: card.title, note: 'HR still reviews and publishes it.' }, cards: [card] };
	}
};

/* ======================= Super Admin ======================= */

const listRoles: Tool = {
	name: 'list_roles',
	description: 'The built-in roles and the named roles (IT Support, …) with their privileges and how many people hold each.',
	parameters: obj({}),
	allowed: (c) => c.mode === 'panel' && (hasCap(c.user, 'access.view') || hasCap(c.user, 'system.roles')),
	run: async () => {
		const named = await db.select().from(customRoles);
		const counts = await db.execute(sql`select custom_role_id as id, count(*)::int as n from users where is_active and hidden = false group by custom_role_id`);
		const byId = new Map((counts.rows as { id: string | null; n: number }[]).map((r) => [r.id, r.n]));
		const label = (k: string) => CAPABILITIES.find((c) => c.key === k)?.label ?? k;
		return {
			data: {
				built_in: (['employee', 'team_lead', 'admin', 'super_admin'] as Role[]).map((r) => ({ role: BASE_ROLE_LABEL[r], privileges: effectiveCapabilities(r).map(label) })),
				named: named.map((n) => ({ name: n.name, starts_from: BASE_ROLE_LABEL[n.baseRole], extra_privileges: n.capabilities.map(label), people: byId.get(n.id) ?? 0 })),
				grantable_privileges: CAPABILITIES.filter((c) => c.grantable).map((c) => ({ key: c.key, label: c.label }))
			}
		};
	}
};

const draftRoleChange: Tool = {
	name: 'draft_role_change',
	description: "Draft a change to someone's role: a built-in role (employee, team_lead, admin, super_admin) or a named role such as IT Support. Returns a card.",
	parameters: obj({ person: S('Name or email'), role: S('Built-in role key, or the name of a named role, or "none" to remove a named role') }, ['person', 'role']),
	allowed: (c) => c.mode === 'panel' && hasCap(c.user, 'people.assign_roles'),
	run: async (a, c) => {
		const { person, matches } = await findPerson(str(a.person));
		if (!person) return ambiguous('person', matches);
		if (person.id === c.user.id) return { data: { error: 'Nobody can change their own role.' } };
		const r = str(a.role);
		const [target] = await db.select({ role: users.role, customRoleId: users.customRoleId }).from(users).where(eq(users.id, person.id)).limit(1);
		const builtIns: Record<string, Role> = { employee: 'employee', team_lead: 'team_lead', 'team lead': 'team_lead', admin: 'admin', 'hr admin': 'admin', super_admin: 'super_admin', 'super admin': 'super_admin' };
		let payload: Record<string, unknown>;
		let to: string;
		if (builtIns[r.toLowerCase()]) {
			const role = builtIns[r.toLowerCase()];
			payload = { userId: person.id, body: { role, customRoleId: null } };
			to = BASE_ROLE_LABEL[role];
		} else if (/^none$/i.test(r)) {
			payload = { userId: person.id, body: { customRoleId: null } };
			to = `${BASE_ROLE_LABEL[target!.role]} (named role removed)`;
		} else {
			const [named] = await db.select().from(customRoles).where(ilike(customRoles.name, r)).limit(1);
			if (!named) return { data: { error: 'No role by that name.', named_roles: (await db.select({ n: customRoles.name }).from(customRoles)).map((x) => x.n) } };
			payload = { userId: person.id, body: { customRoleId: named.id } };
			to = `${named.name} (starts as ${BASE_ROLE_LABEL[named.baseRole]})`;
		}
		const from = target?.customRoleId
			? ((await db.select({ n: customRoles.name }).from(customRoles).where(eq(customRoles.id, target.customRoleId)).limit(1))[0]?.n ?? 'named role')
			: BASE_ROLE_LABEL[target!.role];
		const card: ChampCard = {
			id: cardId(),
			kind: 'role_change',
			label: 'Proposed role change',
			title: person.fullName,
			lines: [`${from} → ${to}`, to.startsWith('Super Admin') ? 'This gives full control, including deleting data.' : ''].filter(Boolean),
			payload,
			buttons: [{ action: 'apply', label: 'Apply this change', primary: true }],
			doneText: 'Applied · recorded in the activity log'
		};
		return { data: { drafted: card.lines[0] }, cards: [card] };
	}
};

const draftCreateLogin: Tool = {
	name: 'draft_create_login',
	description: 'Draft a new login. access is a built-in role key or a named role name. Shift group is required. Returns a card with Create.',
	parameters: obj(
		{
			full_name: S('Full name'),
			email: S('Official email'),
			access: S('employee, team_lead, admin, super_admin, or a named role such as IT Support'),
			team: S('Team name, optional'),
			reports_to: S('Name/email, or "Chief" or "Mam", optional'),
			concerned_hr: S('Name/email, optional'),
			shift_group: S('Shift group name')
		},
		['full_name', 'email', 'shift_group']
	),
	allowed: (c) => c.mode === 'panel' && hasCap(c.user, 'people.create_login'),
	run: async (a) => {
		const lines: string[] = [];
		const acc = str(a.access) || 'employee';
		let access = `base:${acc}`;
		if (!['employee', 'team_lead', 'admin', 'super_admin'].includes(acc)) {
			const [named] = await db.select().from(customRoles).where(ilike(customRoles.name, acc)).limit(1);
			if (!named) return { data: { error: 'No role by that name.' } };
			access = `named:${named.id}`;
			lines.push(`Access: ${named.name} (starts as ${BASE_ROLE_LABEL[named.baseRole]})`);
		} else lines.push(`Access: ${BASE_ROLE_LABEL[acc as Role]}`);
		const [sg] = await db.select().from(shiftGroups).where(ilike(shiftGroups.name, `%${str(a.shift_group).replace(/[%_]/g, '')}%`)).limit(1);
		if (!sg) return { data: { error: 'No shift group by that name.', shift_groups: (await db.select({ n: shiftGroups.name }).from(shiftGroups)).map((x) => x.n) } };
		lines.push(`Shift group: ${sg.name}`);
		let teamId: string | null = null;
		if (str(a.team)) {
			const [t] = await db.select().from(teams).where(ilike(teams.name, `%${str(a.team).replace(/[%_]/g, '')}%`)).limit(1);
			if (!t) return { data: { error: 'No team by that name.' } };
			teamId = t.id;
			lines.push(`Team: ${t.name}`);
		}
		let reportsTo: string | null = null;
		if (str(a.reports_to)) {
			const top = topPositionReference(str(a.reports_to));
			if (top) {
				reportsTo = top === 'mam' ? MAM_PICK : CHIEF_PICK;
				lines.push(`Reports to: ${topLabel(top)}`);
			} else {
				const m = await findPerson(str(a.reports_to));
				if (!m.person) return ambiguous('manager', m.matches);
				reportsTo = m.person.id;
				lines.push(`Reports to: ${m.person.fullName}`);
			}
		}
		let hrUserId: string | null = null;
		if (str(a.concerned_hr)) {
			const h = await findPerson(str(a.concerned_hr));
			if (!h.person) return ambiguous('HR person', h.matches);
			hrUserId = h.person.id;
			lines.push(`Concerned HR: ${h.person.fullName}`);
		}
		const card: ChampCard = {
			id: cardId(),
			kind: 'create_login',
			label: 'New login · not created yet',
			title: `${str(a.full_name)} · ${str(a.email).toLowerCase()}`,
			lines: [...lines, 'A temporary password is emailed; they change it on first sign-in.'],
			payload: { fullName: str(a.full_name), email: str(a.email), access, shiftGroupId: sg.id, teamId, reportsTo, hrUserId },
			buttons: [{ action: 'create', label: 'Create login', primary: true }],
			doneText: 'Created'
		};
		return { data: { drafted: card.title }, cards: [card] };
	}
};

const draftNamedRole: Tool = {
	name: 'draft_named_role',
	description: 'Draft a new named role or change an existing one: a name, the built-in role it starts from, and privilege keys from list_roles. Returns a card.',
	parameters: obj(
		{
			name: S('Role name, e.g. IT Support'),
			starts_from: S('employee, team_lead or admin'),
			privileges: { type: 'array', items: { type: 'string' }, description: 'Privilege keys' },
			description: S('What the role is for')
		},
		['name', 'privileges']
	),
	allowed: (c) => c.mode === 'panel' && hasCap(c.user, 'system.roles'),
	run: async (a) => {
		const keys = (Array.isArray(a.privileges) ? a.privileges : []).map(String).filter((k) => (GRANTABLE_KEYS as string[]).includes(k));
		const base = ['employee', 'team_lead', 'admin'].includes(str(a.starts_from)) ? (str(a.starts_from) as Role) : 'employee';
		const [existing] = await db.select().from(customRoles).where(ilike(customRoles.name, str(a.name))).limit(1);
		const card: ChampCard = {
			id: cardId(),
			kind: 'named_role',
			label: existing ? 'Change to a named role' : 'New named role',
			title: str(a.name),
			lines: [`Starts from ${BASE_ROLE_LABEL[base]}`, keys.length ? `Adds: ${keys.map((k) => CAPABILITIES.find((c) => c.key === k)?.label ?? k).join(', ')}` : 'No extra privileges'],
			payload: { id: existing?.id ?? null, name: str(a.name), baseRole: base, capabilities: keys, description: str(a.description) },
			buttons: [{ action: 'save', label: existing ? 'Save changes' : 'Create role', primary: true }],
			doneText: 'Saved'
		};
		return { data: { drafted: card.lines }, cards: [card] };
	}
};

export const TOOLS: Tool[] = [
	myLeave,
	myAttendance,
	holidaysTool,
	leavePolicy,
	myPeople,
	announcementsTool,
	draftLeave,
	draftCorrection,
	draftCompOff,
	myRequests,
	teamStatus,
	pendingApprovals,
	draftTask,
	peopleSearch,
	reportFields,
	buildReport,
	searchAudit,
	draftSettings,
	draftAnnouncement,
	listRoles,
	draftRoleChange,
	draftCreateLogin,
	draftNamedRole
];

export function toolsFor(c: Caller): Tool[] {
	return TOOLS.filter((t) => t.allowed(c) && (c.mode === 'panel' || t.public));
}

export function toolSchemas(c: Caller) {
	return toolsFor(c).map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

export async function runTool(name: string, args: Record<string, unknown>, c: Caller): Promise<ToolResult> {
	const tool = toolsFor(c).find((t) => t.name === name);
	if (!tool) return { data: { error: `The tool ${name} is not available to this person here.` } };
	try {
		return await tool.run(args, c);
	} catch (err) {
		console.error(`[champ] tool ${name} failed:`, err);
		return { data: { error: 'That lookup failed. Say so plainly rather than guessing.' } };
	}
}

/**
 * Data for the dashboard's absence planner, new-joiner onboarding panel and
 * upcoming events. Read-only: approving or rejecting still goes through
 * /api/leave/[id]/approve, which re-checks the reporting line.
 *
 * Whose leave appears: Super Admin sees everyone, a Team Lead their own
 * team, and every other employee their own row only. Sitting in someone's
 * approval chain doesn't widen this — those requests are decided from the
 * Leave page.
 */
import { db } from '$lib/server/db/postgres';
import {
	leaveApplications,
	leaveTypes,
	users,
	employeeProfiles,
	holidayCalendars,
	holidays
} from '$lib/server/db/schema';
import { and, eq, gte, inArray, lte, or } from 'drizzle-orm';
import { getUsersWithProfilePicture } from '$lib/server/db/mongo';
import { loadWeekOffFor } from '$lib/server/week-off';
import type { SessionUser } from '$lib/server/auth';
import { leaveReach } from '$lib/server/org-scope';
import { notHidden } from '$lib/server/hidden-users';

const pad = (n: number) => String(n).padStart(2, '0');
const keyOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dateKey = (v: string | Date) => (v instanceof Date ? keyOf(v) : String(v).slice(0, 10));

/** Five calendar fills; leave types take them in a stable (name) order. */
export const PLANNER_TONES = ['blue', 'purple', 'green', 'yellow', 'pink'] as const;
export type PlannerTone = (typeof PLANNER_TONES)[number];

/** Each leave type's fill, so the grid and the My leave panel agree. */
export function toneMapFor(types: { id: string; name: string }[]) {
	return new Map(
		[...types].sort((a, b) => a.name.localeCompare(b.name)).map((t, i) => [t.id, PLANNER_TONES[i % PLANNER_TONES.length]])
	);
}

export type PlannerPerson = {
	id: string;
	fullName: string;
	designation: string | null;
	hasPicture: boolean;
	isMe: boolean;
	/** One character per day of the month: '1' = week off for this person. */
	offDays: string;
	/** Days of the month (1-based) that are holidays on this person's calendar. */
	holidays: { day: number; name: string }[];
};

export type PlannerLeave = {
	id: string;
	userId: string;
	typeName: string;
	tone: PlannerTone;
	start: string;
	end: string;
	days: number;
	status: 'approved' | 'pending';
	stage: 'Manager review' | 'HR review' | null;
	/** True when the viewer may decide it now (it is in their queue). */
	reviewable: boolean;
	/** Only sent for requests the viewer reviews, as the approval queue does. */
	reason: string | null;
};

export type OnboardingPerson = {
	id: string;
	fullName: string;
	designation: string | null;
	hasPicture: boolean;
	joined: string | null;
	steps: { label: string; done: boolean }[];
};

/** `?m=2026-10` → that month; anything else → the current month. */
export function plannerMonth(param: string | null, now = new Date()) {
	const m = param && /^(\d{4})-(0[1-9]|1[0-2])$/.exec(param);
	const year = m ? Number(m[1]) : now.getFullYear();
	const month = m ? Number(m[2]) - 1 : now.getMonth();
	const first = new Date(year, month, 1);
	const last = new Date(year, month + 1, 0);
	return { year, month, key: `${year}-${pad(month + 1)}`, start: keyOf(first), end: keyOf(last), days: last.getDate() };
}

export async function loadPlanner(
	user: SessionUser,
	reviewable: { manager: string[]; hr: string[] },
	monthParam: string | null,
	now = new Date()
) {
	const month = plannerMonth(monthParam, now);

	// --- Who is on the planner ---
	// Who is on the planner: the same reach as the Leave calendar
	// (leaveReach) — a Team Lead's team as before, plus reports in other teams,
	// people they are concerned HR for and anyone they cover by delegation.
	// Reasons stay hidden unless the viewer can decide the request (below).
	let scopeIds: string[];
	const reach = await leaveReach(user);
	if (reach.ids === null) {
		const rows = await db.select({ id: users.id }).from(users).where(eq(users.isActive, true));
		scopeIds = rows.map((r) => r.id);
	} else {
		scopeIds = [...new Set([user.id, ...reach.ids])];
	}

	const people = await db
		.select({
			id: users.id,
			fullName: users.fullName,
			createdAt: users.createdAt,
			mustChangePassword: users.mustChangePassword,
			reportsTo: users.reportsTo,
			designation: employeeProfiles.designation,
			dateOfJoining: employeeProfiles.dateOfJoining,
			shiftGroupId: employeeProfiles.shiftGroupId,
			employeeCode: employeeProfiles.employeeCode,
			reportsToChief: employeeProfiles.reportsToChief
		})
		.from(users)
		.leftJoin(employeeProfiles, eq(employeeProfiles.userId, users.id))
		.where(and(inArray(users.id, scopeIds), eq(users.isActive, true), or(notHidden, eq(users.id, user.id))));

	const ids = people.map((p) => p.id);

	// --- Leave overlapping the month (cancelled and rejected never show) ---
	const [leaveRows, types, pictures, weekOff] = await Promise.all([
		ids.length
			? db
					.select({ application: leaveApplications, typeName: leaveTypes.name, typeId: leaveTypes.id })
					.from(leaveApplications)
					.innerJoin(leaveTypes, eq(leaveApplications.leaveTypeId, leaveTypes.id))
					.where(
						and(
							inArray(leaveApplications.userId, ids),
							inArray(leaveApplications.status, ['pending', 'escalated', 'approved']),
							lte(leaveApplications.startDate, month.end),
							gte(leaveApplications.endDate, month.start)
						)
					)
			: Promise.resolve([]),
		db.select({ id: leaveTypes.id, name: leaveTypes.name }).from(leaveTypes),
		getUsersWithProfilePicture(ids),
		loadWeekOffFor(ids)
	]);

	const toneOf = toneMapFor(types);
	const manager = new Set(reviewable.manager);
	const hr = new Set(reviewable.hr);

	const leaves: PlannerLeave[] = leaveRows.map((r) => {
		const a = r.application;
		const canDecide =
			(a.status === 'pending' && manager.has(a.userId)) || (a.status === 'escalated' && hr.has(a.userId));
		return {
			id: a.id,
			userId: a.userId,
			typeName: r.typeName,
			tone: toneOf.get(r.typeId) ?? 'blue',
			start: dateKey(a.startDate),
			end: dateKey(a.endDate),
			days: Number(a.days),
			status: a.status === 'approved' ? 'approved' : 'pending',
			stage: a.status === 'approved' ? null : a.status === 'escalated' ? 'HR review' : 'Manager review',
			reviewable: canDecide,
			reason: canDecide ? a.reason : null
		};
	});

	// --- Holidays, per shift group's published calendar ---
	const groupIds = [...new Set(people.map((p) => p.shiftGroupId).filter((g): g is string => !!g))];
	const holidaysByGroup = new Map<string, { day: number; name: string }[]>();
	if (groupIds.length) {
		const rows = await db
			.select({ groupId: holidayCalendars.shiftGroupId, date: holidays.date, name: holidays.name })
			.from(holidays)
			.innerJoin(holidayCalendars, eq(holidays.calendarId, holidayCalendars.id))
			.where(
				and(
					inArray(holidayCalendars.shiftGroupId, groupIds),
					eq(holidayCalendars.status, 'published'),
					gte(holidays.date, month.start),
					lte(holidays.date, month.end)
				)
			);
		for (const r of rows) {
			if (!r.groupId) continue;
			const list = holidaysByGroup.get(r.groupId) ?? [];
			const day = Number(dateKey(r.date).slice(8, 10));
			if (!list.some((h) => h.day === day)) list.push({ day, name: r.name });
			holidaysByGroup.set(r.groupId, list);
		}
	}

	const dayKeys = Array.from({ length: month.days }, (_, i) => `${month.key}-${pad(i + 1)}`);
	const awayIds = new Set(leaves.map((l) => l.userId));

	const plannerPeople: PlannerPerson[] = people
		.map((p) => {
			const isOff = weekOff.resolverFor(p.id);
			return {
				id: p.id,
				fullName: p.fullName,
				designation: p.designation ?? null,
				hasPicture: pictures.has(p.id),
				isMe: p.id === user.id,
				offDays: dayKeys.map((k) => (isOff(k) ? '1' : '0')).join(''),
				holidays: p.shiftGroupId ? (holidaysByGroup.get(p.shiftGroupId) ?? []) : []
			};
		})
		// You first, then whoever is away this month, then everyone else.
		.sort(
			(a, b) =>
				Number(b.isMe) - Number(a.isMe) ||
				Number(awayIds.has(b.id)) - Number(awayIds.has(a.id)) ||
				a.fullName.localeCompare(b.fullName)
		);

	// --- Onboarding: people who joined in the last 90 days ---
	const since = new Date(now);
	since.setDate(since.getDate() - 90);
	const sinceKey = keyOf(since);
	const stepsFor = (p: (typeof people)[number]) => [
		{ label: 'Signed in and chose a password', done: !p.mustChangePassword },
		{ label: 'Profile photo added', done: pictures.has(p.id) },
		{ label: 'Reporting manager set', done: Boolean(p.reportsTo || p.reportsToChief) },
		{ label: 'Shift and holiday calendar assigned', done: Boolean(p.shiftGroupId) },
		{ label: 'Employee code assigned', done: Boolean(p.employeeCode) }
	];
	const joinedKey = (p: (typeof people)[number]) => (p.dateOfJoining ? dateKey(p.dateOfJoining) : keyOf(p.createdAt));
	const toOnboarding = (p: (typeof people)[number]): OnboardingPerson => ({
		id: p.id,
		fullName: p.fullName,
		designation: p.designation ?? null,
		hasPicture: pictures.has(p.id),
		joined: p.dateOfJoining ? dateKey(p.dateOfJoining) : null,
		steps: stepsFor(p)
	});

	const othersInScope = people.length > 1;
	let onboarding: OnboardingPerson[];
	let onboardingMode: 'joiners' | 'self';
	if (othersInScope) {
		onboardingMode = 'joiners';
		onboarding = people
			.filter((p) => joinedKey(p) >= sinceKey)
			.sort((a, b) => joinedKey(b).localeCompare(joinedKey(a)))
			.map(toOnboarding);
	} else {
		onboardingMode = 'self';
		const me = people.find((p) => p.id === user.id);
		onboarding = me ? [toOnboarding(me)] : [];
	}

	const usedTones = new Map<string, PlannerTone>();
	for (const l of leaves) usedTones.set(l.typeName, l.tone);

	return {
		month: { key: month.key, year: month.year, month: month.month, days: month.days },
		people: plannerPeople,
		leaves,
		legend: [...usedTones].map(([name, tone]) => ({ name, tone })).sort((a, b) => a.name.localeCompare(b.name)),
		onboarding,
		onboardingMode
	};
}

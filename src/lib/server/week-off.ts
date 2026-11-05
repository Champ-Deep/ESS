/**
 * Server-side loading of week-off rosters and their assignments.
 *
 * The pattern maths lives in $lib/week-off (pure, shared with the calendars);
 * this module only fetches the rows and answers the two questions the app asks:
 * "which roster is this person on right now?" and "is this date their day off?".
 */

import { db } from '$lib/server/db/client';
import { weekOffRosters, weekOffAssignments, users } from '$lib/server/db/schema';
import { hiddenFrom } from './hidden-users';
import { eq, or, isNull, and } from 'drizzle-orm';
import { inArray } from '$lib/server/db/sql';
import {
	makeWeekOffResolver,
	assignmentOn,
	describeRoster,
	DEFAULT_WEEKDAYS_OFF,
	type WeekOffRosterShape,
	type WeekOffAssignmentShape
} from '$lib/week-off';

function toShape(row: typeof weekOffRosters.$inferSelect): WeekOffRosterShape {
	return {
		id: row.id,
		name: row.name,
		pattern: row.pattern,
		weekdays: row.weekdays ?? null,
		rotationWeeks: row.rotationWeeks ?? null,
		rotationAnchorDate: row.rotationAnchorDate ?? null
	};
}

/** Every published roster a given actor may assign, plus their own drafts. */
export async function loadAssignableRosters(actor: {
	role: string;
	teamId: string | null;
}): Promise<(typeof weekOffRosters.$inferSelect)[]> {
	if (actor.role === 'super_admin') {
		return db.select().from(weekOffRosters).orderBy(weekOffRosters.name);
	}
	// A team manager sees org-wide rosters and rosters scoped to their own team —
	// published only, since a draft is still being authored.
	return db
		.select()
		.from(weekOffRosters)
		.where(
			and(
				eq(weekOffRosters.status, 'published'),
				or(isNull(weekOffRosters.teamId), eq(weekOffRosters.teamId, actor.teamId ?? ''))
			)
		)
		.orderBy(weekOffRosters.name);
}

/**
 * The roster resolution for a set of users: their assignment history and a
 * ready-made "is this date a week off" test per user.
 */
export async function loadWeekOffFor(userIds: string[]) {
	const empty = {
		rosters: [] as WeekOffRosterShape[],
		assignmentsByUser: new Map<string, WeekOffAssignmentShape[]>(),
		resolverFor: (_userId: string) => (dateKey: string) =>
			DEFAULT_WEEKDAYS_OFF.includes(new Date(dateKey + 'T00:00:00').getDay())
	};
	if (userIds.length === 0) return empty;

	const assignmentRows = await db
		.select()
		.from(weekOffAssignments)
		.where(inArray(weekOffAssignments.userId, userIds));
	if (assignmentRows.length === 0) return empty;

	const rosterRows = await db
		.select()
		.from(weekOffRosters)
		.where(inArray(weekOffRosters.id, [...new Set(assignmentRows.map((a) => a.rosterId))]));
	const rosters = rosterRows.map(toShape);

	const assignmentsByUser = new Map<string, WeekOffAssignmentShape[]>();
	for (const a of assignmentRows) {
		const list = assignmentsByUser.get(a.userId) ?? [];
		list.push({
			rosterId: a.rosterId,
			effectiveFrom: a.effectiveFrom,
			effectiveTo: a.effectiveTo ?? null
		});
		assignmentsByUser.set(a.userId, list);
	}

	return {
		rosters,
		assignmentsByUser,
		resolverFor: (userId: string) =>
			makeWeekOffResolver(rosters, assignmentsByUser.get(userId) ?? [])
	};
}

/** Convenience for the single-employee pages (leave, attendance). */
export async function weekOffResolverForUser(userId: string) {
	const { resolverFor } = await loadWeekOffFor([userId]);
	return resolverFor(userId);
}

/**
 * What the roster column shows: the roster in force today, or null when the
 * employee is on the Sat/Sun default.
 */
export async function currentRosterByUser(
	userIds: string[],
	onDate: string
): Promise<Map<string, { rosterId: string; name: string; summary: string }>> {
	const out = new Map<string, { rosterId: string; name: string; summary: string }>();
	if (userIds.length === 0) return out;

	const { rosters, assignmentsByUser } = await loadWeekOffFor(userIds);
	const byId = new Map(rosters.map((r) => [r.id, r]));

	for (const userId of userIds) {
		const active = assignmentOn(assignmentsByUser.get(userId) ?? [], onDate);
		const roster = active ? byId.get(active.rosterId) : null;
		if (roster) {
			out.set(userId, { rosterId: roster.id, name: roster.name, summary: describeRoster(roster) });
		}
	}
	return out;
}

/**
 * Assigns a roster from `effectiveFrom`. Any open assignment that started
 * earlier is closed the day before, so the employee always has exactly one
 * roster in force on any date without deleting their history.
 */
export async function assignRoster(params: {
	userId: string;
	rosterId: string;
	effectiveFrom: string;
	assignedBy: string;
	note?: string | null;
}) {
	const dayBefore = (key: string) => {
		const [y, m, d] = key.split('-').map(Number);
		const prev = new Date(y, m - 1, d - 1);
		return `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}-${String(
			prev.getDate()
		).padStart(2, '0')}`;
	};

	const existing = await db
		.select()
		.from(weekOffAssignments)
		.where(eq(weekOffAssignments.userId, params.userId));

	for (const a of existing) {
		// Anything still open (or running past the new start) is truncated.
		if (a.effectiveTo === null || a.effectiveTo >= params.effectiveFrom) {
			if (a.effectiveFrom >= params.effectiveFrom) {
				// Fully superseded — a future assignment being replaced before it began.
				await db.delete(weekOffAssignments).where(eq(weekOffAssignments.id, a.id));
			} else {
				await db
					.update(weekOffAssignments)
					.set({ effectiveTo: dayBefore(params.effectiveFrom) })
					.where(eq(weekOffAssignments.id, a.id));
			}
		}
	}

	const [created] = await db
		.insert(weekOffAssignments)
		.values({
			userId: params.userId,
			rosterId: params.rosterId,
			effectiveFrom: params.effectiveFrom,
			assignedBy: params.assignedBy,
			note: params.note ?? null
		})
		.returning();

	return created;
}

/** Clears a roster from `from`, returning the employee to the Sat/Sun default. */
export async function clearRoster(userId: string, from: string) {
	const dayBefore = (key: string) => {
		const [y, m, d] = key.split('-').map(Number);
		const prev = new Date(y, m - 1, d - 1);
		return `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}-${String(
			prev.getDate()
		).padStart(2, '0')}`;
	};

	const existing = await db
		.select()
		.from(weekOffAssignments)
		.where(eq(weekOffAssignments.userId, userId));

	for (const a of existing) {
		if (a.effectiveFrom >= from) {
			await db.delete(weekOffAssignments).where(eq(weekOffAssignments.id, a.id));
		} else if (a.effectiveTo === null || a.effectiveTo >= from) {
			await db
				.update(weekOffAssignments)
				.set({ effectiveTo: dayBefore(from) })
				.where(eq(weekOffAssignments.id, a.id));
		}
	}
}

/** True if `actor` may assign rosters to `targetUserId`. */
export async function canAssignTo(
	actor: { id: string; role: string; teamId: string | null },
	targetUserId: string
): Promise<boolean> {
	if (actor.role !== 'super_admin' && actor.role !== 'admin' && actor.role !== 'team_lead') return false;
	const [target] = await db
		.select({ id: users.id, teamId: users.teamId, hidden: users.hidden })
		.from(users)
		.where(eq(users.id, targetUserId))
		.limit(1);
	if (!target || hiddenFrom(actor.id, target)) return false;
	if (actor.role === 'super_admin' || actor.role === 'admin') return true;
	return Boolean(actor.teamId && target.teamId === actor.teamId);
}

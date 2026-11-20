/**
 * Who reviews whose request.
 *
 * Approval follows the reporting line — `users.reportsTo` — rather than role
 * alone. Before this, queues were scoped by role and team, so a Super Admin's
 * own request had no reviewer at all and simply sat pending forever.
 *
 * Two routes:
 *
 *   Comp-off      manager → credited.  One step. The manager confirms the
 *                 person actually worked the day, and that is the whole
 *                 question — there is nothing for HR to add.
 *
 *   Everything    manager → HR → approved.  Two steps. Leave and attendance
 *   else          corrections change balances and the attendance record, so HR
 *                 sees them after the manager has signed off.
 *
 * People who report to Chief or Mam (src/lib/chief.ts) have no manager to ask:
 * they head the company and have no login. Their manager stage belongs to
 * their concerned HR, so that one person approves once and it is done — it
 * never falls through to a team lead the way an unlinked manager does.
 */

import { db } from '$lib/server/db/postgres';
import { users, employeeProfiles, teams } from '$lib/server/db/schema';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { actingForManager, loadOrgScope, todayIst } from '$lib/server/org-scope';
import { activeDelegations, resolveTeamLead } from '$lib/org-scope';
import { notHidden } from '$lib/server/hidden-users';

/** Roles that act as HR for the second stage (same list as org-scope.ts). */
const HR_ROLES = ['admin', 'super_admin'] as const;

export type ApprovalStage = 'manager' | 'hr';

export interface Reviewer {
	userId: string;
	fullName: string;
	role: string;
}

/**
 * The reporting manager for each of `userIds`.
 *
 * `users.reportsTo` is the authoritative link. It is only ever populated by the
 * bulk import, so accounts created another way can have none — those fall back
 * to the team lead, and finally to HR, so a request always reaches somebody.
 */
export async function managersFor(userIds: string[]): Promise<Map<string, Reviewer | null>> {
	const out = new Map<string, Reviewer | null>();
	if (userIds.length === 0) return out;

	const staff = await db
		.select({
			id: users.id,
			reportsTo: users.reportsTo,
			teamId: users.teamId,
			reportsToChief: employeeProfiles.reportsToChief
		})
		.from(users)
		.leftJoin(employeeProfiles, eq(employeeProfiles.userId, users.id))
		.where(inArray(users.id, userIds));

	const managerIds = staff.map((s) => s.reportsTo).filter((id): id is string => Boolean(id));

	const managerRows = managerIds.length
		? await db
				.select({ id: users.id, fullName: users.fullName, role: users.role, isActive: users.isActive })
				.from(users)
				.where(and(inArray(users.id, managerIds), notHidden))
		: [];
	const managerById = new Map(managerRows.map((m) => [m.id, m]));

	// Fallbacks, cheapest first: the team's lead, then anyone in HR. "The
	// team's lead" is the one org-scope.ts uses for visibility too
	// (resolveTeamLead): the lead named on the team while active, else the
	// team's Team-Lead-role member — never an inactive account, and never a
	// different one depending on row order.
	const teamIds = [...new Set(staff.map((s) => s.teamId).filter((t): t is string => Boolean(t)))];
	const teamRows = teamIds.length ? await db.select({ id: teams.id, teamLeadId: teams.teamLeadId }).from(teams).where(inArray(teams.id, teamIds)) : [];
	const designatedIds = teamRows.map((t) => t.teamLeadId).filter((id): id is string => Boolean(id));
	const memberRows = teamIds.length
		? await db
				.select({ id: users.id, fullName: users.fullName, role: users.role, teamId: users.teamId, isActive: users.isActive })
				.from(users)
				.where(and(notHidden, designatedIds.length ? or(inArray(users.teamId, teamIds), inArray(users.id, designatedIds)) : inArray(users.teamId, teamIds)))
		: [];
	const memberById = new Map(memberRows.map((m) => [m.id, m]));
	const leadByTeam = new Map<string, (typeof memberRows)[number]>();
	for (const teamId of teamIds) {
		const designated = teamRows.find((t) => t.id === teamId)?.teamLeadId ?? null;
		const pool = memberRows.filter((m) => m.teamId === teamId || m.id === designated);
		const leadId = resolveTeamLead(designated, pool);
		const lead = leadId ? memberById.get(leadId) : undefined;
		if (lead) leadByTeam.set(teamId, lead);
	}

	for (const person of staff) {
		const direct = person.reportsTo ? managerById.get(person.reportsTo) : undefined;
		// An inactive manager cannot review anything — fall through rather than
		// routing the request into a dead account.
		if (direct?.isActive) {
			out.set(person.id, { userId: direct.id, fullName: direct.fullName, role: direct.role });
			continue;
		}

		// Reports to Chief: nobody in the portal fills the manager stage, and a
		// team lead is not a stand-in for the head of the company.
		if (!person.reportsTo && person.reportsToChief) {
			out.set(person.id, null);
			continue;
		}

		const lead = person.teamId ? leadByTeam.get(person.teamId) : undefined;
		// Never route someone's request to themselves.
		if (lead && lead.id !== person.id) {
			out.set(person.id, { userId: lead.id, fullName: lead.fullName, role: lead.role });
			continue;
		}

		out.set(person.id, null);
	}

	return out;
}

/** Convenience for a single employee. */
export async function managerFor(userId: string): Promise<Reviewer | null> {
	return (await managersFor([userId])).get(userId) ?? null;
}

/**
 * True if `actor` may act on `stage` for `requesterId`.
 *
 * An explicit assignment *routes* the request: when a reporting manager or a
 * concerned HR is named, the request is theirs and it appears in their queue
 * alone. Admins are the fallback only for people with nobody assigned, so a
 * request is never stranded — but naming someone no longer leaves every admin
 * holding a copy of it, which made one Super Admin the queue for the whole org.
 *
 * `alreadySignedOffBy` is whoever decided the earlier stage. The two stages are
 * two *people*, not just two clicks: a Super Admin who is also the reporting
 * manager passed the manager stage and then passed the HR stage on their own
 * override, closing the request and correcting the attendance without the named
 * concerned HR ever seeing it. Their override still covers a request nobody else
 * can reach — it just cannot be used to countersign their own sign-off.
 */
export async function canReviewStage(
	actor: { id: string; role: string; teamId: string | null },
	requesterId: string,
	stage: ApprovalStage,
	alreadySignedOffBy?: string | null
): Promise<boolean> {
	// Nobody signs off their own request, whatever their role.
	if (actor.id === requesterId) return false;

	// Nor rubber-stamps the stage they just decided themselves.
	if (alreadySignedOffBy && alreadySignedOffBy === actor.id) return false;

	const isHr = (HR_ROLES as readonly string[]).includes(actor.role);

	if (stage === 'hr') {
		const assigned = await assignedHrFor(requesterId);
		// Named HR owns it. A Super Admin keeps an override so a request is never
		// truly stuck if that person leaves, but ordinary admins do not see it.
		if (assigned) return assigned === actor.id || actor.role === 'super_admin';
		return isHr;
	}

	// A live delegation lets someone stand in for the manager at this stage only
	// (src/lib/org-scope.ts). Never the HR stage: that one stays with HR.
	const manager = await managerFor(requesterId);
	if (manager) {
		if (actor.role === 'super_admin') return true;
		return (await actingForManager(manager.userId)).includes(actor.id);
	}

	// Reports to Chief: the concerned HR takes the manager stage too.
	if (await reportsToChief(requesterId)) {
		const assigned = await assignedHrFor(requesterId);
		if (assigned) return assigned === actor.id || actor.role === 'super_admin';
	}

	// No manager resolvable — HR picks it up so it does not sit forever.
	return isHr;
}

/** True when `userId` reports to Chief rather than to a person in the portal. */
export async function reportsToChief(userId: string): Promise<boolean> {
	const [row] = await db
		.select({ reportsTo: users.reportsTo, reportsToChief: employeeProfiles.reportsToChief })
		.from(users)
		.leftJoin(employeeProfiles, eq(employeeProfiles.userId, users.id))
		.where(eq(users.id, userId))
		.limit(1);
	return !!row && !row.reportsTo && !!row.reportsToChief;
}

/**
 * True when the manager stage would add nothing for `requesterId`, so a single
 * approval by `actor` finishes the chain.
 *
 * The manager stage exists to put a second, closer pair of eyes on a request
 * before HR decides it. When nobody distinct fills it — no `reportsTo`, no team
 * lead — HR *is* the manager-stage fallback, and the two stages collapse onto
 * one person.
 *
 * Left as two stages, that person had to approve the same request twice: the
 * first click only moved it to `manager_approved`, so nothing was credited and
 * no attendance was corrected, and the request came straight back to them
 * labelled "awaiting HR". It read as an approval that did nothing.
 *
 * Both halves have to hold, and checking only the first is what let a manager
 * approve alone: with the reporting line empty, *any* manager-stage approver
 * collapsed the chain and the correction was written immediately, even when a
 * concerned HR was named on the profile and had never seen the request. The
 * stages only genuinely coincide when the person clicking is also the one the
 * HR stage would route to.
 */
export async function isSingleStageFor(
	actor: { id: string; role: string; teamId: string | null },
	requesterId: string
): Promise<boolean> {
	// A distinct manager exists, so the manager stage is a real, separate review.
	if ((await managerFor(requesterId)) !== null) return false;

	// Nobody fills the manager stage, so `actor` is standing in for it via the HR
	// fallback. Collapse only if the HR stage would land on this same person —
	// otherwise a second reviewer really is waiting downstream.
	return canReviewStage(actor, requesterId, 'hr');
}

/** The HR person assigned to an employee, if a Super Admin has named one. */
export async function assignedHrFor(userId: string): Promise<string | null> {
	const [row] = await db
		.select({ hrUserId: employeeProfiles.hrUserId })
		.from(employeeProfiles)
		.innerJoin(users, eq(users.id, employeeProfiles.hrUserId))
		.where(and(eq(employeeProfiles.userId, userId), notHidden))
		.limit(1);
	return row?.hrUserId ?? null;
}

/**
 * The set of user ids whose requests `actor` may review at `stage`.
 *
 * Returned as an explicit list so the queues can filter with a single `inArray`
 * instead of each one re-deriving the reporting line and drifting apart.
 */
export async function reviewableUserIds(
	actor: { id: string; role: string; teamId: string | null },
	stage: ApprovalStage
): Promise<string[]> {
	const everyone = await db.select({ id: users.id }).from(users).where(and(eq(users.isActive, true), notHidden));
	const candidateIds = everyone.map((u) => u.id).filter((id) => id !== actor.id);

	const isHr = (HR_ROLES as readonly string[]).includes(actor.role);
	const isSuperAdmin = actor.role === 'super_admin';

	if (stage === 'hr') {
		// Who each candidate's HR is, in one query rather than per-person.
		const rows = candidateIds.length
			? await db
					.select({ userId: employeeProfiles.userId, hrUserId: employeeProfiles.hrUserId })
					.from(employeeProfiles)
					.innerJoin(users, eq(users.id, employeeProfiles.hrUserId))
					.where(and(inArray(employeeProfiles.userId, candidateIds), notHidden))
			: [];
		const hrByUser = new Map(rows.map((r) => [r.userId, r.hrUserId]));

		return candidateIds.filter((id) => {
			const assigned = hrByUser.get(id) ?? null;
			// Assigned → that person's queue (Super Admin retains an override).
			if (assigned) return assigned === actor.id || isSuperAdmin;
			// Nobody named → any admin covers it.
			return isHr;
		});
	}

	const managers = await managersFor(candidateIds);

	// Managers whose manager-stage queue `actor` holds by delegation today.
	const snap = await loadOrgScope();
	const coveringFor = new Set(
		activeDelegations(snap, todayIst())
			.filter((d) => d.toId === actor.id)
			.map((d) => d.fromId)
	);

	// Chief reporters' manager stage is their concerned HR's (see canReviewStage).
	const chiefRows = candidateIds.length
		? await db
				.select({ userId: employeeProfiles.userId, hrUserId: employeeProfiles.hrUserId })
				.from(employeeProfiles)
				.innerJoin(users, eq(users.id, employeeProfiles.userId))
				.where(
					and(
						inArray(employeeProfiles.userId, candidateIds),
						eq(employeeProfiles.reportsToChief, true),
						isNull(users.reportsTo)
					)
				)
		: [];
	const chiefHr = new Map(chiefRows.map((r) => [r.userId, r.hrUserId]));

	return candidateIds.filter((id) => {
		const manager = managers.get(id);
		if (manager) return manager.userId === actor.id || coveringFor.has(manager.userId) || isSuperAdmin;
		const assigned = chiefHr.get(id);
		if (assigned) return assigned === actor.id || isSuperAdmin;
		// Unassigned reporting line — HR is the safety net.
		return isHr;
	});
}

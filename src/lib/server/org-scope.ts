import { db } from '$lib/server/db/client';
import { delegations, employeeProfiles, teams, users } from '$lib/server/db/schema';
import { eq, isNull } from 'drizzle-orm';
import type { SessionUser } from '$lib/server/auth';
import { notHidden } from './hidden-users';
import { officeToday } from '$lib/server/shifts';
import {
	actingFor,
	buildSnapshot,
	canReach,
	explain,
	scopeFor,
	wouldCreateCycle,
	type OrgSnapshot,
	type Scope,
	type ScopeDelegation,
	type ScopePermission
} from '$lib/org-scope';

/**
 * Loads the org once and answers every "on whom?" question from it
 * (src/lib/org-scope.ts). ~250 people fit in a few kilobytes, so one snapshot
 * shared by every request beats a recursive query per screen.
 *
 * Same 30-second window the capability cache uses; anything that changes a
 * reporting line, team lead, concerned HR or delegation calls
 * invalidateOrgScope() so its own author sees the change at once.
 */

const TTL_MS = 30_000;
let cached: { snap: OrgSnapshot; at: number } | null = null;

/** Today on the office calendar — delegation windows are office days. */
export function todayIst(now = new Date()): string {
	return officeToday(now);
}

const dateKey = (v: string | Date) => (v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}` : String(v).slice(0, 10));

async function loadDelegations(): Promise<ScopeDelegation[]> {
	try {
		const rows = await db
			.select({ fromId: delegations.fromId, toId: delegations.toId, startsOn: delegations.startsOn, endsOn: delegations.endsOn })
			.from(delegations)
			.where(isNull(delegations.revokedAt));
		return rows.map((r) => ({ ...r, startsOn: dateKey(r.startsOn), endsOn: dateKey(r.endsOn) }));
	} catch (err) {
		// 42P01: the delegations migration is not applied yet. Run without
		// delegations rather than take approvals down with it.
		if ((err as { code?: string; cause?: { code?: string } })?.code === '42P01' || (err as { cause?: { code?: string } })?.cause?.code === '42P01') return [];
		throw err;
	}
}

export async function loadOrgScope(): Promise<OrgSnapshot> {
	if (cached && Date.now() - cached.at < TTL_MS) return cached.snap;
	const [people, teamRows, dels] = await Promise.all([
		db
			.select({
				id: users.id,
				role: users.role,
				isActive: users.isActive,
				teamId: users.teamId,
				reportsTo: users.reportsTo,
				dottedManagerId: employeeProfiles.dottedLineManagerId,
				hrUserId: employeeProfiles.hrUserId,
				reportsToChief: employeeProfiles.reportsToChief
			})
			.from(users)
			.leftJoin(employeeProfiles, eq(employeeProfiles.userId, users.id))
			// Hidden logins are never in anyone's reach. Their own access still
			// works: a Super Admin is org-wide without a snapshot row, and a
			// missing actor just has no relations.
			.where(notHidden),
		db.select({ id: teams.id, teamLeadId: teams.teamLeadId }).from(teams),
		loadDelegations()
	]);
	const snap = buildSnapshot(
		people.map((p) => ({ ...p, dottedManagerId: p.dottedManagerId ?? null, hrUserId: p.hrUserId ?? null, reportsToChief: Boolean(p.reportsToChief) })),
		teamRows,
		dels
	);
	cached = { snap, at: Date.now() };
	return snap;
}

export function invalidateOrgScope() {
	cached = null;
}

const asActor = (user: Pick<SessionUser, 'id' | 'role' | 'capabilities'>) => ({ id: user.id, role: user.role, capabilities: user.capabilities ?? [] });

/** The people `user` may reach for `perm` today. */
export async function scopeOf(user: Pick<SessionUser, 'id' | 'role' | 'capabilities'>, perm: ScopePermission): Promise<Scope> {
	return scopeFor(await loadOrgScope(), asActor(user), perm, todayIst());
}

/**
 * Ready for Drizzle: `null` means no filter (org-wide), otherwise the id list
 * for `inArray(users.id, ids)`. Never empty — the actor is always included,
 * which keeps `inArray` valid; callers check rights on the actor separately.
 */
export async function scopeIds(user: Pick<SessionUser, 'id' | 'role' | 'capabilities'>, perm: ScopePermission): Promise<string[] | null> {
	const s = await scopeOf(user, perm);
	if (s.all) return null;
	const ids = new Set(s.ids);
	ids.add(user.id);
	return [...ids];
}

export async function userCanReach(user: Pick<SessionUser, 'id' | 'role' | 'capabilities'>, targetId: string, perm: ScopePermission): Promise<boolean> {
	return canReach(await loadOrgScope(), asActor(user), targetId, perm, todayIst());
}

export async function explainReach(user: Pick<SessionUser, 'id' | 'role' | 'capabilities'>, targetId: string, perm: ScopePermission) {
	return explain(await loadOrgScope(), asActor(user), targetId, perm, todayIst());
}

/** The manager plus anyone holding a live delegation from them. */
export async function actingForManager(managerId: string): Promise<string[]> {
	return actingFor(await loadOrgScope(), managerId, todayIst());
}

export async function reportingLoop(employeeId: string, managerId: string | null): Promise<boolean> {
	return wouldCreateCycle(await loadOrgScope(), employeeId, managerId);
}

/**
 * Whose leave `user` sees, and in how much detail — one answer for the Leave
 * calendar, the team leave API and the dashboard planner.
 *
 *  - `ids`: everyone shown (null = everyone). Their `leave.view` scope, plus —
 *    for a Team Lead — their whole team, which is what Team Leads have always
 *    seen and keep seeing.
 *  - `detail(id)`: whether the type and reason may be shown. Only where a
 *    relationship grants `leave.view` (line, effective team lead, concerned
 *    HR, HR fallback, delegate). A Team Lead who is not that team member's
 *    lead sees the dates, not the reason.
 */
export async function leaveReach(user: Pick<SessionUser, 'id' | 'role' | 'teamId' | 'capabilities'>): Promise<{
	ids: string[] | null;
	detail: (id: string) => boolean;
}> {
	const full = await scopeIds(user, 'leave.view');
	if (full === null) return { ids: null, detail: () => true };
	const detailed = new Set(full);
	const ids = new Set(full);
	if (user.role === 'team_lead' && user.teamId) {
		const snap = await loadOrgScope();
		for (const id of snap.teamMembers.get(user.teamId) ?? []) ids.add(id);
	}
	return { ids: [...ids], detail: (id) => detailed.has(id) };
}

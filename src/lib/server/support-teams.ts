import { db } from '$lib/server/db/postgres';
import { supportTeamMembers, users } from '$lib/server/db/schema';
import { and, asc, eq } from 'drizzle-orm';
import { logActivity } from '$lib/server/db/mongo';
import { hasCap, invalidateCapabilities } from '$lib/server/capabilities';
import { notHidden } from '$lib/server/hidden-users';
import { syncDeskMembers } from '$lib/server/chat/access';
import { SUPPORT_TEAM_KEYS, supportTeam, type SupportTeamKey } from '$lib/capabilities';
import { isNoLoginEmail } from '$lib/no-login';
import type { SessionUser } from '$lib/server/auth';

/**
 * The support teams' members (HR, Employee Engagement, IT). Only a Super
 * Admin changes them. Joining or leaving takes effect within the 30-second
 * privilege cache, and the team's desk threads are re-synced at once so
 * questions reach exactly the people now in the team.
 */

type Result = { ok: true; message: string } | { ok: false; message: string };

export type SupportTeamMember = { id: string; fullName: string; email: string; role: string; since: string };

export async function supportTeamRoster(): Promise<Record<SupportTeamKey, SupportTeamMember[]>> {
	const rows = await db
		.select({
			teamKey: supportTeamMembers.teamKey,
			id: users.id,
			fullName: users.fullName,
			email: users.email,
			role: users.role,
			since: supportTeamMembers.createdAt
		})
		.from(supportTeamMembers)
		.innerJoin(users, eq(users.id, supportTeamMembers.userId))
		.where(and(eq(users.isActive, true), notHidden))
		.orderBy(asc(users.fullName));
	const out = { hr: [], engagement: [], it: [] } as Record<SupportTeamKey, SupportTeamMember[]>;
	for (const r of rows) {
		if (!(SUPPORT_TEAM_KEYS as string[]).includes(r.teamKey)) continue;
		out[r.teamKey as SupportTeamKey].push({ id: r.id, fullName: r.fullName, email: r.email, role: r.role, since: r.since.toISOString() });
	}
	return out;
}

function teamKeyOf(value: string): SupportTeamKey | null {
	return (SUPPORT_TEAM_KEYS as string[]).includes(value) ? (value as SupportTeamKey) : null;
}

export async function addToSupportTeam(actor: SessionUser, teamValue: string, userIds: string[]): Promise<Result> {
	if (!hasCap(actor, 'people.assign_roles')) return { ok: false, message: 'Only a Super Admin can change who is in HR, Employee Engagement or IT' };
	const team = teamKeyOf(teamValue);
	if (!team) return { ok: false, message: 'Pick HR, Employee Engagement or IT' };
	const ids = [...new Set(userIds.filter(Boolean))];
	if (ids.length === 0) return { ok: false, message: 'Pick at least one person' };

	const people = await db
		.select({ id: users.id, fullName: users.fullName, email: users.email, isActive: users.isActive, hidden: users.hidden })
		.from(users)
		.where(and(eq(users.isActive, true), notHidden));
	const byId = new Map(people.map((p) => [p.id, p]));
	const chosen = ids.map((id) => byId.get(id)).filter((p): p is NonNullable<typeof p> => !!p);
	// Blue-collar staff have no login, so they could never answer a desk.
	const noLogin = chosen.filter((p) => isNoLoginEmail(p.email));
	const eligible = chosen.filter((p) => !isNoLoginEmail(p.email));
	if (eligible.length === 0) {
		return { ok: false, message: noLogin.length ? `${noLogin[0].fullName} has no login, so they can't answer questions` : 'That person is not an active login' };
	}

	const added = await db
		.insert(supportTeamMembers)
		.values(eligible.map((p) => ({ teamKey: team, userId: p.id, addedBy: actor.id })))
		.onConflictDoNothing()
		.returning({ userId: supportTeamMembers.userId });

	for (const a of added) invalidateCapabilities(a.userId);
	await syncDeskMembers(team);
	await logActivity({
		actorUserId: actor.id,
		action: 'support_team.add',
		targetType: 'support_team',
		targetId: team,
		details: { added: added.map((a) => byId.get(a.userId)?.email) }
	});

	const t = supportTeam(team);
	const names = added.map((a) => byId.get(a.userId)?.fullName).filter(Boolean);
	if (names.length === 0) return { ok: true, message: `Already in ${t.name}.` };
	return {
		ok: true,
		message: `${names.length === 1 ? names[0] : `${names.length} people`} added to ${t.name}. They get its controls within 30 seconds and now answer ${t.deskName}.${noLogin.length ? ` Skipped ${noLogin.length} with no login.` : ''}`
	};
}

export async function removeFromSupportTeam(actor: SessionUser, teamValue: string, userId: string): Promise<Result> {
	if (!hasCap(actor, 'people.assign_roles')) return { ok: false, message: 'Only a Super Admin can change who is in HR, Employee Engagement or IT' };
	const team = teamKeyOf(teamValue);
	if (!team) return { ok: false, message: 'Pick HR, Employee Engagement or IT' };
	const gone = await db
		.delete(supportTeamMembers)
		.where(and(eq(supportTeamMembers.teamKey, team), eq(supportTeamMembers.userId, userId)))
		.returning({ userId: supportTeamMembers.userId });
	if (gone.length === 0) return { ok: true, message: 'They were not in that team.' };
	invalidateCapabilities(userId);
	await syncDeskMembers(team);
	const [p] = await db.select({ fullName: users.fullName, email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
	await logActivity({ actorUserId: actor.id, action: 'support_team.remove', targetType: 'support_team', targetId: team, details: { removed: p?.email } });
	const t = supportTeam(team);
	return { ok: true, message: `${p?.fullName ?? 'They'} left ${t.name}. Their ${t.name} controls end within 30 seconds.` };
}

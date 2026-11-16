import { db } from '$lib/server/db/postgres';
import { chatChannels, chatMembers, employeeProfiles, supportTeamMembers, users } from '$lib/server/db/schema';
import { supportTeam, type SupportTeamKey } from '$lib/capabilities';
import { deskResponderIds, deskUniqueKey } from '$lib/support-desk';
import { and, eq, inArray } from 'drizzle-orm';
import type { SessionUser } from '$lib/server/auth';
import { hasCap } from '$lib/server/capabilities';
import { dmKey } from '$lib/chat/rules';
import { DEFAULT_CHAT_POLICY, normalisePolicy, type ChatPolicy } from '$lib/chat/policy';
import { appSettings } from '$lib/server/db/schema';
import { publish } from './bus';
import { notHidden } from '$lib/server/hidden-users';

/**
 * Who may talk to whom, and the one-of-a-kind conversations: DMs, each
 * person's ESS notices feed, and each person's #ask-hr thread.
 *
 * Direct messages follow the rule agreed for Champ Chat: an Employee can
 * message their team, their reporting manager and direct reports, their
 * concerned HR, and HR (admins). Anyone holding "Message anyone" — Team
 * Leads, HR and named roles given it — can message anyone.
 */

export type Person = {
	id: string;
	fullName: string;
	role: string;
	teamId: string | null;
	reportsTo: string | null;
	hrUserId: string | null;
	isActive: boolean;
	hidden?: boolean;
};

const UUID = /^[0-9a-f-]{36}$/i;

export async function loadPeople(ids?: string[]): Promise<Person[]> {
	// A malformed id matches nobody rather than failing the query.
	if (ids) ids = ids.filter((id) => UUID.test(id));
	if (ids && ids.length === 0) return [];
	const q = db
		.select({
			id: users.id,
			fullName: users.fullName,
			role: users.role,
			teamId: users.teamId,
			reportsTo: users.reportsTo,
			hrUserId: employeeProfiles.hrUserId,
			isActive: users.isActive,
			hidden: users.hidden
		})
		.from(users)
		.leftJoin(employeeProfiles, eq(employeeProfiles.userId, users.id));
	return ids ? q.where(inArray(users.id, ids)) : q;
}

/**
 * Pure form of the DM rule, for the people picker and the send check alike.
 * `policy` is what HR set in Admin Controls › Chat rules.
 */
export function dmAllowed(actor: Person, target: Person, anyone: boolean, policy: ChatPolicy = DEFAULT_CHAT_POLICY): boolean {
	if (actor.id === target.id || !target.isActive || target.hidden) return false;
	if (anyone || policy.dm.everyone) return true;
	const d = policy.dm;
	return (
		(d.team && !!actor.teamId && actor.teamId === target.teamId) ||
		(d.managerAndReports && (actor.reportsTo === target.id || target.reportsTo === actor.id)) ||
		(d.concernedHr && (actor.hrUserId === target.id || target.hrUserId === actor.id)) ||
		(d.allHr && (target.role === 'admin' || target.role === 'super_admin'))
	);
}

/* ---------- the chat rules HR sets ---------- */

let policyCache: { at: number; value: ChatPolicy } | null = null;

export async function loadChatPolicy(): Promise<ChatPolicy> {
	if (policyCache && Date.now() - policyCache.at < 30_000) return policyCache.value;
	const [row] = await db.select().from(appSettings).where(eq(appSettings.key, 'chat_policy')).limit(1);
	const value = normalisePolicy(row?.value);
	policyCache = { at: Date.now(), value };
	return value;
}

export async function saveChatPolicy(policy: ChatPolicy) {
	const value = normalisePolicy(policy);
	await db
		.insert(appSettings)
		.values({ key: 'chat_policy', value })
		.onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
	policyCache = { at: Date.now(), value };
	return value;
}

/** Everyone `actor` may start a DM with. */
export async function dmCandidates(actor: SessionUser): Promise<Person[]> {
	const everyone = await loadPeople();
	const me = everyone.find((p) => p.id === actor.id);
	if (!me) return [];
	const anyone = hasCap(actor, 'chat.dm_anyone');
	const policy = await loadChatPolicy();
	return everyone.filter((p) => dmAllowed(me, p, anyone, policy)).sort((a, b) => a.fullName.localeCompare(b.fullName));
}

export async function canDm(actor: SessionUser, targetId: string): Promise<boolean> {
	const [me, target] = await Promise.all([loadPeople([actor.id]), loadPeople([targetId])]);
	if (!me[0] || !target[0]) return false;
	return dmAllowed(me[0], target[0], hasCap(actor, 'chat.dm_anyone'), await loadChatPolicy());
}

async function upsertChannel(values: typeof chatChannels.$inferInsert, memberIds: string[]) {
	const [row] = await db
		.insert(chatChannels)
		.values(values)
		.onConflictDoUpdate({ target: chatChannels.uniqueKey, set: { archivedAt: null } })
		.returning();
	if (memberIds.length) {
		await db
			.insert(chatMembers)
			.values(memberIds.map((userId) => ({ channelId: row.id, userId, addedBy: 'sync' })))
			.onConflictDoNothing();
	}
	return row;
}

/** The DM between two people, created on first use. */
export async function ensureDm(a: string, b: string) {
	const row = await upsertChannel({ kind: 'dm', uniqueKey: dmKey(a, b), isPrivate: true }, [a, b]);
	return row;
}

/**
 * A person's ESS notices feed: leave requests to approve, decisions on their
 * own requests, reminders. Only they are in it; nobody can post to it.
 */
export async function ensureSystemFeed(userId: string) {
	return upsertChannel({ kind: 'system', name: 'ESS', uniqueKey: `system:${userId}`, isPrivate: true, readOnly: true }, [userId]);
}

/** Active, visible members of a support team (HR, Employee Engagement, IT). */
export async function teamMemberIds(team: SupportTeamKey): Promise<string[]> {
	const rows = await db
		.select({ id: users.id })
		.from(supportTeamMembers)
		.innerJoin(users, eq(users.id, supportTeamMembers.userId))
		.where(and(eq(supportTeamMembers.teamKey, team), eq(users.isActive, true), notHidden));
	return rows.map((r) => r.id);
}

/** Who answers a desk nobody has been put in the team for: HR admins for Ask HR, Super Admins otherwise. */
async function fallbackResponders(team: SupportTeamKey): Promise<string[]> {
	const rows = await db
		.select({ id: users.id })
		.from(users)
		.where(and(eq(users.isActive, true), inArray(users.role, team === 'hr' ? ['admin', 'super_admin'] : ['super_admin']), notHidden));
	return rows.map((r) => r.id);
}

/** Who answers a person's desk thread for `team` (rules in src/lib/support-desk.ts). */
export async function deskResponders(ownerId: string, team: SupportTeamKey = 'hr'): Promise<string[]> {
	const [[owner], members] = await Promise.all([loadPeople([ownerId]), teamMemberIds(team)]);
	const concerned = team === 'hr' && owner?.hrUserId ? owner.hrUserId : null;
	const fallback = members.length || concerned ? [] : await fallbackResponders(team);
	return deskResponderIds(team, { id: ownerId, hrUserId: concerned }, members, fallback);
}

/**
 * A person's private thread with a support team: Ask HR, Ask IT or Ask
 * Engagement. They and the team's responders are members. Re-run when the
 * concerned HR changes, which adds the new one; a change to who is in a team
 * goes through syncDeskMembers.
 */
export async function ensureDesk(ownerId: string, team: SupportTeamKey = 'hr') {
	const [owner] = await loadPeople([ownerId]);
	const responders = await deskResponders(ownerId, team);
	const row = await upsertChannel(
		{
			kind: 'desk',
			name: `${supportTeam(team).deskName} · ${owner?.fullName ?? 'Employee'}`,
			uniqueKey: deskUniqueKey(team, ownerId),
			isPrivate: true,
			deskOwnerId: ownerId,
			deskStatus: 'open',
			deskTeam: team
		},
		[ownerId, ...responders]
	);
	return row;
}

/**
 * After someone joins or leaves a support team: every desk thread of that
 * team gets exactly its responders. Only members the sync added are ever
 * removed (never the person asking, nor anyone added by hand), and each
 * affected person's sidebar is told.
 */
export async function syncDeskMembers(team: SupportTeamKey): Promise<void> {
	const desks = await db
		.select({ id: chatChannels.id, ownerId: chatChannels.deskOwnerId })
		.from(chatChannels)
		.where(and(eq(chatChannels.kind, 'desk'), eq(chatChannels.deskTeam, team)));
	if (desks.length === 0) return;

	const members = await teamMemberIds(team);
	const owners = await loadPeople(desks.map((d) => d.ownerId).filter((id): id is string => !!id));
	const ownerById = new Map(owners.map((o) => [o.id, o]));
	const needsFallback = members.length === 0;
	const fallback = needsFallback ? await fallbackResponders(team) : [];

	const deskIds = desks.map((d) => d.id);
	const current = await db
		.select({ channelId: chatMembers.channelId, userId: chatMembers.userId, addedBy: chatMembers.addedBy })
		.from(chatMembers)
		.where(inArray(chatMembers.channelId, deskIds));
	const byDesk = new Map<string, typeof current>();
	for (const m of current) byDesk.set(m.channelId, [...(byDesk.get(m.channelId) ?? []), m]);

	const add: { channelId: string; userId: string; addedBy: string }[] = [];
	const removeByUser = new Map<string, string[]>();
	for (const d of desks) {
		if (!d.ownerId) continue;
		const owner = ownerById.get(d.ownerId);
		const concerned = team === 'hr' && owner?.hrUserId ? owner.hrUserId : null;
		const want = new Set(deskResponderIds(team, { id: d.ownerId, hrUserId: concerned }, members, concerned ? [] : fallback));
		const have = byDesk.get(d.id) ?? [];
		for (const id of want) if (!have.some((m) => m.userId === id)) add.push({ channelId: d.id, userId: id, addedBy: 'sync' });
		for (const m of have) {
			if (m.userId === d.ownerId || want.has(m.userId) || m.addedBy !== 'sync') continue;
			removeByUser.set(m.userId, [...(removeByUser.get(m.userId) ?? []), d.id]);
		}
	}

	for (let i = 0; i < add.length; i += 500) await db.insert(chatMembers).values(add.slice(i, i + 500)).onConflictDoNothing();
	for (const [userId, channelIds] of removeByUser) {
		await db.delete(chatMembers).where(and(eq(chatMembers.userId, userId), inArray(chatMembers.channelId, channelIds)));
	}
	const touched = [...new Set([...add.map((a) => a.userId), ...removeByUser.keys()])];
	if (touched.length) await publish(touched, { type: 'channels.changed', channelId: '' });
}

export async function membership(channelId: string, userId: string) {
	const [m] = await db
		.select()
		.from(chatMembers)
		.where(and(eq(chatMembers.channelId, channelId), eq(chatMembers.userId, userId)))
		.limit(1);
	return m ?? null;
}

export async function channelMemberIds(channelId: string): Promise<string[]> {
	const rows = await db.select({ userId: chatMembers.userId }).from(chatMembers).where(eq(chatMembers.channelId, channelId));
	return rows.map((r) => r.userId);
}

/** Tell every member their sidebar changed (new channel, rename, members). */
export async function announceChannelChange(channelId: string, extra: string[] = []) {
	await publish([...(await channelMemberIds(channelId)), ...extra], { type: 'channels.changed', channelId });
}

/** Whether `actor` may create channels, and for which team. */
export function channelCreationScope(actor: SessionUser): 'anywhere' | 'team' | 'none' {
	if (hasCap(actor, 'chat.create_channels')) return 'anywhere';
	if (actor.role === 'team_lead' && actor.teamId) return 'team';
	return 'none';
}

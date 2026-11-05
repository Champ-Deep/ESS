import { db } from '$lib/server/db/client';
import { chatChannels, chatMembers, users } from '$lib/server/db/schema';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { chunksFor, inArray } from '$lib/server/db/sql';
import type { SessionUser } from '$lib/server/auth';
import { hasCap } from '$lib/server/capabilities';
import { loadBadge } from '$lib/server/announcements';
import { channelSlug } from '$lib/chat/rules';
import { publish } from './bus';
import {
	announceChannelChange,
	channelCreationScope,
	dmAllowed,
	ensureDesk,
	ensureDm,
	ensureSystemFeed,
	loadChatPolicy,
	loadPeople,
	membership
} from './access';
import { describeDmRule } from '$lib/chat/policy';
import { notHidden } from '$lib/server/hidden-users';

export type SidebarChannel = {
	id: string;
	kind: 'channel' | 'dm' | 'group' | 'desk' | 'system' | 'announcements';
	name: string;
	topic: string;
	source: string;
	isPrivate: boolean;
	readOnly: boolean;
	teamId: string | null;
	/** DM or group: the other people. */
	others: { id: string; fullName: string; isActive: boolean }[];
	/** Your manager or concerned HR, pinned at the top of DMs. */
	pinnedAs: 'manager' | 'hr' | null;
	deskStatus: string | null;
	deskOwnerId: string | null;
	isAdmin: boolean;
	unread: number;
	mentions: number;
	muted: boolean;
	notify: string;
	lastMessageAt: string;
	lastReadAt: string;
};

/**
 * Everything in one person's sidebar, with unread and mention counts.
 *
 * Also makes sure the conversations everyone is meant to have exist: their
 * ESS notices feed, their #ask-hr thread (for anyone who is not HR), and DMs
 * with their reporting manager and concerned HR.
 */
export async function sidebarFor(user: SessionUser): Promise<{ channels: SidebarChannel[]; badge: number }> {
	const [me] = await loadPeople([user.id]);
	const isHr = hasCap(user, 'chat.hr_desk');
	await ensureSystemFeed(user.id);
	if (!isHr) await ensureDesk(user.id);
	const pinned = new Map<string, 'manager' | 'hr'>();
	if (me?.reportsTo) {
		const [mgr] = await loadPeople([me.reportsTo]);
		if (mgr?.isActive) pinned.set((await ensureDm(user.id, mgr.id)).id, 'manager');
	}
	if (me?.hrUserId && me.hrUserId !== me.reportsTo && me.hrUserId !== user.id) {
		pinned.set((await ensureDm(user.id, me.hrUserId)).id, 'hr');
	}

	const rows = await db
		.select({ c: chatChannels, m: chatMembers })
		.from(chatMembers)
		.innerJoin(chatChannels, eq(chatChannels.id, chatMembers.channelId))
		.where(and(eq(chatMembers.userId, user.id), isNull(chatChannels.archivedAt)));

	const ids = rows.map((r) => r.c.id);
	const counts = ids.length
		? await db.all<{ id: string; unread: number; mentions: number }>(sql`
			select m.channel_id as id,
				count(*) as unread,
				count(*) filter (where exists (select 1 from json_each(msg.mentions) where value = ${user.id}) or msg.mentions_all) as mentions
			from chat_members m
			join chat_messages msg on msg.channel_id = m.channel_id
			where m.user_id = ${user.id}
				and msg.created_at > m.last_read_at
				and msg.thread_root_id is null
				and msg.deleted_at is null
				and (msg.author_id is null or msg.author_id <> ${user.id})
				and (msg.visible_to is null or msg.visible_to = ${user.id})
			group by m.channel_id
		`)
		: [];
	const countBy = new Map(counts.map((r) => [r.id, r]));

	// Names of the other people in DMs and groups, in one query.
	const convIds = rows.filter((r) => r.c.kind === 'dm' || r.c.kind === 'group').map((r) => r.c.id);
	const otherRows = convIds.length
		? await db
				.select({ channelId: chatMembers.channelId, id: users.id, fullName: users.fullName, isActive: users.isActive })
				.from(chatMembers)
				.innerJoin(users, eq(users.id, chatMembers.userId))
				.where(and(inArray(chatMembers.channelId, convIds), sql`${chatMembers.userId} <> ${user.id}`, notHidden))
		: [];

	const announcementBadge = await loadBadge(user.id);
	const now = Date.now();

	const channels: SidebarChannel[] = rows.map(({ c, m }) => {
		const cnt = countBy.get(c.id);
		const isAnnouncements = c.kind === 'announcements';
		return {
			id: c.id,
			kind: c.kind,
			name: c.name,
			topic: c.topic,
			source: c.source,
			isPrivate: c.isPrivate,
			readOnly: c.readOnly,
			teamId: c.teamId,
			others: otherRows.filter((o) => o.channelId === c.id).map((o) => ({ id: o.id, fullName: o.fullName, isActive: o.isActive })),
			pinnedAs: pinned.get(c.id) ?? null,
			deskStatus: c.deskStatus,
			deskOwnerId: c.deskOwnerId,
			isAdmin: m.role === 'admin',
			unread: isAnnouncements ? announcementBadge.count : (cnt?.unread ?? 0),
			mentions: isAnnouncements ? (announcementBadge.urgent ? 1 : 0) : (cnt?.mentions ?? 0),
			muted: !!m.mutedUntil && m.mutedUntil.getTime() > now,
			notify: m.notify,
			lastMessageAt: c.lastMessageAt.toISOString(),
			lastReadAt: m.lastReadAt.toISOString()
		};
	});

	return { channels, badge: badgeFrom(channels) };
}

/**
 * The number on the Champ Chat sidebar entry: every unread direct message,
 * group message, desk reply and ESS notice, plus mentions in channels and
 * unread announcements. Plain channel chatter only bolds the channel name.
 */
export function badgeFrom(channels: SidebarChannel[]): number {
	let n = 0;
	for (const c of channels) {
		if (c.muted) continue;
		if (c.kind === 'channel') n += c.mentions;
		else n += c.unread;
	}
	return n;
}

export async function markRead(user: SessionUser, channelId: string, at = new Date()) {
	await db
		.update(chatMembers)
		.set({ lastReadAt: at })
		.where(and(eq(chatMembers.channelId, channelId), eq(chatMembers.userId, user.id), sql`${chatMembers.lastReadAt} < ${at.getTime()}`));
	const [c] = await db.select({ kind: chatChannels.kind }).from(chatChannels).where(eq(chatChannels.id, channelId)).limit(1);
	// Your other tabs clear the badge; in a DM the other person sees "Seen".
	const others = c?.kind === 'dm' ? (await db.select({ userId: chatMembers.userId }).from(chatMembers).where(eq(chatMembers.channelId, channelId))).map((r) => r.userId) : [user.id];
	await publish(others, { type: 'read', channelId, userId: user.id, at: at.toISOString() });
}

type Fail = { ok: false; message: string };

/** Add members, a few rows per statement: D1 binds at most 100 values per query (chat_members has 9 columns). */
async function insertMembers(rows: (typeof chatMembers.$inferInsert)[]) {
	if (rows.length === 0) return;
	const [first, ...rest] = chunksFor(rows, 9).map((chunk) => db.insert(chatMembers).values(chunk).onConflictDoNothing());
	await db.batch([first, ...rest]);
}

export async function openDm(user: SessionUser, targetId: string): Promise<{ ok: true; id: string } | Fail> {
	const [me, target] = [(await loadPeople([user.id]))[0], (await loadPeople([targetId]))[0]];
	if (!me || !target) return { ok: false, message: 'That person no longer exists' };
	const policy = await loadChatPolicy();
	if (!dmAllowed(me, target, hasCap(user, 'chat.dm_anyone'), policy)) {
		return { ok: false, message: `You can message ${describeDmRule(policy)}. Ask your team lead to pass this on.` };
	}
	const row = await ensureDm(user.id, targetId);
	await announceChannelChange(row.id);
	return { ok: true, id: row.id };
}

export async function createGroup(user: SessionUser, memberIds: string[], groupName = ''): Promise<{ ok: true; id: string } | Fail> {
	const policy = await loadChatPolicy();
	if (policy.groups === 'privileged' && !hasCap(user, 'chat.create_groups')) {
		return { ok: false, message: 'Group chats are started by Team Leads and HR here. Ask one of them to start it.' };
	}
	const ids = [...new Set(memberIds.filter((id) => id !== user.id && /^[0-9a-f-]{36}$/i.test(id)))];
	if (ids.length < 2) return { ok: false, message: 'A group needs at least two other people. For one person, start a DM.' };
	if (ids.length > 20) return { ok: false, message: 'Keep a group to 20 people. For more, create a channel.' };
	const everyone = await loadPeople([user.id, ...ids]);
	const me = everyone.find((p) => p.id === user.id)!;
	const anyone = hasCap(user, 'chat.dm_anyone');
	const blocked = everyone.filter((p) => p.id !== user.id && !dmAllowed(me, p, anyone, policy));
	if (blocked.length) return { ok: false, message: `You cannot message ${blocked.map((b) => b.fullName).join(', ')} directly.` };
	const name = groupName.trim().slice(0, 60) || everyone.filter((p) => p.id !== user.id).map((p) => p.fullName.split(' ')[0]).join(', ');
	const [row] = await db.insert(chatChannels).values({ kind: 'group', name, isPrivate: true, createdBy: user.id }).returning();
	await insertMembers([user.id, ...ids].map((userId) => ({ channelId: row.id, userId, role: userId === user.id ? 'admin' : 'member' })));
	await announceChannelChange(row.id);
	return { ok: true, id: row.id };
}

export async function createChannel(
	user: SessionUser,
	input: { name: string; topic?: string; isPrivate?: boolean; memberIds?: string[] }
): Promise<{ ok: true; id: string } | Fail> {
	const scope = channelCreationScope(user);
	if (scope === 'none') return { ok: false, message: 'Team Leads can create channels for their team, and HR anywhere.' };
	const name = channelSlug(input.name);
	if (!input.name.trim()) return { ok: false, message: 'Give the channel a name' };
	const [clash] = await db
		.select({ id: chatChannels.id })
		.from(chatChannels)
		.where(and(eq(chatChannels.kind, 'channel'), eq(chatChannels.name, name), isNull(chatChannels.archivedAt)))
		.limit(1);
	if (clash) return { ok: false, message: `#${name} already exists` };

	let memberIds = [...new Set([user.id, ...(input.memberIds ?? []).filter((id) => /^[0-9a-f-]{36}$/i.test(id))])];
	if (scope === 'team') {
		// A Team Lead's channel is for their team: everyone added must be on it.
		const people = await loadPeople(memberIds);
		const outside = people.filter((p) => p.teamId !== user.teamId && p.id !== user.id);
		if (outside.length) return { ok: false, message: `${outside.map((o) => o.fullName).join(', ')} ${outside.length === 1 ? 'is' : 'are'} not on your team.` };
		memberIds = people.filter((p) => p.isActive).map((p) => p.id);
	}
	const [row] = await db
		.insert(chatChannels)
		.values({
			kind: 'channel',
			name,
			topic: input.topic?.trim().slice(0, 200) ?? '',
			isPrivate: !!input.isPrivate,
			teamId: scope === 'team' ? user.teamId : null,
			createdBy: user.id
		})
		.returning();
	await insertMembers(memberIds.map((userId) => ({ channelId: row.id, userId, role: userId === user.id ? 'admin' : 'member' })));
	await announceChannelChange(row.id);
	return { ok: true, id: row.id };
}

/** Public channels you are not in yet, to browse and join. */
export async function browseChannels(user: SessionUser) {
	return db.all<{ id: string; name: string; topic: string; teamId: string | null; members: number }>(sql`
		select c.id, c.name, c.topic, c.team_id as "teamId",
			(select count(*) from chat_members x join users u on u.id = x.user_id where x.channel_id = c.id and u.hidden = 0) as members
		from chat_channels c
		where c.kind = 'channel' and c.is_private = 0 and c.archived_at is null and c.source = 'manual'
			and not exists (select 1 from chat_members m where m.channel_id = c.id and m.user_id = ${user.id})
			and (c.team_id is null or c.team_id = ${user.teamId})
		order by c.name
	`);
}

export async function joinChannel(user: SessionUser, channelId: string): Promise<{ ok: true } | Fail> {
	const [c] = await db.select().from(chatChannels).where(eq(chatChannels.id, channelId)).limit(1);
	if (!c || c.kind !== 'channel' || c.archivedAt) return { ok: false, message: 'That channel no longer exists' };
	if (c.isPrivate) return { ok: false, message: 'That channel is private. Ask a member to add you.' };
	if (c.teamId && c.teamId !== user.teamId) return { ok: false, message: 'That channel is for another team' };
	await db.insert(chatMembers).values({ channelId, userId: user.id }).onConflictDoNothing();
	await announceChannelChange(channelId);
	return { ok: true };
}

/** Channel admins (its creator) and HR manage members of a manual channel or group. */
async function canManage(user: SessionUser, channelId: string) {
	const [c] = await db.select().from(chatChannels).where(eq(chatChannels.id, channelId)).limit(1);
	if (!c || (c.kind !== 'channel' && c.kind !== 'group') || c.source !== 'manual') return { c, ok: false };
	const m = await membership(channelId, user.id);
	return { c, ok: m?.role === 'admin' || hasCap(user, 'chat.create_channels') };
}

export async function addMembers(user: SessionUser, channelId: string, ids: string[]): Promise<{ ok: true } | Fail> {
	const { c, ok } = await canManage(user, channelId);
	if (!c) return { ok: false, message: 'That conversation no longer exists' };
	if (!ok) return { ok: false, message: c.source !== 'manual' ? 'Members of this channel follow the roster' : 'Only the channel creator or HR can add people' };
	let people = (await loadPeople(ids)).filter((p) => p.isActive && !p.hidden);
	if (c.teamId) people = people.filter((p) => p.teamId === c.teamId);
	await insertMembers(people.map((p) => ({ channelId, userId: p.id })));
	await announceChannelChange(channelId);
	return { ok: true };
}

export async function removeMember(user: SessionUser, channelId: string, userId: string): Promise<{ ok: true } | Fail> {
	const self = userId === user.id;
	const { c, ok } = await canManage(user, channelId);
	if (!c) return { ok: false, message: 'That conversation no longer exists' };
	if (c.source !== 'manual') return { ok: false, message: 'Members of this channel follow the roster' };
	if (!self && !ok) return { ok: false, message: 'Only the channel creator or HR can remove people' };
	await db.delete(chatMembers).where(and(eq(chatMembers.channelId, channelId), eq(chatMembers.userId, userId)));
	await announceChannelChange(channelId, [userId]);
	return { ok: true };
}

export async function setMute(user: SessionUser, channelId: string, muted: boolean, notify?: string) {
	await db
		.update(chatMembers)
		.set({
			mutedUntil: muted ? new Date(Date.now() + 365 * 86_400_000) : null,
			...(notify && ['all', 'mentions', 'none'].includes(notify) ? { notify } : {})
		})
		.where(and(eq(chatMembers.channelId, channelId), eq(chatMembers.userId, user.id)));
	await publish([user.id], { type: 'channels.changed', channelId });
}

export async function setDeskStatus(user: SessionUser, channelId: string, status: 'open' | 'resolved'): Promise<{ ok: true } | Fail> {
	if (!hasCap(user, 'chat.hr_desk')) return { ok: false, message: 'Only HR can resolve Ask HR threads' };
	const m = await membership(channelId, user.id);
	if (!m) return { ok: false, message: 'You are not on this thread' };
	await db.update(chatChannels).set({ deskStatus: status }).where(and(eq(chatChannels.id, channelId), eq(chatChannels.kind, 'desk')));
	await announceChannelChange(channelId);
	return { ok: true };
}

export async function channelMembers(channelId: string) {
	return db
		.select({ id: users.id, fullName: users.fullName, role: users.role, isActive: users.isActive, memberRole: chatMembers.role })
		.from(chatMembers)
		.innerJoin(users, eq(users.id, chatMembers.userId))
		.where(and(eq(chatMembers.channelId, channelId), notHidden))
		.orderBy(users.fullName);
}

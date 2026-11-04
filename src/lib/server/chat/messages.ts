import { db } from '$lib/server/db/postgres';
import {
	chatChannels,
	chatMembers,
	chatMessages,
	chatPollVotes,
	chatReactions,
	chatReports,
	chatSaved,
	chatTodos,
	users
} from '$lib/server/db/schema';
import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { SessionUser } from '$lib/server/auth';
import { hasCap } from '$lib/server/capabilities';
import { getMongo, logActivity } from '$lib/server/db/mongo';
import { detectSensitive, SENSITIVE_LABEL, type SensitiveKind } from '$lib/chat/rules';
import { publish } from './bus';
import { channelMemberIds, membership } from './access';
import { deliverNotification } from './notify';
import { resolveCards, type CardRef, type ResolvedCard } from './cards';
import { notHidden } from '$lib/server/hidden-users';

export const MAX_BODY = 4000;

export type ChatMessageView = {
	id: string;
	channelId: string;
	threadRootId: string | null;
	author: { id: string; fullName: string } | null;
	kind: string;
	body: string;
	card: (CardRef & { resolved?: ResolvedCard | null }) | null;
	file: { id: string; name: string; mime: string; size: number } | null;
	mentions: string[];
	mentionsAll: boolean;
	sensitive: boolean;
	privateToYou: boolean;
	editedAt: string | null;
	deleted: boolean;
	hidden: boolean;
	pinned: boolean;
	replyCount: number;
	lastReplyAt: string | null;
	createdAt: string;
	reactions: { emoji: string; count: number; mine: boolean; names: string[] }[];
	saved: boolean;
	poll: { question: string; options: { label: string; count: number; mine: boolean }[]; total: number } | null;
};

type Row = typeof chatMessages.$inferSelect;

async function serialize(viewer: SessionUser, rows: Row[]): Promise<ChatMessageView[]> {
	if (rows.length === 0) return [];
	const ids = rows.map((r) => r.id);
	const authorIds = [...new Set(rows.map((r) => r.authorId).filter(Boolean) as string[])];
	const [authors, reacts, saved, votes] = await Promise.all([
		authorIds.length ? db.select({ id: users.id, fullName: users.fullName }).from(users).where(inArray(users.id, authorIds)) : [],
		db
			.select({ messageId: chatReactions.messageId, emoji: chatReactions.emoji, userId: chatReactions.userId, name: users.fullName })
			.from(chatReactions)
			.innerJoin(users, eq(users.id, chatReactions.userId))
			.where(and(inArray(chatReactions.messageId, ids), or(notHidden, eq(chatReactions.userId, viewer.id)))),
		db.select({ messageId: chatSaved.messageId }).from(chatSaved).where(and(inArray(chatSaved.messageId, ids), eq(chatSaved.userId, viewer.id))),
		db.select().from(chatPollVotes).where(inArray(chatPollVotes.messageId, ids))
	]);
	const authorBy = new Map(authors.map((a) => [a.id, a]));
	const savedSet = new Set(saved.map((s) => s.messageId));
	const cardRefs = rows
		.map((r) => r.card as CardRef | null)
		.filter((c): c is CardRef & { id: string } => !!c && ['leave', 'deviation', 'comp_off'].includes(c.type));
	const resolved = await resolveCards(viewer, cardRefs.map((c) => ({ type: c.type, id: c.id })));

	return rows.map((r) => {
		const card = r.card as CardRef | null;
		const removed = !!r.deletedAt || !!r.hiddenAt;
		const reactions = new Map<string, { emoji: string; count: number; mine: boolean; names: string[] }>();
		for (const x of reacts.filter((x) => x.messageId === r.id)) {
			const e = reactions.get(x.emoji) ?? { emoji: x.emoji, count: 0, mine: false, names: [] };
			e.count++;
			if (x.userId === viewer.id) e.mine = true;
			if (e.names.length < 10) e.names.push(x.name);
			reactions.set(x.emoji, e);
		}
		let poll: ChatMessageView['poll'] = null;
		if (card?.type === 'poll') {
			const vs = votes.filter((v) => v.messageId === r.id);
			poll = {
				question: card.question,
				options: card.options.map((label, i) => ({
					label,
					count: vs.filter((v) => v.optionIndex === i).length,
					mine: vs.some((v) => v.optionIndex === i && v.userId === viewer.id)
				})),
				total: new Set(vs.map((v) => v.userId)).size
			};
		}
		return {
			id: r.id,
			channelId: r.channelId,
			threadRootId: r.threadRootId,
			author: r.authorId ? (authorBy.get(r.authorId) ?? { id: r.authorId, fullName: 'Former employee' }) : null,
			kind: r.kind,
			body: removed ? '' : r.body,
			card: removed || !card ? null : { ...card, resolved: 'id' in card ? (resolved.get(`${card.type}:${card.id}`) ?? null) : undefined },
			file: removed || !r.fileId ? null : { id: r.fileId, name: r.fileName ?? 'file', mime: r.fileMime ?? 'application/octet-stream', size: r.fileSize ?? 0 },
			mentions: r.mentions,
			mentionsAll: r.mentionsAll,
			sensitive: r.sensitive,
			privateToYou: !!r.visibleTo,
			editedAt: r.editedAt?.toISOString() ?? null,
			deleted: !!r.deletedAt,
			hidden: !!r.hiddenAt,
			pinned: !!r.pinnedAt,
			replyCount: r.replyCount,
			lastReplyAt: r.lastReplyAt?.toISOString() ?? null,
			createdAt: r.createdAt.toISOString(),
			reactions: [...reactions.values()],
			saved: savedSet.has(r.id),
			poll
		};
	});
}

const visibleToViewer = (viewerId: string) => or(isNull(chatMessages.visibleTo), eq(chatMessages.visibleTo, viewerId));

export async function listMessages(
	viewer: SessionUser,
	channelId: string,
	opts: { before?: string; threadRootId?: string; limit?: number } = {}
): Promise<{ ok: true; messages: ChatMessageView[]; more: boolean } | { ok: false; message: string }> {
	if (!(await membership(channelId, viewer.id))) return { ok: false, message: 'You are not in this conversation' };
	const limit = Math.min(opts.limit ?? 50, 100);
	const where = and(
		eq(chatMessages.channelId, channelId),
		opts.threadRootId ? eq(chatMessages.threadRootId, opts.threadRootId) : isNull(chatMessages.threadRootId),
		opts.before ? lt(chatMessages.createdAt, new Date(opts.before)) : undefined,
		visibleToViewer(viewer.id)
	);
	const rows = await db.select().from(chatMessages).where(where).orderBy(desc(chatMessages.createdAt)).limit(limit + 1);
	const more = rows.length > limit;
	const page = rows.slice(0, limit).reverse();
	return { ok: true, messages: await serialize(viewer, page), more };
}

export async function getMessages(viewer: SessionUser, ids: string[]) {
	if (ids.length === 0) return [];
	const rows = await db
		.select()
		.from(chatMessages)
		.innerJoin(chatMembers, and(eq(chatMembers.channelId, chatMessages.channelId), eq(chatMembers.userId, viewer.id)))
		.where(and(inArray(chatMessages.id, ids), visibleToViewer(viewer.id)));
	return serialize(viewer, rows.map((r) => r.chat_messages));
}

type SendInput = {
	channelId: string;
	body: string;
	threadRootId?: string | null;
	mentions?: string[];
	mentionAll?: boolean;
	confirmSensitive?: boolean;
	file?: { id: string; name: string; mime: string; size: number } | null;
	card?: CardRef | null;
	kind?: string;
	/** Only this person may see it (a private Champ reply). */
	visibleTo?: string | null;
	/** Post as ESS or Champ rather than the signed-in person. */
	asSystem?: boolean;
};

export type SendResult =
	| { ok: true; message: ChatMessageView }
	| { ok: false; message: string; needsConfirm?: SensitiveKind[] };

/** Can `viewer` write in this conversation at all? */
async function postingRule(viewer: SessionUser, channelId: string) {
	const [c] = await db.select().from(chatChannels).where(eq(chatChannels.id, channelId)).limit(1);
	if (!c || c.archivedAt) return { c: null, reason: 'That conversation no longer exists' };
	const m = await membership(channelId, viewer.id);
	if (!m) return { c, reason: 'You are not in this conversation' };
	if (c.kind === 'announcements') return { c, reason: 'Announcements are posted with the New announcement button' };
	if (c.kind === 'system' || c.readOnly) return { c, reason: 'This is a read-only feed' };
	if (c.kind === 'dm') {
		const others = await db
			.select({ isActive: users.isActive })
			.from(chatMembers)
			.innerJoin(users, eq(users.id, chatMembers.userId))
			.where(and(eq(chatMembers.channelId, channelId), sql`${chatMembers.userId} <> ${viewer.id}`));
		if (others.length && others.every((o) => !o.isActive)) return { c, reason: 'This person has left, so the conversation is read-only' };
	}
	return { c, reason: null };
}

export async function sendMessage(viewer: SessionUser, input: SendInput): Promise<SendResult> {
	const body = (input.body ?? '').trim();
	if (!body && !input.file && !input.card) return { ok: false, message: 'Type a message first' };
	if (body.length > MAX_BODY) return { ok: false, message: `Keep a message under ${MAX_BODY} characters` };

	let channel: typeof chatChannels.$inferSelect | null;
	if (input.asSystem) {
		[channel] = await db.select().from(chatChannels).where(eq(chatChannels.id, input.channelId)).limit(1);
		if (!channel) return { ok: false, message: 'That conversation no longer exists' };
	} else {
		const rule = await postingRule(viewer, input.channelId);
		if (rule.reason) return { ok: false, message: rule.reason };
		channel = rule.c;
	}
	const c = channel!;

	let root: Row | undefined;
	if (input.threadRootId) {
		[root] = await db.select().from(chatMessages).where(eq(chatMessages.id, input.threadRootId)).limit(1);
		if (!root || root.channelId !== c.id || root.threadRootId) return { ok: false, message: 'That thread no longer exists' };
	}

	const found = input.asSystem ? [] : detectSensitive(body);
	if (found.length && !input.confirmSensitive) {
		return {
			ok: false,
			message: `This looks like ${found.map((k) => SENSITIVE_LABEL[k]).join(' and ')}. Send it anyway?`,
			needsConfirm: found
		};
	}

	const memberIds = await channelMemberIds(c.id);
	const mentions = [...new Set((input.mentions ?? []).filter((id) => memberIds.includes(id) && id !== viewer.id))];
	let mentionsAll = false;
	if (input.mentionAll && c.kind === 'channel') {
		const allowed = hasCap(viewer, 'chat.mention_all') || (viewer.role === 'team_lead' && !!c.teamId && c.teamId === viewer.teamId) || (viewer.role === 'team_lead' && c.source === 'team' && c.sourceId === viewer.teamId);
		if (!allowed) return { ok: false, message: 'Only HR, and Team Leads in their own team channel, can use @channel' };
		mentionsAll = true;
	}

	const [row] = await db
		.insert(chatMessages)
		.values({
			channelId: c.id,
			threadRootId: root?.id ?? null,
			authorId: input.asSystem ? null : viewer.id,
			kind: input.kind ?? (input.card ? 'card' : 'text'),
			body,
			card: input.card ?? null,
			fileId: input.file?.id ?? null,
			fileName: input.file?.name ?? null,
			fileMime: input.file?.mime ?? null,
			fileSize: input.file?.size ?? null,
			mentions,
			mentionsAll,
			sensitive: found.length > 0,
			visibleTo: input.visibleTo ?? null
		})
		.returning();

	if (root) {
		await db
			.update(chatMessages)
			.set({ replyCount: sql`${chatMessages.replyCount} + 1`, lastReplyAt: row.createdAt })
			.where(eq(chatMessages.id, root.id));
	} else {
		await db.update(chatChannels).set({ lastMessageAt: row.createdAt }).where(eq(chatChannels.id, c.id));
	}
	// A question on an Ask HR thread reopens it.
	if (c.kind === 'desk' && !input.asSystem && viewer.id === c.deskOwnerId && c.deskStatus !== 'open') {
		await db.update(chatChannels).set({ deskStatus: 'open' }).where(eq(chatChannels.id, c.id));
		await publish(memberIds, { type: 'channels.changed', channelId: c.id });
	}
	// Posting counts as reading everything before it.
	if (!input.asSystem) {
		await db.update(chatMembers).set({ lastReadAt: row.createdAt }).where(and(eq(chatMembers.channelId, c.id), eq(chatMembers.userId, viewer.id)));
	}

	const audience = input.visibleTo ? [input.visibleTo] : memberIds;
	await publish(audience, { type: 'message.created', channelId: c.id, messageId: row.id, threadRootId: row.threadRootId, authorId: row.authorId });
	if (root) await publish(audience, { type: 'message.updated', channelId: c.id, messageId: root.id });

	// Who gets an alert, rather than just a bold channel name.
	const sender = input.asSystem ? 'ESS' : viewer.fullName;
	const snippet = body || (input.file ? `Sent a file: ${input.file.name}` : 'New message');
	const url = `/chat?c=${c.id}${root ? `&t=${root.id}` : ''}`;
	const threadPeople = root
		? (await db.selectDistinct({ id: chatMessages.authorId }).from(chatMessages).where(or(eq(chatMessages.id, root.id), eq(chatMessages.threadRootId, root.id)))).map((r) => r.id).filter(Boolean) as string[]
		: [];
	const alertIds = audience.filter((id) => {
		if (id === viewer.id && !input.asSystem) return false;
		if (c.kind === 'dm' || c.kind === 'group' || c.kind === 'desk' || c.kind === 'system') return true;
		return mentions.includes(id) || mentionsAll || threadPeople.includes(id);
	});
	if (alertIds.length && !input.visibleTo) {
		const muted = await db
			.select({ userId: chatMembers.userId, mutedUntil: chatMembers.mutedUntil, notify: chatMembers.notify })
			.from(chatMembers)
			.where(and(eq(chatMembers.channelId, c.id), inArray(chatMembers.userId, alertIds)));
		const skip = new Set(
			muted
				.filter((m) => (m.mutedUntil && m.mutedUntil.getTime() > Date.now()) || m.notify === 'none' || (m.notify === 'mentions' && !mentions.includes(m.userId) && !mentionsAll))
				.map((m) => m.userId)
		);
		const title = c.kind === 'channel' ? `${sender} in #${c.name}` : c.kind === 'desk' ? `${sender} · Ask HR` : sender;
		void deliverNotification(alertIds.filter((id) => !skip.has(id)), { title, body: snippet, url, kind: c.kind === 'channel' ? 'mention' : c.kind === 'desk' ? 'desk' : 'dm' }).catch(() => {});
	}

	// "@Champ" anywhere in a person's message: Champ answers in the conversation.
	if (!input.asSystem && /(^|\s)@champ\b/i.test(body) && c.kind !== 'system' && c.kind !== 'announcements') {
		void import('$lib/server/champ/in-chat')
			.then((m) => m.answerInChannel(viewer, c.id, body, root?.id ?? null))
			.catch((err) => console.error('[champ] in-chat failed:', err));
	}

	const [view] = await serialize(viewer, [row]);
	return { ok: true, message: view };
}

/** A message from ESS in a channel (celebrations, cross-posts). */
export async function postToChannel(channelId: string, body: string, card: CardRef | null) {
	const [row] = await db.insert(chatMessages).values({ channelId, kind: card ? 'card' : 'system', body, card }).returning();
	await db.update(chatChannels).set({ lastMessageAt: row.createdAt }).where(eq(chatChannels.id, channelId));
	await publish(await channelMemberIds(channelId), { type: 'message.created', channelId, messageId: row.id, threadRootId: null });
	return row;
}

async function own(viewer: SessionUser, id: string) {
	const [m] = await db.select().from(chatMessages).where(eq(chatMessages.id, id)).limit(1);
	if (!m || !(await membership(m.channelId, viewer.id))) return null;
	return m;
}

async function changed(m: Row) {
	await publish(m.visibleTo ? [m.visibleTo] : await channelMemberIds(m.channelId), { type: 'message.updated', channelId: m.channelId, messageId: m.id });
}

type Done = { ok: true } | { ok: false; message: string };

export async function editMessage(viewer: SessionUser, id: string, body: string): Promise<Done> {
	const m = await own(viewer, id);
	if (!m || m.authorId !== viewer.id || m.deletedAt) return { ok: false, message: 'You can only edit your own messages' };
	const text = body.trim();
	if (!text) return { ok: false, message: 'A message cannot be empty. Delete it instead.' };
	if (text.length > MAX_BODY) return { ok: false, message: `Keep a message under ${MAX_BODY} characters` };
	await db.update(chatMessages).set({ body: text, editedAt: new Date(), sensitive: detectSensitive(text).length > 0 }).where(eq(chatMessages.id, id));
	await changed(m);
	return { ok: true };
}

export async function deleteMessage(viewer: SessionUser, id: string): Promise<Done> {
	const m = await own(viewer, id);
	if (!m || m.authorId !== viewer.id) return { ok: false, message: 'You can only delete your own messages' };
	await db.update(chatMessages).set({ deletedAt: new Date() }).where(eq(chatMessages.id, id));
	await changed(m);
	return { ok: true };
}

export async function toggleReaction(viewer: SessionUser, id: string, emoji: string): Promise<Done> {
	if (!emoji || emoji.length > 16) return { ok: false, message: 'Pick an emoji' };
	const m = await own(viewer, id);
	if (!m) return { ok: false, message: 'That message is not in your conversations' };
	const del = await db
		.delete(chatReactions)
		.where(and(eq(chatReactions.messageId, id), eq(chatReactions.userId, viewer.id), eq(chatReactions.emoji, emoji)))
		.returning();
	if (del.length === 0) await db.insert(chatReactions).values({ messageId: id, userId: viewer.id, emoji }).onConflictDoNothing();
	await changed(m);
	return { ok: true };
}

export async function togglePin(viewer: SessionUser, id: string): Promise<Done> {
	const m = await own(viewer, id);
	if (!m) return { ok: false, message: 'That message is not in your conversations' };
	const [c] = await db.select({ kind: chatChannels.kind }).from(chatChannels).where(eq(chatChannels.id, m.channelId)).limit(1);
	if (c?.kind === 'system') return { ok: false, message: 'Nothing can be pinned in your ESS feed' };
	await db
		.update(chatMessages)
		.set(m.pinnedAt ? { pinnedAt: null, pinnedBy: null } : { pinnedAt: new Date(), pinnedBy: viewer.id })
		.where(eq(chatMessages.id, id));
	await changed(m);
	return { ok: true };
}

export async function toggleSave(viewer: SessionUser, id: string): Promise<Done> {
	const m = await own(viewer, id);
	if (!m) return { ok: false, message: 'That message is not in your conversations' };
	const del = await db.delete(chatSaved).where(and(eq(chatSaved.messageId, id), eq(chatSaved.userId, viewer.id))).returning();
	if (del.length === 0) await db.insert(chatSaved).values({ messageId: id, userId: viewer.id }).onConflictDoNothing();
	await publish([viewer.id], { type: 'message.updated', channelId: m.channelId, messageId: id });
	return { ok: true };
}

export async function listPinned(viewer: SessionUser, channelId: string) {
	if (!(await membership(channelId, viewer.id))) return [];
	const rows = await db
		.select()
		.from(chatMessages)
		.where(and(eq(chatMessages.channelId, channelId), sql`${chatMessages.pinnedAt} is not null`, isNull(chatMessages.deletedAt), visibleToViewer(viewer.id)))
		.orderBy(desc(chatMessages.pinnedAt))
		.limit(50);
	return serialize(viewer, rows);
}

export async function listSaved(viewer: SessionUser) {
	const rows = await db
		.select({ m: chatMessages })
		.from(chatSaved)
		.innerJoin(chatMessages, eq(chatMessages.id, chatSaved.messageId))
		.innerJoin(chatMembers, and(eq(chatMembers.channelId, chatMessages.channelId), eq(chatMembers.userId, viewer.id)))
		.where(eq(chatSaved.userId, viewer.id))
		.orderBy(desc(chatSaved.createdAt))
		.limit(100);
	return serialize(viewer, rows.map((r) => r.m));
}

/** Full-text search over conversations you are in. */
export async function search(viewer: SessionUser, q: string) {
	const text = q.trim().slice(0, 100);
	if (text.length < 2) return [];
	const res = await db.execute(sql`
		select msg.id from chat_messages msg
		join chat_members m on m.channel_id = msg.channel_id and m.user_id = ${viewer.id}
		where msg.deleted_at is null and msg.hidden_at is null
			and (msg.visible_to is null or msg.visible_to = ${viewer.id})
			and (to_tsvector('simple', msg.body) @@ plainto_tsquery('simple', ${text}) or msg.body ilike ${'%' + text.replace(/[%_]/g, '') + '%'})
		order by msg.created_at desc limit 40
	`);
	return getMessages(viewer, (res.rows as { id: string }[]).map((r) => r.id));
}

/* ---------- reports and moderation ---------- */

export async function reportMessage(viewer: SessionUser, id: string, reason: string): Promise<Done> {
	const m = await own(viewer, id);
	if (!m) return { ok: false, message: 'That message is not in your conversations' };
	const why = reason.trim().slice(0, 500);
	if (!why) return { ok: false, message: 'Say briefly what is wrong with it' };
	const [r] = await db.insert(chatReports).values({ messageId: id, reportedBy: viewer.id, reason: why }).returning();
	const mods = await db
		.select({ id: users.id })
		.from(users)
		.where(and(eq(users.isActive, true), inArray(users.role, ['admin', 'super_admin']), notHidden));
	const { postToFeed } = await import('./cards');
	for (const mod of mods) {
		if (mod.id === m.authorId) continue;
		await postToFeed(mod.id, `A message was reported: "${why}"`, { type: 'report', reportId: r.id, messageId: id, reason: why });
	}
	await logActivity({ actorUserId: viewer.id, action: 'chat.report', targetType: 'chat_message', targetId: id, details: { reason: why } });
	return { ok: true };
}

export async function moderate(viewer: SessionUser, reportId: string, decision: 'hide' | 'dismiss'): Promise<Done> {
	if (!hasCap(viewer, 'chat.moderate')) return { ok: false, message: 'Only HR can act on reports' };
	const [r] = await db.select().from(chatReports).where(eq(chatReports.id, reportId)).limit(1);
	if (!r) return { ok: false, message: 'That report no longer exists' };
	await db.update(chatReports).set({ status: decision === 'hide' ? 'hidden' : 'dismissed', decidedBy: viewer.id, decidedAt: new Date() }).where(eq(chatReports.id, reportId));
	const [m] = await db.select().from(chatMessages).where(eq(chatMessages.id, r.messageId)).limit(1);
	if (decision === 'hide' && m) {
		await db.update(chatMessages).set({ hiddenAt: new Date(), hiddenBy: viewer.id }).where(eq(chatMessages.id, m.id));
		await changed(m);
	}
	await logActivity({ actorUserId: viewer.id, action: `chat.report_${decision}`, targetType: 'chat_message', targetId: r.messageId, details: { reportId } });
	return { ok: true };
}

/** A reported message as moderators see it, even when they are not in the conversation. */
export async function reportView(viewer: SessionUser, reportId: string) {
	if (!hasCap(viewer, 'chat.moderate')) return null;
	const [r] = await db.select().from(chatReports).where(eq(chatReports.id, reportId)).limit(1);
	if (!r) return null;
	const [m] = await db.select().from(chatMessages).where(eq(chatMessages.id, r.messageId)).limit(1);
	const [author] = m?.authorId ? await db.select({ fullName: users.fullName }).from(users).where(eq(users.id, m.authorId)).limit(1) : [];
	return { status: r.status, reason: r.reason, body: m?.body ?? '', author: author?.fullName ?? 'ESS', hidden: !!m?.hiddenAt };
}

/* ---------- polls and to-dos ---------- */

export async function votePoll(viewer: SessionUser, id: string, option: number): Promise<Done> {
	const m = await own(viewer, id);
	const card = m?.card as CardRef | null;
	if (!m || card?.type !== 'poll') return { ok: false, message: 'That poll no longer exists' };
	if (!Number.isInteger(option) || option < 0 || option >= card.options.length) return { ok: false, message: 'Pick one of the options' };
	// One vote per person: choosing another option moves it; choosing yours clears it.
	const mine = await db.select().from(chatPollVotes).where(and(eq(chatPollVotes.messageId, id), eq(chatPollVotes.userId, viewer.id)));
	await db.delete(chatPollVotes).where(and(eq(chatPollVotes.messageId, id), eq(chatPollVotes.userId, viewer.id)));
	if (!mine.some((v) => v.optionIndex === option)) await db.insert(chatPollVotes).values({ messageId: id, userId: viewer.id, optionIndex: option });
	await changed(m);
	return { ok: true };
}

export async function listTodos(viewer: SessionUser, channelId: string) {
	if (!(await membership(channelId, viewer.id))) return [];
	return db
		.select({ id: chatTodos.id, text: chatTodos.text, doneAt: chatTodos.doneAt, doneBy: users.fullName, createdAt: chatTodos.createdAt })
		.from(chatTodos)
		.leftJoin(users, eq(users.id, chatTodos.doneBy))
		.where(eq(chatTodos.channelId, channelId))
		.orderBy(chatTodos.doneAt, desc(chatTodos.createdAt))
		.limit(100);
}

export async function addTodo(viewer: SessionUser, channelId: string, text: string): Promise<Done> {
	if (!(await membership(channelId, viewer.id))) return { ok: false, message: 'You are not in this conversation' };
	const t = text.trim().slice(0, 300);
	if (!t) return { ok: false, message: 'Write the to-do after /todo' };
	await db.insert(chatTodos).values({ channelId, text: t, createdBy: viewer.id });
	await publish(await channelMemberIds(channelId), { type: 'todos.changed', channelId });
	return { ok: true };
}

export async function toggleTodo(viewer: SessionUser, todoId: string): Promise<Done> {
	const [t] = await db.select().from(chatTodos).where(eq(chatTodos.id, todoId)).limit(1);
	if (!t || !(await membership(t.channelId, viewer.id))) return { ok: false, message: 'That to-do no longer exists' };
	await db.update(chatTodos).set(t.doneAt ? { doneAt: null, doneBy: null } : { doneAt: new Date(), doneBy: viewer.id }).where(eq(chatTodos.id, todoId));
	await publish(await channelMemberIds(t.channelId), { type: 'todos.changed', channelId: t.channelId });
	return { ok: true };
}

/* ---------- files ---------- */

export const MAX_FILE = 10 * 1024 * 1024;

/** The file's real type from its first bytes; the name and browser label are not trusted. */
export function sniffMime(buf: Buffer, name: string): string | null {
	const b = buf.subarray(0, 12);
	const hex = b.toString('hex');
	if (hex.startsWith('89504e47')) return 'image/png';
	if (hex.startsWith('ffd8ff')) return 'image/jpeg';
	if (hex.startsWith('47494638')) return 'image/gif';
	if (b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
	if (hex.startsWith('25504446')) return 'application/pdf';
	if (hex.startsWith('504b0304')) {
		const ext = name.toLowerCase().split('.').pop();
		if (ext === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
		if (ext === 'xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
		if (ext === 'pptx') return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
		return 'application/zip';
	}
	const ext = name.toLowerCase().split('.').pop();
	if ((ext === 'txt' || ext === 'csv') && !buf.subarray(0, 2048).includes(0)) return ext === 'csv' ? 'text/csv' : 'text/plain';
	return null;
}

export async function storeFile(viewer: SessionUser, file: File) {
	if (file.size > MAX_FILE) return { ok: false as const, message: 'Files can be up to 10 MB' };
	const buf = Buffer.from(await file.arrayBuffer());
	const mime = sniffMime(buf, file.name);
	if (!mime) return { ok: false as const, message: 'Share images, PDFs, Word, Excel, PowerPoint, CSV or text files' };
	const mongo = await getMongo();
	const res = await mongo.collection('chat_files').insertOne({
		filename: file.name.slice(0, 200),
		mimeType: mime,
		fileBase64: buf.toString('base64'),
		byteSize: file.size,
		uploadedBy: viewer.id,
		createdAt: new Date()
	});
	return { ok: true as const, file: { id: res.insertedId.toString(), name: file.name.slice(0, 200), mime, size: file.size } };
}

/** A file, for someone in a conversation where it was shared. */
export async function readFile(viewer: SessionUser, fileId: string) {
	const [m] = await db
		.select({ channelId: chatMessages.channelId })
		.from(chatMessages)
		.innerJoin(chatMembers, and(eq(chatMembers.channelId, chatMessages.channelId), eq(chatMembers.userId, viewer.id)))
		.where(and(eq(chatMessages.fileId, fileId), isNull(chatMessages.deletedAt), isNull(chatMessages.hiddenAt)))
		.limit(1);
	if (!m) return null;
	const { ObjectId } = await import('mongodb');
	if (!ObjectId.isValid(fileId)) return null;
	const mongo = await getMongo();
	return mongo.collection('chat_files').findOne({ _id: new ObjectId(fileId) } as never) as Promise<{ filename: string; mimeType: string; fileBase64: string } | null>;
}

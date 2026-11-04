import { error, json, type RequestEvent } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/postgres';
import { chatChannels, chatMessages, chatPrefs, pushSubscriptions, users } from '$lib/server/db/schema';
import { and, asc, eq } from 'drizzle-orm';
import { hasCap } from '$lib/server/capabilities';
import { getMongo, logActivity } from '$lib/server/db/mongo';
import { publish, kv } from '$lib/server/chat/bus';
import { channelMemberIds, dmCandidates, ensureDesk, loadChatPolicy, membership } from '$lib/server/chat/access';
import { describeDmRule } from '$lib/chat/policy';
import {
	addMembers,
	browseChannels,
	channelMembers,
	createChannel,
	createGroup,
	joinChannel,
	markRead,
	openDm,
	removeMember,
	setDeskStatus,
	setMute,
	sidebarFor
} from '$lib/server/chat/channels';
import {
	addTodo,
	deleteMessage,
	editMessage,
	getMessages,
	listMessages,
	listPinned,
	listSaved,
	listTodos,
	moderate,
	readFile,
	reportMessage,
	reportView,
	search,
	sendMessage,
	storeFile,
	toggleReaction,
	togglePin,
	toggleSave,
	toggleTodo,
	votePoll
} from '$lib/server/chat/messages';
import { runCommand } from '$lib/server/chat/commands';
import { heartbeat, presenceFor } from '$lib/server/chat/presence';
import { postToFeed } from '$lib/server/chat/cards';
import { vapidKeys } from '$lib/server/chat/notify';

/**
 * Every Champ Chat action behind one route, dispatched on the path — the
 * endpoints are small and share their checks, and one file keeps the whole
 * surface readable in one place. The live stream is /api/chat/stream.
 *
 * All answers are JSON. Failures carry { message } in plain words.
 */

const UUID = /^[0-9a-f-]{36}$/i;

function me(event: RequestEvent) {
	const user = event.locals.user;
	if (!user) throw error(401, 'Sign in again to continue');
	return user;
}

const id = (v: string | undefined) => {
	if (!v || !UUID.test(v)) throw error(400, 'That is not a valid id');
	return v;
};

const send = (r: { ok: boolean } & Record<string, unknown>) =>
	r.ok ? json(r) : json({ message: r.message, ...(r.needsConfirm ? { needsConfirm: r.needsConfirm } : {}) }, { status: 400 });

async function body(event: RequestEvent): Promise<Record<string, unknown>> {
	return (await event.request.json().catch(() => ({}))) ?? {};
}

/** 30 messages a minute per person; Redis if it is up, otherwise not limited. */
async function rateLimited(userId: string, what: string, limit: number) {
	try {
		const key = `chat:rate:${what}:${userId}:${Math.floor(Date.now() / 60_000)}`;
		const n = await kv().incr(key);
		if (n === 1) await kv().expire(key, 70);
		return n > limit;
	} catch {
		return false;
	}
}

export const GET: RequestHandler = async (event) => {
	const user = me(event);
	const [a, b, c] = event.params.path.split('/');
	const q = event.url.searchParams;

	if (a === 'sidebar') return json(await sidebarFor(user));
	if (a === 'people') return json((await dmCandidates(user)).map((p) => ({ id: p.id, fullName: p.fullName, role: p.role, teamId: p.teamId })));
	if (a === 'browse') return json(await browseChannels(user));
	// What the + dialog may offer this person.
	if (a === 'abilities') {
		const policy = await loadChatPolicy();
		return json({ groups: policy.groups === 'everyone' || hasCap(user, 'chat.create_groups'), dmRule: describeDmRule(policy), dmAnyone: hasCap(user, 'chat.dm_anyone') || policy.dm.everyone });
	}
	if (a === 'saved') return json(await listSaved(user));
	if (a === 'search') return json(await search(user, q.get('q') ?? ''));
	if (a === 'messages') return json(await getMessages(user, (q.get('ids') ?? '').split(',').filter((x) => UUID.test(x)).slice(0, 50)));
	if (a === 'presence') {
		const ids = (q.get('ids') ?? '').split(',').filter((x) => UUID.test(x)).slice(0, 300);
		return json(await presenceFor(ids));
	}
	if (a === 'push-key') return json({ key: (await vapidKeys()).publicKey });
	if (a === 'prefs') {
		const [p] = await db.select().from(chatPrefs).where(eq(chatPrefs.userId, user.id)).limit(1);
		return json(p ?? { emailDigest: true, sound: true, celebrations: true, push: true });
	}
	if (a === 'reports' && b) {
		const r = await reportView(user, id(b));
		if (!r) throw error(404, 'That report is not available');
		return json(r);
	}
	if (a === 'files' && b) {
		const f = await readFile(user, b);
		if (!f) throw error(404, 'That file is not available to you');
		const inline = /^image\//.test(f.mimeType) || f.mimeType === 'application/pdf';
		return new Response(Buffer.from(f.fileBase64, 'base64'), {
			headers: {
				'Content-Type': f.mimeType,
				'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${f.filename.replace(/["\\\r\n]/g, '')}"`,
				'X-Content-Type-Options': 'nosniff',
				'Cache-Control': 'private, max-age=3600'
			}
		});
	}
	if (a === 'channels' && b) {
		const cid = id(b);
		if (c === 'messages') {
			const r = await listMessages(user, cid, { before: q.get('before') ?? undefined, threadRootId: q.get('thread') ?? undefined });
			if (!r.ok) throw error(403, r.message);
			return json(r);
		}
		if (!(await membership(cid, user.id))) throw error(403, 'You are not in this conversation');
		if (c === 'members') return json(await channelMembers(cid));
		if (c === 'pinned') return json(await listPinned(user, cid));
		if (c === 'todos') return json(await listTodos(user, cid));
		if (c === 'export') return exportConversation(event, cid);
	}
	throw error(404, 'Not found');
};

export const POST: RequestHandler = async (event) => {
	const user = me(event);
	const [a, b, c] = event.params.path.split('/');

	if (a === 'files') {
		if (await rateLimited(user.id, 'file', 5)) throw error(429, 'That is a lot of files at once. Wait a minute and try again.');
		const form = await event.request.formData();
		const file = form.get('file');
		if (!(file instanceof File) || file.size === 0) throw error(400, 'Choose a file');
		return send(await storeFile(user, file));
	}

	const data = await body(event);

	if (a === 'messages' && !b) {
		if (await rateLimited(user.id, 'msg', 30)) throw error(429, 'You are sending messages very quickly. Wait a moment.');
		const channelId = id(String(data.channelId));
		const text = String(data.body ?? '');
		const threadRootId = data.threadRootId ? id(String(data.threadRootId)) : null;
		if (text.trim().startsWith('/') && !data.file) {
			const mentionIds = Array.isArray(data.mentions) ? data.mentions.map(String).filter((x) => UUID.test(x)) : [];
			const r = await runCommand(user, channelId, text, threadRootId, mentionIds);
			if (r) return send(r);
		}
		let file = null;
		if (data.file && typeof data.file === 'object') {
			const f = data.file as { id: string; name: string; mime: string; size: number };
			// Only a file you uploaded yourself can be attached.
			const { ObjectId } = await import('mongodb');
			if (!ObjectId.isValid(f.id)) throw error(400, 'That file is not available');
			const stored = await (await getMongo()).collection('chat_files').findOne({ _id: new ObjectId(f.id), uploadedBy: user.id } as never);
			if (!stored) throw error(400, 'That file is not available');
			const meta = stored as unknown as { filename: string; mimeType: string; byteSize: number };
			file = { id: f.id, name: meta.filename, mime: meta.mimeType, size: meta.byteSize };
		}
		return send(
			await sendMessage(user, {
				channelId,
				body: text,
				threadRootId,
				mentions: Array.isArray(data.mentions) ? data.mentions.map(String).filter((x) => UUID.test(x)) : [],
				mentionAll: !!data.mentionAll,
				confirmSensitive: !!data.confirmSensitive,
				file
			})
		);
	}

	if (a === 'messages' && b) {
		const mid = id(b);
		if (c === 'react') return send(await toggleReaction(user, mid, String(data.emoji ?? '')));
		if (c === 'pin') return send(await togglePin(user, mid));
		if (c === 'save') return send(await toggleSave(user, mid));
		if (c === 'report') return send(await reportMessage(user, mid, String(data.reason ?? '')));
		if (c === 'vote') return send(await votePoll(user, mid, Number(data.option)));
	}

	if (a === 'reports' && b) return send(await moderate(user, id(b), data.decision === 'hide' ? 'hide' : 'dismiss'));

	if (a === 'read') {
		await markRead(user, id(String(data.channelId)));
		return json({ ok: true });
	}
	if (a === 'typing') {
		const cid = id(String(data.channelId));
		if (!(await membership(cid, user.id))) return json({ ok: false });
		const others = (await channelMemberIds(cid)).filter((x) => x !== user.id);
		await publish(others, { type: 'typing', channelId: cid, userId: user.id, name: user.fullName, threadRootId: data.threadRootId ?? null });
		return json({ ok: true });
	}
	if (a === 'presence') {
		await heartbeat(user.id);
		return json({ ok: true });
	}

	if (a === 'dm') return send(await openDm(user, id(String(data.userId))));
	if (a === 'groups') return send(await createGroup(user, Array.isArray(data.memberIds) ? data.memberIds.map(String) : [], String(data.name ?? '')));
	if (a === 'desk') {
		const d = await ensureDesk(user.id);
		return json({ ok: true, id: d.id });
	}
	if (a === 'channels' && !b) {
		return send(
			await createChannel(user, {
				name: String(data.name ?? ''),
				topic: String(data.topic ?? ''),
				isPrivate: !!data.isPrivate,
				memberIds: Array.isArray(data.memberIds) ? data.memberIds.map(String) : []
			})
		);
	}
	if (a === 'channels' && b) {
		const cid = id(b);
		if (c === 'join') return send(await joinChannel(user, cid));
		if (c === 'leave') return send(await removeMember(user, cid, user.id));
		if (c === 'members') {
			if (data.remove) return send(await removeMember(user, cid, id(String(data.remove))));
			return send(await addMembers(user, cid, Array.isArray(data.add) ? data.add.map(String) : []));
		}
		if (c === 'mute') {
			await setMute(user, cid, !!data.muted, typeof data.notify === 'string' ? data.notify : undefined);
			return json({ ok: true });
		}
		if (c === 'desk') return send(await setDeskStatus(user, cid, data.status === 'resolved' ? 'resolved' : 'open'));
		if (c === 'todos') return send(await addTodo(user, cid, String(data.text ?? '')));
	}
	if (a === 'todos' && b) return send(await toggleTodo(user, id(b)));

	if (a === 'push') {
		const sub = data.subscription as { endpoint?: string; keys?: { p256dh?: string; auth?: string } } | undefined;
		if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) throw error(400, 'Not a push subscription');
		await db
			.insert(pushSubscriptions)
			.values({ userId: user.id, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth })
			.onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: { userId: user.id, p256dh: sub.keys.p256dh, auth: sub.keys.auth } });
		return json({ ok: true });
	}
	if (a === 'prefs') {
		const values = {
			emailDigest: data.emailDigest !== false,
			sound: data.sound !== false,
			celebrations: data.celebrations !== false,
			push: data.push !== false,
			updatedAt: new Date()
		};
		await db.insert(chatPrefs).values({ userId: user.id, ...values }).onConflictDoUpdate({ target: chatPrefs.userId, set: values });
		return json({ ok: true });
	}

	throw error(404, 'Not found');
};

export const PATCH: RequestHandler = async (event) => {
	const user = me(event);
	const [a, b] = event.params.path.split('/');
	if (a === 'messages' && b) return send(await editMessage(user, id(b), String((await body(event)).body ?? '')));
	throw error(404, 'Not found');
};

export const DELETE: RequestHandler = async (event) => {
	const user = me(event);
	const [a, b] = event.params.path.split('/');
	if (a === 'messages' && b) return send(await deleteMessage(user, id(b)));
	if (a === 'push') {
		const { endpoint } = await body(event);
		if (typeof endpoint === 'string') await db.delete(pushSubscriptions).where(and(eq(pushSubscriptions.endpoint, endpoint), eq(pushSubscriptions.userId, user.id)));
		return json({ ok: true });
	}
	throw error(404, 'Not found');
};

/**
 * One conversation, exported for a formal complaint. Super Admin only, needs
 * a written reason, is recorded in the activity log, and tells every member
 * that it happened — there is no quiet way to read someone's messages.
 */
async function exportConversation(event: RequestEvent, channelId: string) {
	const user = me(event);
	if (!hasCap(user, 'chat.export')) throw error(403, 'Only a Super Admin can export a conversation');
	const reason = (event.url.searchParams.get('reason') ?? '').trim();
	if (reason.length < 10) throw error(400, 'Give the reason for the export, at least 10 characters');
	const [c] = await db.select().from(chatChannels).where(eq(chatChannels.id, channelId)).limit(1);
	if (!c) throw error(404, 'That conversation no longer exists');
	const rows = await db
		.select({ at: chatMessages.createdAt, body: chatMessages.body, name: users.fullName, deleted: chatMessages.deletedAt, thread: chatMessages.threadRootId })
		.from(chatMessages)
		.leftJoin(users, eq(users.id, chatMessages.authorId))
		.where(eq(chatMessages.channelId, channelId))
		.orderBy(asc(chatMessages.createdAt));
	const csvCell = (s: string) => `"${s.replace(/"/g, '""')}"`;
	const csv = ['When (IST),From,Message,Note', ...rows.map((r) => [r.at.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }), r.name ?? 'ESS', r.body, r.deleted ? 'deleted by author' : r.thread ? 'thread reply' : ''].map(csvCell).join(','))].join('\r\n');
	await logActivity({ actorUserId: user.id, action: 'chat.export', targetType: 'chat_channel', targetId: channelId, details: { reason, messages: rows.length, kind: c.kind } });
	for (const member of await channelMemberIds(channelId)) {
		if (member === user.id) continue;
		await postToFeed(member, `A Super Admin exported a conversation you are in, for a formal complaint.`, {
			type: 'notice',
			tone: 'warn',
			title: 'A conversation was exported',
			text: `Reason recorded: "${reason}". This is kept in the activity log.`
		});
	}
	return new Response(csv, {
		headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="conversation-${channelId.slice(0, 8)}.csv"` }
	});
}

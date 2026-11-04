import webpush from 'web-push';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db/postgres';
import {
	appSettings,
	chatCelebrations,
	chatChannels,
	chatMembers,
	chatMessages,
	chatPrefs,
	chatReminders,
	employeeProfiles,
	pushSubscriptions,
	users
} from '$lib/server/db/schema';
import { and, eq, inArray, isNull, lt, lte, sql } from 'drizzle-orm';
import { isMailerConfigured, sendEmail } from '$lib/server/mailer';
import { getMongo } from '$lib/server/db/mongo';
import { istDateKey } from '$lib/chat/rules';
import { hasLocalStream, publish } from './bus';
import { notHidden } from '$lib/server/hidden-users';
import { onlineSet, workStatuses } from './presence';

/**
 * Getting someone's attention, fairly.
 *
 *   An open ESS tab     the stream gets a "notify" event; the page shows a
 *                       browser pop-up if the tab is in the background.
 *   Portal closed       web push to their devices (service worker).
 *   Still unread later  an email digest: DMs after 2 h, mentions after 4 h.
 *
 * Outside someone's shift, on leave, week off or a holiday, pings wait —
 * the message still arrives, only the alert is held — unless it is urgent
 * (an Urgent announcement, or a manager's DM marked urgent).
 */

export type Notice = { title: string; body: string; url: string; urgent?: boolean; kind: 'dm' | 'mention' | 'system' | 'desk' | 'reminder' };

/* ---------- web push keys ---------- */

let vapid: { publicKey: string; privateKey: string } | null = null;

/** The VAPID keys, from the environment or generated once and kept in app_settings. */
export async function vapidKeys() {
	if (vapid) return vapid;
	if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
		vapid = { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
	} else {
		const [row] = await db.select().from(appSettings).where(eq(appSettings.key, 'vapid')).limit(1);
		if (row) vapid = row.value as unknown as typeof vapid;
		else {
			const keys = webpush.generateVAPIDKeys();
			await db.insert(appSettings).values({ key: 'vapid', value: keys }).onConflictDoNothing();
			const [again] = await db.select().from(appSettings).where(eq(appSettings.key, 'vapid')).limit(1);
			vapid = (again?.value ?? keys) as unknown as typeof vapid;
		}
	}
	webpush.setVapidDetails(`mailto:${env.RESEND_FROM?.match(/<(.+)>/)?.[1] ?? 'hr@champ-hr.com'}`, vapid!.publicKey, vapid!.privateKey);
	return vapid!;
}

async function pushTo(userId: string, notice: Notice) {
	const subs = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
	if (subs.length === 0) return;
	await vapidKeys();
	const payload = JSON.stringify({ title: notice.title, body: notice.body.slice(0, 180), url: notice.url, tag: notice.kind });
	for (const s of subs) {
		try {
			await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 3600 });
		} catch (err) {
			const code = (err as { statusCode?: number }).statusCode;
			// Gone or not found: the browser dropped this subscription.
			if (code === 404 || code === 410) await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, s.id));
		}
	}
}

/** Alert people about something new, respecting their hours and settings. */
export async function deliverNotification(userIds: string[], notice: Notice) {
	const ids = [...new Set(userIds)];
	if (ids.length === 0) return;
	const [work, online, prefs] = await Promise.all([
		workStatuses(),
		onlineSet(ids),
		db.select().from(chatPrefs).where(inArray(chatPrefs.userId, ids))
	]);
	const prefBy = new Map(prefs.map((p) => [p.userId, p]));
	for (const id of ids) {
		const quiet = !notice.urgent && (work.get(id)?.quiet ?? false);
		const pref = prefBy.get(id);
		await publish([id], { type: 'notify', ...notice, quiet, sound: pref?.sound ?? true });
		if (quiet || pref?.push === false) continue;
		// A tab open anywhere shows the pop-up itself; push is for a closed portal.
		if (online.has(id) || hasLocalStream(id)) continue;
		void pushTo(id, notice).catch(() => {});
	}
}

/* ---------- email digest ---------- */

/**
 * Emails a short digest to people with DMs unread for 2 hours or mentions
 * unread for 4 hours, once per conversation per batch of new messages, and
 * only inside their working hours.
 */
export async function sendDigests(now = new Date()) {
	if (!isMailerConfigured()) return;
	const rows = await db.execute(sql`
		select m.user_id as "userId", m.channel_id as "channelId", c.kind, c.name,
			count(*)::int as n, max(msg.created_at) as latest,
			string_agg(coalesce(a.full_name, 'ESS') || ': ' || left(msg.body, 120), E'\n' order by msg.created_at desc) as preview
		from chat_members m
		join chat_channels c on c.id = m.channel_id
		join chat_messages msg on msg.channel_id = m.channel_id
		left join users a on a.id = msg.author_id
		left join chat_prefs p on p.user_id = m.user_id
		where msg.created_at > m.last_read_at
			and (m.last_digest_at is null or msg.created_at > m.last_digest_at)
			and msg.deleted_at is null and msg.thread_root_id is null
			and (msg.author_id is null or msg.author_id <> m.user_id)
			and (msg.visible_to is null or msg.visible_to = m.user_id)
			and coalesce(p.email_digest, true)
			and (m.muted_until is null or m.muted_until < now())
			and (
				(c.kind in ('dm', 'group', 'desk') and msg.created_at < now() - interval '2 hours')
				or (c.kind = 'channel' and (m.user_id = any(msg.mentions) or msg.mentions_all) and msg.created_at < now() - interval '4 hours')
			)
		group by m.user_id, m.channel_id, c.kind, c.name
	`);
	const items = rows.rows as { userId: string; channelId: string; kind: string; name: string; n: number; latest: Date; preview: string }[];
	if (items.length === 0) return;
	const work = await workStatuses(now);
	const byUser = new Map<string, typeof items>();
	for (const it of items) {
		if (work.get(it.userId)?.quiet) continue;
		(byUser.get(it.userId) ?? byUser.set(it.userId, []).get(it.userId)!).push(it);
	}
	const people = byUser.size
		? await db.select({ id: users.id, email: users.email, fullName: users.fullName }).from(users).where(inArray(users.id, [...byUser.keys()]))
		: [];
	const portal = (env.PORTAL_URL || env.ORIGIN || 'https://champ-hr.com').replace(/\/+$/, '');
	for (const person of people) {
		const list = byUser.get(person.id)!;
		const total = list.reduce((s, x) => s + x.n, 0);
		const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
		const html = `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#1c2036;max-width:560px">
<p>Hi ${esc(person.fullName.split(' ')[0])}, you have ${total} unread ${total === 1 ? 'message' : 'messages'} in Champ Chat.</p>
${list.map((x) => `<p style="margin:12px 0 4px"><b>${x.kind === 'channel' ? '#' + esc(x.name) : x.kind === 'desk' ? 'Ask HR' : 'Direct message'}</b> · ${x.n} new</p><pre style="font-family:inherit;white-space:pre-wrap;margin:0;color:#555">${esc(x.preview.split('\n').slice(0, 3).join('\n'))}</pre>`).join('')}
<p style="margin-top:16px"><a href="${portal}/chat" style="color:#4054c8">Open Champ Chat</a></p>
<p style="color:#888;font-size:12px">You can turn these emails off in Champ Chat settings.</p></div>`;
		const res = await sendEmail({
			to: person.email,
			subject: `${total} unread in Champ Chat`,
			html,
			text: `You have ${total} unread messages in Champ Chat. Open ${portal}/chat`
		});
		if (res.ok) {
			for (const x of list) {
				await db.update(chatMembers).set({ lastDigestAt: now }).where(and(eq(chatMembers.userId, person.id), eq(chatMembers.channelId, x.channelId)));
			}
		}
	}
}

/* ---------- reminders ---------- */

export async function fireReminders(now = new Date()) {
	const due = await db.select().from(chatReminders).where(and(isNull(chatReminders.sentAt), lte(chatReminders.remindAt, now))).limit(100);
	if (due.length === 0) return;
	const { postToFeed } = await import('./cards');
	for (const r of due) {
		const [claimed] = await db.update(chatReminders).set({ sentAt: now }).where(and(eq(chatReminders.id, r.id), isNull(chatReminders.sentAt))).returning();
		if (!claimed) continue;
		await postToFeed(r.userId, `Reminder: ${r.text || 'you asked me to remind you'}`, { type: 'reminder', text: r.text, channelId: r.channelId }, { urgent: false });
	}
}

/* ---------- celebrations ---------- */

/**
 * Birthdays and work anniversaries, posted once each morning in the person's
 * team channel (or #general without a team), unless they opted out.
 */
export async function postCelebrations(now = new Date()) {
	const today = istDateKey(now);
	const md = today.slice(5);
	const rows = await db
		.select({
			id: users.id,
			fullName: users.fullName,
			teamId: users.teamId,
			dob: sql<string | null>`coalesce(${employeeProfiles.dobActual}, ${employeeProfiles.dobDocuments})::text`,
			doj: sql<string | null>`${employeeProfiles.dateOfJoining}::text`,
			opted: chatPrefs.celebrations
		})
		.from(users)
		.innerJoin(employeeProfiles, eq(employeeProfiles.userId, users.id))
		.leftJoin(chatPrefs, eq(chatPrefs.userId, users.id))
		.where(and(eq(users.isActive, true), notHidden));
	const { postToChannel } = await import('./messages');
	for (const p of rows) {
		if (p.opted === false) continue;
		const events: { kind: 'birthday' | 'anniversary'; years?: number }[] = [];
		if (p.dob?.slice(5) === md) events.push({ kind: 'birthday' });
		if (p.doj && p.doj.slice(5) === md && p.doj.slice(0, 4) < today.slice(0, 4)) {
			events.push({ kind: 'anniversary', years: Number(today.slice(0, 4)) - Number(p.doj.slice(0, 4)) });
		}
		for (const e of events) {
			const [fresh] = await db.insert(chatCelebrations).values({ userId: p.id, kind: e.kind, onDate: today }).onConflictDoNothing().returning();
			if (!fresh) continue;
			const key = p.teamId ? `team:${p.teamId}` : 'everyone';
			const [ch] = await db.select({ id: chatChannels.id }).from(chatChannels).where(eq(chatChannels.uniqueKey, key)).limit(1);
			if (!ch) continue;
			const first = p.fullName.split(' ')[0];
			const body = e.kind === 'birthday' ? `🎂 Happy birthday, ${first}!` : `🎉 ${first} completes ${e.years} ${e.years === 1 ? 'year' : 'years'} with us today.`;
			await postToChannel(ch.id, body, { type: 'celebration', kind: e.kind, userId: p.id, name: p.fullName, years: e.years });
		}
	}
}

/* ---------- retention ---------- */

/** Messages and their files are kept for six months, then deleted. */
export const RETENTION_DAYS = 183;

export async function applyRetention(now = new Date()) {
	const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86_400_000);
	const old = await db
		.select({ id: chatMessages.id, fileId: chatMessages.fileId })
		.from(chatMessages)
		.where(lt(chatMessages.createdAt, cutoff))
		.limit(5000);
	if (old.length === 0) return 0;
	const fileIds = old.map((o) => o.fileId).filter(Boolean) as string[];
	if (fileIds.length) {
		const { ObjectId } = await import('mongodb');
		const mongo = await getMongo();
		await mongo.collection('chat_files').deleteMany({ _id: { $in: fileIds.filter((f) => ObjectId.isValid(f)).map((f) => new ObjectId(f)) } } as never);
	}
	await db.delete(chatMessages).where(inArray(chatMessages.id, old.map((o) => o.id)));
	return old.length;
}

import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db/postgres';
import {
	announcementReads,
	announcements,
	employeeProfiles,
	holidayCalendars,
	holidays,
	users
} from '$lib/server/db/schema';
import { and, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { sendEmail, isMailerConfigured } from '$lib/server/mailer';
import { badgeFor, buildFeed, istDate, summaryOf, type Feed, type FeedHoliday, type FeedPost } from '$lib/announcements';
import { notHidden } from '$lib/server/hidden-users';

type Announcement = typeof announcements.$inferSelect;

/** What decides whether a post is meant for someone: their team and shift group. */
export type Viewer = { id: string; teamId: string | null; shiftGroupId: string | null };

export async function loadViewer(userId: string): Promise<Viewer> {
	const [row] = await db
		.select({ id: users.id, teamId: users.teamId, shiftGroupId: employeeProfiles.shiftGroupId })
		.from(users)
		.leftJoin(employeeProfiles, eq(employeeProfiles.userId, users.id))
		.where(eq(users.id, userId))
		.limit(1);
	return row ?? { id: userId, teamId: null, shiftGroupId: null };
}

/** The same rule as `audienceSql`, for rows already in memory. */
export function inAudience(
	post: Pick<Announcement, 'audienceAll' | 'audienceTeamIds' | 'audienceShiftGroupIds'>,
	person: { teamId: string | null; shiftGroupId: string | null }
): boolean {
	return (
		post.audienceAll ||
		(!!person.teamId && post.audienceTeamIds.includes(person.teamId)) ||
		(!!person.shiftGroupId && post.audienceShiftGroupIds.includes(person.shiftGroupId))
	);
}

function audienceSql(v: Viewer) {
	return or(
		eq(announcements.audienceAll, true),
		v.teamId ? sql`${v.teamId}::uuid = any(${announcements.audienceTeamIds})` : undefined,
		v.shiftGroupId ? sql`${v.shiftGroupId}::uuid = any(${announcements.audienceShiftGroupIds})` : undefined
	);
}

/** Live now: published and past its publish time. */
function liveSql(now: Date) {
	return and(eq(announcements.status, 'published'), lte(announcements.publishAt, now));
}

/**
 * Everything one person should see. Old posts fall out after 120 days unless
 * they are still waiting for that person's confirmation — the one case where
 * age does not settle it.
 */
async function loadFeedPosts(v: Viewer, now: Date): Promise<FeedPost[]> {
	const cutoff = new Date(now.getTime() - 120 * 86_400_000);
	const rows = await db
		.select({
			a: announcements,
			authorName: users.fullName,
			readAt: announcementReads.readAt,
			acknowledgedAt: announcementReads.acknowledgedAt,
			dismissedAt: announcementReads.dismissedAt
		})
		.from(announcements)
		.leftJoin(
			announcementReads,
			and(eq(announcementReads.announcementId, announcements.id), eq(announcementReads.userId, v.id))
		)
		.leftJoin(users, eq(users.id, announcements.createdBy))
		.where(
			and(
				liveSql(now),
				audienceSql(v),
				or(
					gte(announcements.publishAt, cutoff),
					gte(announcements.eventDate, istDate(now)),
					and(eq(announcements.requiresAck, true), isNull(announcementReads.acknowledgedAt))
				)
			)
		)
		.orderBy(desc(announcements.publishAt));

	return rows.map(({ a, authorName, readAt, acknowledgedAt, dismissedAt }) => ({
		id: a.id,
		kind: a.kind,
		title: a.title,
		summary: a.summary,
		body: a.body,
		eventDate: a.eventDate,
		eventTime: a.eventTime,
		requiresAck: a.requiresAck,
		urgentDays: a.urgentDays,
		attachmentName: a.attachmentName,
		publishAt: a.publishAt!.toISOString(),
		editedAt: a.editedAt?.toISOString() ?? null,
		authorName,
		read: !!readAt,
		acknowledged: !!acknowledgedAt,
		dismissed: !!dismissedAt
	}));
}

/**
 * The next two months of holidays from the published calendar for the
 * person's own shift group — HR never has to post these.
 */
async function loadHolidays(v: Viewer, now: Date): Promise<FeedHoliday[]> {
	if (!v.shiftGroupId) return [];
	const today = istDate(now);
	const until = istDate(new Date(now.getTime() + 60 * 86_400_000));
	const rows = await db
		.select({ id: holidays.id, name: holidays.name, date: holidays.date })
		.from(holidays)
		.innerJoin(holidayCalendars, eq(holidayCalendars.id, holidays.calendarId))
		.where(
			and(
				eq(holidayCalendars.shiftGroupId, v.shiftGroupId),
				eq(holidayCalendars.status, 'published'),
				gte(holidays.date, today),
				lte(holidays.date, until)
			)
		)
		.orderBy(holidays.date);
	// Two published versions of one calendar would list a holiday twice.
	const seen = new Set<string>();
	return rows
		.filter((r) => !seen.has(r.date + r.name) && seen.add(r.date + r.name))
		.map((r) => ({ id: `holiday-${r.id}`, kind: 'holiday' as const, title: r.name, eventDate: r.date }));
}

export async function loadFeed(userId: string, now = new Date()): Promise<Feed> {
	const v = await loadViewer(userId);
	const [posts, hols] = await Promise.all([loadFeedPosts(v, now), loadHolidays(v, now)]);
	return buildFeed(posts, hols, now);
}

export async function loadBadge(userId: string, now = new Date()) {
	const v = await loadViewer(userId);
	const posts = await loadFeedPosts(v, now);
	return badgeFor(buildFeed(posts, [], now), now);
}

/** A live post this person may open, or null. Admins may open any post. */
export async function findVisible(userId: string, isAdmin: boolean, id: string, now = new Date()) {
	if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
	const [row] = await db.select().from(announcements).where(eq(announcements.id, id)).limit(1);
	if (!row) return null;
	if (isAdmin) return row;
	if (row.status !== 'published' || !row.publishAt || row.publishAt > now) return null;
	return inAudience(row, await loadViewer(userId)) ? row : null;
}

type ReadAction = 'read' | 'ack' | 'dismiss';

/** Records that someone opened, confirmed or dismissed a post. Idempotent. */
export async function recordRead(announcementId: string, userId: string, action: ReadAction) {
	const now = new Date();
	const set =
		action === 'ack' ? { acknowledgedAt: now } : action === 'dismiss' ? { dismissedAt: now } : {};
	await db
		.insert(announcementReads)
		.values({ announcementId, userId, readAt: now, ...set })
		.onConflictDoUpdate({
			target: [announcementReads.announcementId, announcementReads.userId],
			// First read time is kept; confirm/dismiss are stamped once.
			set:
				action === 'ack'
					? { acknowledgedAt: sql`coalesce(${announcementReads.acknowledgedAt}, now())` }
					: action === 'dismiss'
						? { dismissedAt: sql`coalesce(${announcementReads.dismissedAt}, now())` }
						: { readAt: sql`${announcementReads.readAt}` }
		});
}

export async function recordReadMany(ids: string[], userId: string) {
	if (ids.length === 0) return;
	await db
		.insert(announcementReads)
		.values(ids.map((announcementId) => ({ announcementId, userId })))
		.onConflictDoNothing();
}

/* ---------- HR side ---------- */

export type Member = { id: string; fullName: string; email: string; teamId: string | null; shiftGroupId: string | null };

/** Every active person, with what audience targeting needs to know. */
export async function loadMembers(): Promise<Member[]> {
	return db
		.select({
			id: users.id,
			fullName: users.fullName,
			email: users.email,
			teamId: users.teamId,
			shiftGroupId: employeeProfiles.shiftGroupId
		})
		.from(users)
		.leftJoin(employeeProfiles, eq(employeeProfiles.userId, users.id))
		.where(and(eq(users.isActive, true), notHidden));
}

export async function loadAdminList() {
	const counts = db
		.select({
			announcementId: announcementReads.announcementId,
			reads: sql<number>`count(*)::int`.as('reads'),
			acks: sql<number>`count(${announcementReads.acknowledgedAt})::int`.as('acks')
		})
		.from(announcementReads)
		.innerJoin(users, eq(users.id, announcementReads.userId))
		.where(notHidden)
		.groupBy(announcementReads.announcementId)
		.as('counts');

	return db
		.select({ a: announcements, reads: counts.reads, acks: counts.acks })
		.from(announcements)
		.leftJoin(counts, eq(counts.announcementId, announcements.id))
		.orderBy(desc(sql`coalesce(${announcements.publishAt}, ${announcements.createdAt})`))
		.limit(100);
}

/** Who a post asks to confirm but hasn't, and whether they have opened it. */
export async function loadPendingConfirmations(id: string) {
	const [post] = await db.select().from(announcements).where(eq(announcements.id, id)).limit(1);
	if (!post) return null;
	const members = (await loadMembers()).filter((m) => inAudience(post, m));
	const reads = await db
		.select({ userId: announcementReads.userId, acknowledgedAt: announcementReads.acknowledgedAt })
		.from(announcementReads)
		.where(eq(announcementReads.announcementId, id));
	const byUser = new Map(reads.map((r) => [r.userId, r]));
	const pending = members
		.filter((m) => !byUser.get(m.id)?.acknowledgedAt)
		.map((m) => ({ id: m.id, fullName: m.fullName, email: m.email, opened: byUser.has(m.id) }))
		.sort((a, b) => Number(a.opened) - Number(b.opened) || a.fullName.localeCompare(b.fullName));
	return { post, audience: members.length, pending };
}

/* ---------- email ---------- */

function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function portalUrl(): string {
	return (env.PORTAL_URL || env.ORIGIN || 'https://champ-hr.com').replace(/\/+$/, '');
}

function buildEmail(post: Announcement, reminder: boolean) {
	const link = `${portalUrl()}/announcements`;
	const lead = reminder ? 'Reminder: please confirm you have read this.' : null;
	const when = post.kind === 'event' && post.eventDate
		? new Date(post.eventDate + 'T00:00:00Z').toLocaleDateString('en-IN', {
				weekday: 'long',
				day: 'numeric',
				month: 'long',
				timeZone: 'UTC'
			}) + (post.eventTime ? `, ${post.eventTime}` : '')
		: null;
	const subject = `${reminder ? 'Reminder: ' : post.kind === 'urgent' ? 'Urgent: ' : ''}${post.title}`;
	const paragraphs = post.body.trim() ? post.body.trim().split(/\n{2,}/) : [summaryOf(post)];
	const html = `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1c2036;max-width:560px">
${lead ? `<p style="color:#a15b0a;font-weight:600">${escapeHtml(lead)}</p>` : ''}
<h2 style="font-size:20px;margin:0 0 6px">${escapeHtml(post.title)}</h2>
${when ? `<p style="margin:0 0 12px;color:#4054c8;font-weight:600">${escapeHtml(when)}</p>` : ''}
${paragraphs.map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('\n')}
<p><a href="${link}" style="color:#4054c8">Open in the ESS portal</a>${post.requiresAck ? ' to confirm you have read it.' : ''}</p>
</div>`;
	const text = [lead, post.title, when, ...paragraphs, `Open in the ESS portal: ${link}`].filter(Boolean).join('\n\n');
	return { subject, html, text };
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sends one message per person, paced to stay inside the provider's rate limit. */
async function sendToAll(post: Announcement, recipients: Member[], reminder: boolean) {
	const mail = buildEmail(post, reminder);
	let sent = 0;
	let failed = 0;
	for (const r of recipients) {
		const res = await sendEmail({ to: r.email, ...mail });
		if (res.ok) sent++;
		else failed++;
		await pause(550);
	}
	return { sent, failed };
}

/**
 * Sends the email copy of every post that is live, asked for one and has not
 * had it yet. Each post is claimed with a conditional update first, so two
 * overlapping runs (the scheduler and a publish) never send it twice.
 */
export async function dispatchDueEmails(now = new Date()) {
	if (!isMailerConfigured()) return;
	const due = await db
		.select({ id: announcements.id })
		.from(announcements)
		.where(and(liveSql(now), eq(announcements.emailCopy, true), isNull(announcements.emailSentAt)));
	if (due.length === 0) return;

	const members = await loadMembers();
	for (const { id } of due) {
		const [claimed] = await db
			.update(announcements)
			.set({ emailSentAt: new Date() })
			.where(and(eq(announcements.id, id), isNull(announcements.emailSentAt)))
			.returning();
		if (!claimed) continue;
		const result = await sendToAll(claimed, members.filter((m) => inAudience(claimed, m)), false);
		console.log(`[announcements] emailed "${claimed.title}": ${result.sent} sent, ${result.failed} failed`);
	}
}

export async function sendConfirmationReminder(id: string) {
	const found = await loadPendingConfirmations(id);
	if (!found) return { ok: false as const, message: 'That announcement no longer exists.' };
	if (!isMailerConfigured()) {
		return { ok: false as const, message: 'Email is not set up on this server (RESEND_API_KEY), so no reminder was sent.' };
	}
	const members = await loadMembers();
	const pendingIds = new Set(found.pending.map((p) => p.id));
	const recipients = members.filter((m) => pendingIds.has(m.id));
	// Paced sending takes a while for a few hundred people; the page does not wait.
	void sendToAll(found.post, recipients, true).catch((err) => console.error('[announcements] reminder failed:', err));
	return { ok: true as const, count: recipients.length };
}

/**
 * Checks once a minute for scheduled posts whose email copy is now due.
 * Guarded like the ProHance poller against a second start under dev HMR.
 */
export function startAnnouncementScheduler() {
	const g = globalThis as { __announcementScheduler?: ReturnType<typeof setInterval> };
	if (g.__announcementScheduler) return;
	const tick = () =>
		dispatchDueEmails().catch((err) =>
			console.error('[announcements] email dispatch failed:', err instanceof Error ? err.message : err)
		);
	setTimeout(tick, 20_000);
	g.__announcementScheduler = setInterval(tick, 60_000);
}

/** Ids of the live posts a person can see, for "Mark all read". */
export async function visibleIds(userId: string, ids: string[], now = new Date()) {
	if (ids.length === 0) return [];
	const v = await loadViewer(userId);
	const rows = await db
		.select({ id: announcements.id })
		.from(announcements)
		.where(and(inArray(announcements.id, ids), liveSql(now), audienceSql(v)));
	return rows.map((r) => r.id);
}

/**
 * Live posts that asked for confirmation more than three days ago and are
 * still under 80% confirmed — the Admin Controls attention list flags them.
 */
export async function loadStaleConfirmations(now = new Date()) {
	const threeDaysAgo = new Date(now.getTime() - 3 * 86_400_000);
	const rows = await db
		.select()
		.from(announcements)
		.where(and(liveSql(now), eq(announcements.requiresAck, true), lte(announcements.publishAt, threeDaysAgo)));
	if (rows.length === 0) return [];

	const [members, acks] = await Promise.all([
		loadMembers(),
		db
			.select({ id: announcementReads.announcementId, n: sql<number>`count(${announcementReads.acknowledgedAt})::int` })
			.from(announcementReads)
			.innerJoin(users, eq(users.id, announcementReads.userId))
			.where(and(inArray(announcementReads.announcementId, rows.map((r) => r.id)), notHidden))
			.groupBy(announcementReads.announcementId)
	]);
	const ackBy = new Map(acks.map((a) => [a.id, a.n]));
	return rows
		.map((r) => ({
			id: r.id,
			title: r.title,
			confirmed: ackBy.get(r.id) ?? 0,
			audience: members.filter((m) => inAudience(r, m)).length
		}))
		.filter((r) => r.audience > 0 && r.confirmed / r.audience < 0.8);
}

import { db } from '$lib/server/db/postgres';
import { appSettings, customRoles, loginEmails, users } from '$lib/server/db/schema';
import { and, desc, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import type { SessionUser } from '$lib/server/auth';
import { hasCap } from '$lib/server/capabilities';
import { logActivity } from '$lib/server/db/mongo';
import { isMailerConfigured, sendWelcomeEmail } from '$lib/server/mailer';
import { clerkAuthActive } from '$lib/server/clerk';
import { postToFeed } from '$lib/server/chat/cards';
import { notHidden } from '$lib/server/hidden-users';

/**
 * Login emails wait for an admin.
 *
 * Making a login (one at a time, a bulk import, a re-issue, or Champ) never
 * emails the person straight away. It queues their welcome email here as
 * 'pending'. Someone with "Approve login emails" approves (or cancels) it,
 * and approved emails go out one at a time, `cadenceSeconds` apart — one a
 * minute unless an admin changes it. A slow, steady drip also keeps a large
 * import inside the mail provider's rate limits.
 *
 * The temporary password is read from users.temporary_password at the moment
 * of sending, so the email always carries the password that works now, and a
 * person who has already signed in and chosen their own is skipped. While
 * Clerk is the sign-in the email carries no password at all, only how to sign
 * in with the code Clerk emails them.
 */

export type LoginEmailSource = 'single' | 'bulk' | 'reissue' | 'champ';

const SETTINGS_KEY = 'login_email_settings';
export const DEFAULT_CADENCE_SECONDS = 60;
export const MIN_CADENCE_SECONDS = 10;
export const MAX_CADENCE_SECONDS = 24 * 3600;

const looksLikeEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

/* ---------- settings ---------- */

export type LoginEmailSettings = { cadenceSeconds: number };

export async function readSettings(): Promise<LoginEmailSettings> {
	const [row] = await db.select().from(appSettings).where(eq(appSettings.key, SETTINGS_KEY)).limit(1);
	const v = (row?.value ?? {}) as Partial<LoginEmailSettings>;
	const c = Number(v.cadenceSeconds);
	return { cadenceSeconds: Number.isFinite(c) && c >= MIN_CADENCE_SECONDS ? Math.min(c, MAX_CADENCE_SECONDS) : DEFAULT_CADENCE_SECONDS };
}

export async function setCadence(actor: SessionUser, seconds: number): Promise<{ ok: true } | { ok: false; message: string }> {
	if (!hasCap(actor, 'people.send_logins')) return { ok: false, message: 'Only someone who can approve login emails can change this' };
	if (!Number.isFinite(seconds) || seconds < MIN_CADENCE_SECONDS || seconds > MAX_CADENCE_SECONDS) {
		return { ok: false, message: `Pick between ${MIN_CADENCE_SECONDS} seconds and 24 hours` };
	}
	const value = { cadenceSeconds: Math.round(seconds) };
	await db.insert(appSettings).values({ key: SETTINGS_KEY, value }).onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
	await logActivity({ actorUserId: actor.id, action: 'login_email.cadence', targetType: 'app_setting', targetId: SETTINGS_KEY, details: value }).catch(() => {});
	return { ok: true };
}

/* ---------- queueing ---------- */

/** People who can approve login emails, to be told something is waiting. */
async function approverIds(): Promise<string[]> {
	const named = await db.select({ id: customRoles.id }).from(customRoles).where(sql`'people.send_logins' = any(${customRoles.capabilities})`);
	const rows = await db
		.select({ id: users.id })
		.from(users)
		.where(and(eq(users.isActive, true), or(inArray(users.role, ['admin', 'super_admin']), named.length ? inArray(users.customRoleId, named.map((n) => n.id)) : sql`false`)));
	return rows.map((r) => r.id);
}

/**
 * Queue the welcome email for each of `userIds`. Anything still waiting for
 * the same person is replaced, since only the newest password works.
 */
export async function queueLoginEmails(
	userIds: string[],
	opts: { source: LoginEmailSource; requestedBy: string; importId?: string | null; sendTo?: string | null; notify?: boolean }
): Promise<number> {
	const ids = [...new Set(userIds)];
	if (ids.length === 0) return 0;
	await db
		.update(loginEmails)
		.set({ status: 'cancelled', error: 'Replaced by a newer login email' })
		.where(and(inArray(loginEmails.userId, ids), inArray(loginEmails.status, ['pending', 'approved', 'failed'])));
	await db.insert(loginEmails).values(
		ids.map((userId) => ({ userId, source: opts.source, requestedBy: opts.requestedBy, importId: opts.importId ?? null, sendTo: opts.sendTo || null }))
	);
	if (opts.notify !== false) {
		const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(loginEmails).where(eq(loginEmails.status, 'pending'));
		const text = `${n} login ${n === 1 ? 'email is' : 'emails are'} waiting for approval before they go out.`;
		for (const id of await approverIds()) {
			await postToFeed(id, text, { type: 'notice', tone: 'warn', title: 'Login emails to approve', text, href: '/admin/people?view=logins' }, { notify: id !== opts.requestedBy });
		}
	}
	return ids.length;
}

/* ---------- the queue, for the admin screen ---------- */

export type LoginEmailRow = {
	id: string;
	userId: string;
	fullName: string;
	email: string;
	sendTo: string | null;
	source: LoginEmailSource;
	status: 'pending' | 'approved' | 'sending' | 'sent' | 'failed' | 'cancelled' | 'skipped';
	requestedBy: string | null;
	approvedBy: string | null;
	createdAt: string;
	approvedAt: string | null;
	sentAt: string | null;
	error: string | null;
	/** Where it stands in the sending order, for approved ones. */
	position: number | null;
	/** Has not signed in and chosen their own password yet. */
	waitingToSignIn: boolean;
};

export async function listLoginEmails(): Promise<{ rows: LoginEmailRow[]; settings: LoginEmailSettings; mailerConfigured: boolean; nextSendAt: string | null }> {
	const requester = sql<string | null>`(select full_name from users r where r.id = ${loginEmails.requestedBy} and r.hidden = false)`;
	const approver = sql<string | null>`(select full_name from users a where a.id = ${loginEmails.approvedBy} and a.hidden = false)`;
	const rows = await db
		.select({ q: loginEmails, fullName: users.fullName, email: users.email, mustChange: users.mustChangePassword, requestedBy: requester, approvedBy: approver })
		.from(loginEmails)
		.innerJoin(users, eq(users.id, loginEmails.userId))
		.where(and(notHidden, or(inArray(loginEmails.status, ['pending', 'approved', 'sending', 'failed']), sql`${loginEmails.createdAt} > now() - interval '14 days'`)))
		.orderBy(desc(loginEmails.createdAt))
		.limit(500);
	const approvedOrder = rows
		.filter((r) => r.q.status === 'approved')
		.sort((a, b) => (a.q.approvedAt?.getTime() ?? 0) - (b.q.approvedAt?.getTime() ?? 0) || a.q.createdAt.getTime() - b.q.createdAt.getTime())
		.map((r) => r.q.id);
	const settings = await readSettings();
	const last = await lastAttemptAt();
	const nextSendAt = approvedOrder.length ? new Date(Math.max(Date.now(), (last?.getTime() ?? 0) + settings.cadenceSeconds * 1000)).toISOString() : null;
	return {
		settings,
		mailerConfigured: isMailerConfigured(),
		nextSendAt,
		rows: rows.map((r) => ({
			id: r.q.id,
			userId: r.q.userId,
			fullName: r.fullName,
			email: r.email,
			sendTo: r.q.sendTo,
			source: r.q.source as LoginEmailSource,
			status: r.q.status,
			requestedBy: r.requestedBy,
			approvedBy: r.approvedBy,
			createdAt: r.q.createdAt.toISOString(),
			approvedAt: r.q.approvedAt?.toISOString() ?? null,
			sentAt: r.q.sentAt?.toISOString() ?? null,
			error: r.q.error,
			position: r.q.status === 'approved' ? approvedOrder.indexOf(r.q.id) + 1 : null,
			waitingToSignIn: r.mustChange
		}))
	};
}

/** Pending emails for the Admin Controls attention count. */
export async function pendingCount(): Promise<number> {
	const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(loginEmails).where(eq(loginEmails.status, 'pending'));
	return n;
}

type Done = { ok: true; count: number } | { ok: false; message: string };

function gate(actor: SessionUser): Done | null {
	return hasCap(actor, 'people.send_logins') ? null : { ok: false, message: 'Only someone who can approve login emails can do this' };
}

/** Approve pending (or retry failed) emails; `ids` empty means every pending one. */
export async function approveLoginEmails(actor: SessionUser, ids: string[]): Promise<Done> {
	const no = gate(actor);
	if (no) return no;
	const rows = await db
		.update(loginEmails)
		.set({ status: 'approved', approvedBy: actor.id, approvedAt: new Date(), error: null })
		.where(and(inArray(loginEmails.status, ids.length ? ['pending', 'failed'] : ['pending']), ids.length ? inArray(loginEmails.id, ids) : undefined))
		.returning({ id: loginEmails.id });
	await logActivity({ actorUserId: actor.id, action: 'login_email.approve', targetType: 'login_email', details: { count: rows.length } }).catch(() => {});
	return { ok: true, count: rows.length };
}

/** Hold back: approved ones go back to waiting for approval. */
export async function holdLoginEmails(actor: SessionUser, ids: string[]): Promise<Done> {
	const no = gate(actor);
	if (no) return no;
	if (!ids.length) return { ok: false, message: 'Pick the emails to hold' };
	const rows = await db
		.update(loginEmails)
		.set({ status: 'pending', approvedBy: null, approvedAt: null })
		.where(and(eq(loginEmails.status, 'approved'), inArray(loginEmails.id, ids)))
		.returning({ id: loginEmails.id });
	return { ok: true, count: rows.length };
}

export async function cancelLoginEmails(actor: SessionUser, ids: string[]): Promise<Done> {
	const no = gate(actor);
	if (no) return no;
	if (!ids.length) return { ok: false, message: 'Pick the emails to cancel' };
	const rows = await db
		.update(loginEmails)
		.set({ status: 'cancelled', error: `Cancelled by ${actor.fullName}` })
		.where(and(inArray(loginEmails.status, ['pending', 'approved', 'failed']), inArray(loginEmails.id, ids)))
		.returning({ id: loginEmails.id });
	await logActivity({ actorUserId: actor.id, action: 'login_email.cancel', targetType: 'login_email', details: { count: rows.length } }).catch(() => {});
	return { ok: true, count: rows.length };
}

/* ---------- sending ---------- */

async function lastAttemptAt(): Promise<Date | null> {
	const [row] = await db
		.select({ at: loginEmails.attemptedAt })
		.from(loginEmails)
		.where(isNotNull(loginEmails.attemptedAt))
		.orderBy(desc(loginEmails.attemptedAt))
		.limit(1);
	return row?.at ?? null;
}

/**
 * Sends the next approved email if the cadence allows. Called every few
 * seconds by the scheduler; safe with several server processes because the
 * row is claimed with SKIP LOCKED before anything is sent.
 */
export async function sendNextLoginEmail(now = new Date()): Promise<'sent' | 'failed' | 'skipped' | 'waiting' | 'idle'> {
	if (!isMailerConfigured()) return 'idle';
	const { cadenceSeconds } = await readSettings();
	const last = await lastAttemptAt();
	if (last && now.getTime() - last.getTime() < cadenceSeconds * 1000) return 'waiting';

	const claimed = await db.execute(sql`
		update login_emails set status = 'sending', attempted_at = now()
		where id = (
			select id from login_emails where status = 'approved'
			order by approved_at asc nulls last, created_at asc
			for update skip locked limit 1
		)
		returning id, user_id as "userId", send_to as "sendTo"
	`);
	const job = (claimed.rows as { id: string; userId: string; sendTo: string | null }[])[0];
	if (!job) return 'idle';

	const [u] = await db
		.select({ fullName: users.fullName, email: users.email, temp: users.temporaryPassword, mustChange: users.mustChangePassword, isActive: users.isActive })
		.from(users)
		.where(eq(users.id, job.userId))
		.limit(1);
	const finish = (status: 'sent' | 'failed' | 'skipped', error: string | null) =>
		db.update(loginEmails).set({ status, error, sentAt: status === 'sent' ? new Date() : null }).where(eq(loginEmails.id, job.id));

	if (!u || !u.isActive) {
		await finish('skipped', 'The login has been deactivated');
		return 'skipped';
	}
	if (!u.mustChange) {
		await finish('skipped', 'They have already signed in and set their own password');
		return 'skipped';
	}
	// With Clerk as the sign-in the email carries no password: the person signs
	// in with an emailed code and chooses their own (password-state.ts).
	const temporaryPassword = clerkAuthActive() ? null : u.temp;
	if (!clerkAuthActive() && !u.temp) {
		await finish('failed', 'This login has no password yet (it was made while Clerk was the sign-in). Re-issue it to give it a temporary password, or switch the sign-in back to Clerk.');
		return 'failed';
	}
	const to = job.sendTo || (looksLikeEmail(u.email) ? u.email : null);
	if (!to) {
		await finish('failed', `"${u.email}" is not an email address. Correct it on the roster, then retry.`);
		return 'failed';
	}
	const mail = await sendWelcomeEmail({ fullName: u.fullName, username: u.email, temporaryPassword, to });
	await finish(mail.ok ? 'sent' : 'failed', mail.ok ? null : (mail.error ?? 'The mail provider refused it'));
	await logActivity({
		actorUserId: 'system',
		action: 'login_email.send',
		targetType: 'user',
		targetId: job.userId,
		// Never the password: only whether delivery worked.
		details: { ok: mail.ok, providerId: mail.id ?? null, error: mail.ok ? null : (mail.error ?? null), redirectedTo: job.sendTo }
	}).catch(() => {});
	return mail.ok ? 'sent' : 'failed';
}

/** A send interrupted by a restart is put back in line. */
export async function recoverStuckSends() {
	await db.update(loginEmails).set({ status: 'approved' }).where(and(eq(loginEmails.status, 'sending'), sql`${loginEmails.attemptedAt} < now() - interval '5 minutes'`));
}

export function startLoginEmailSender() {
	const g = globalThis as { __loginEmailSender?: boolean };
	if (g.__loginEmailSender) return;
	g.__loginEmailSender = true;
	const tick = () =>
		sendNextLoginEmail().catch((err) => console.error('[login-emails] send failed:', err instanceof Error ? err.message : err));
	setTimeout(() => void recoverStuckSends().catch(() => {}), 20_000);
	setInterval(tick, 5_000);
}


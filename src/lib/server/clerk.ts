import { randomBytes } from 'node:crypto';
import { createClerkClient, type ClerkClient } from '@clerk/backend';
import { env } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import { db } from './db/postgres';
import { users } from './db/schema';
import { eq } from 'drizzle-orm';
import { hashPassword } from './auth';
import { NO_PASSWORD_YET, hasPassword } from './password-state';
import { isNoLoginEmail } from '../no-login';

/**
 * Clerk as the portal's sign-in.
 *
 * Clerk only answers "who is this?". Everything after that — base role, named
 * role, privileges, isActive, the forced first password change — still comes
 * from Postgres, so `locals.user` keeps the same shape it always had.
 *
 * Two switches, read per call so a Railway variable change needs no rebuild:
 *  - configured: CLERK_SECRET_KEY + PUBLIC_CLERK_PUBLISHABLE_KEY are set. From
 *    then on every password the portal sets is mirrored into Clerk, so the
 *    Clerk side never drifts while the old login is still live.
 *  - active: AUTH_PROVIDER=clerk as well. Sign-in, sessions and sign-out move
 *    to Clerk; the portal's own JWT cookies are ignored.
 * Flipping AUTH_PROVIDER back to anything else is the rollback: password
 * hashes stay in Postgres and keep being updated.
 */

export function clerkConfigured(): boolean {
	return Boolean(env.CLERK_SECRET_KEY && publicEnv.PUBLIC_CLERK_PUBLISHABLE_KEY);
}

export function clerkAuthActive(): boolean {
	return env.AUTH_PROVIDER === 'clerk' && clerkConfigured();
}

let client: ClerkClient | null = null;
export function clerk(): ClerkClient {
	if (!env.CLERK_SECRET_KEY) throw new Error('CLERK_SECRET_KEY is not set');
	client ??= createClerkClient({
		secretKey: env.CLERK_SECRET_KEY,
		publishableKey: publicEnv.PUBLIC_CLERK_PUBLISHABLE_KEY
	});
	return client;
}

/**
 * Origins allowed to present a Clerk session to this server (Clerk's
 * `authorizedParties`). CLERK_AUTHORIZED_PARTIES is a comma list; without it
 * the portal's own ORIGIN is the only one.
 */
export function authorizedParties(): string[] {
	const raw = env.CLERK_AUTHORIZED_PARTIES || env.ORIGIN || '';
	return raw
		.split(',')
		.map((s) => s.trim().replace(/\/$/, ''))
		.filter(Boolean);
}

export function splitName(fullName: string): { firstName?: string; lastName?: string } {
	const [first, ...rest] = fullName.trim().split(/\s+/);
	return { firstName: first || undefined, lastName: rest.join(' ') || undefined };
}

type UserRow = typeof users.$inferSelect;

/**
 * The Postgres user behind a Clerk session. Linked rows are found by
 * `clerk_user_id`; a Clerk account the import didn't link (made by hand in the
 * Dashboard, or created before its row was written back) is matched once by
 * its externalId (= users.id), then by its primary email, and linked for good.
 */
export async function userForClerkId(clerkUserId: string): Promise<UserRow | null> {
	const [linked] = await db.select().from(users).where(eq(users.clerkUserId, clerkUserId)).limit(1);
	if (linked) return linked;

	const cu = await clerk().users.getUser(clerkUserId);
	let row: UserRow | undefined;
	if (cu.externalId && /^[0-9a-f-]{36}$/i.test(cu.externalId)) {
		[row] = await db.select().from(users).where(eq(users.id, cu.externalId)).limit(1);
	}
	if (!row) {
		const primary = cu.emailAddresses.find((e) => e.id === cu.primaryEmailAddressId);
		if (primary?.verification?.status === 'verified') {
			[row] = await db.select().from(users).where(eq(users.email, primary.emailAddress.toLowerCase())).limit(1);
		}
	}
	// Never re-point a row that is already linked to a different Clerk account.
	if (!row || (row.clerkUserId && row.clerkUserId !== clerkUserId)) return null;

	await db.update(users).set({ clerkUserId }).where(eq(users.id, row.id));
	if (!cu.externalId) await clerk().users.updateUser(clerkUserId, { externalId: row.id });
	return { ...row, clerkUserId };
}

/**
 * Give the person this password in Clerk too: creates their Clerk account if
 * there isn't one yet, otherwise replaces the password. Called everywhere the
 * portal sets a password (new login, re-issued temporary password, admin
 * reset, the person's own change), right after Postgres is updated.
 *
 * While Clerk is only mirrored, a failure is logged and the portal carries on;
 * scripts/migrate-to-clerk.ts --refresh re-syncs everyone before cutover.
 * Once Clerk is the live sign-in a failure is real — the person would not be
 * able to use the new password — so it is thrown.
 */
export async function mirrorPasswordToClerk(
	userId: string,
	password: string,
	opts: { signOutOtherSessions?: boolean } = {}
): Promise<void> {
	if (!clerkConfigured()) return;
	try {
		const [row] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
		// Someone with no login (src/lib/no-login.ts) never gets a Clerk account.
		if (!row || isNoLoginEmail(row.email)) return;
		// A Clerk account made in the Dashboard with this email is linked, not
		// duplicated: Clerk refuses a second account for the same address.
		let clerkUserId = row.clerkUserId;
		if (!clerkUserId) {
			const { data } = await clerk().users.getUserList({ emailAddress: [row.email] });
			clerkUserId = data[0]?.id ?? null;
			if (clerkUserId) {
				await clerk().users.updateUser(clerkUserId, { externalId: row.id });
				await db.update(users).set({ clerkUserId }).where(eq(users.id, row.id));
			}
		}
		if (clerkUserId) {
			await clerk().users.updateUser(clerkUserId, {
				password,
				skipPasswordChecks: true,
				signOutOfOtherSessions: opts.signOutOtherSessions ?? false
			});
			return;
		}
		const created = await clerk().users.createUser({
			externalId: row.id,
			emailAddress: [row.email],
			...splitName(row.fullName),
			password,
			skipPasswordChecks: true
		});
		await db.update(users).set({ clerkUserId: created.id }).where(eq(users.id, row.id));
	} catch (err) {
		console.error('[clerk] password sync failed for', userId, err);
		if (clerkAuthActive()) throw err;
	}
}

/**
 * A Clerk account with no password, linked to the portal row. The person signs
 * in with the code Clerk emails them and then chooses a password in the portal
 * (password-state.ts). An existing Clerk account with the same email (made in
 * the Dashboard) is linked instead. Never throws: the hourly account sync
 * (clerk-sync.ts) picks up anyone a failure left out.
 */
export async function ensureClerkAccount(userId: string): Promise<void> {
	if (!clerkConfigured()) return;
	try {
		const [row] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
		if (!row || row.clerkUserId || isNoLoginEmail(row.email)) return;
		const { data } = await clerk().users.getUserList({ emailAddress: [row.email] });
		let clerkUserId = data[0]?.id;
		if (clerkUserId) {
			await clerk().users.updateUser(clerkUserId, { externalId: row.id });
		} else {
			const created = await clerk().users.createUser({
				externalId: row.id,
				emailAddress: [row.email],
				...splitName(row.fullName),
				skipPasswordRequirement: true
			});
			clerkUserId = created.id;
		}
		await db.update(users).set({ clerkUserId }).where(eq(users.id, row.id));
	} catch (err) {
		console.error('[clerk] could not create the account for', userId, err);
	}
}

/**
 * The first credentials of a brand-new login. With Clerk as the sign-in there
 * is no made-up password (password-state.ts); otherwise a temporary one, as
 * before, which the person replaces at their first sign-in.
 */
export async function newLoginCredentials(): Promise<{ temporaryPassword: string | null; passwordHash: string }> {
	if (clerkAuthActive()) return { temporaryPassword: null, passwordHash: NO_PASSWORD_YET };
	const temporaryPassword = randomBytes(9).toString('base64url');
	return { temporaryPassword, passwordHash: await hashPassword(temporaryPassword) };
}

/** Puts a just-created login into Clerk, with whatever newLoginCredentials gave it. */
export async function addNewLoginToClerk(userId: string, temporaryPassword: string | null): Promise<void> {
	if (temporaryPassword) await mirrorPasswordToClerk(userId, temporaryPassword);
	else await ensureClerkAccount(userId);
}

/**
 * Whether choosing a new password must confirm the current one. Not for
 * someone who has none yet, nor for a first sign-in through Clerk: they came
 * in with an emailed code and were never told the temporary password.
 */
export function needsCurrentPassword(row: { passwordHash: string; mustChangePassword: boolean }): boolean {
	if (!hasPassword(row.passwordHash)) return false;
	return !(row.mustChangePassword && clerkAuthActive());
}

/** Remove the person's Clerk account (the portal row is being hard-deleted). */
export async function deleteClerkUser(clerkUserId: string | null | undefined): Promise<void> {
	if (!clerkUserId || !clerkConfigured()) return;
	try {
		await clerk().users.deleteUser(clerkUserId);
	} catch (err) {
		console.error('[clerk] delete failed for', clerkUserId, err);
	}
}

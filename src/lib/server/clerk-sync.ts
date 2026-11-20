import { eq } from 'drizzle-orm';
import { db } from './db/postgres';
import { users } from './db/schema';
import { clerk, clerkConfigured, splitName } from './clerk';
import { hasPassword } from './password-state';
import { isNoLoginEmail } from '../no-login';

/**
 * Gives every active portal login a Clerk account with the SAME password and
 * links the two (Clerk externalId = users.id, users.clerk_user_id = Clerk id).
 *
 * Passwords move as their Argon2id hashes — Clerk takes `$argon2id$v=19$…`
 * digests as they are — so nobody's password is reset or ever seen.
 *
 * Runs by itself in the app (startClerkAccountSync) as soon as Clerk keys are
 * set, and from the command line via scripts/migrate-to-clerk.ts. Linked
 * people are skipped, so running it again only picks up who is missing.
 * `refresh` recreates every account from today's hashes (CLI only).
 */

export interface ClerkSyncResult {
	created: number;
	recreated: number;
	linked: number;
	alreadyLinked: number;
	skippedInactive: number;
	skippedNotEmail: number;
	/** People with no login at all (src/lib/no-login.ts), who never get a Clerk account. */
	skippedNoLogin: number;
	failed: number;
	problems: string[];
	unmappedActive: number;
}

const looksLikeEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

async function clerkIdForEmail(email: string): Promise<string | null> {
	const { data } = await clerk().users.getUserList({ emailAddress: [email] });
	return data[0]?.id ?? null;
}

export async function syncClerkAccounts(
	opts: { dryRun?: boolean; refresh?: boolean; log?: (line: string) => void } = {}
): Promise<ClerkSyncResult> {
	const { dryRun = false, refresh = false, log = () => {} } = opts;
	const r: ClerkSyncResult = {
		created: 0,
		recreated: 0,
		linked: 0,
		alreadyLinked: 0,
		skippedInactive: 0,
		skippedNotEmail: 0,
		skippedNoLogin: 0,
		failed: 0,
		problems: [],
		unmappedActive: 0
	};

	for (const u of await db.select().from(users)) {
		if (!u.isActive) {
			r.skippedInactive++;
			continue;
		}
		if (isNoLoginEmail(u.email)) {
			r.skippedNoLogin++;
			continue;
		}
		if (!looksLikeEmail(u.email)) {
			r.skippedNotEmail++;
			r.problems.push(`${u.email} (${u.fullName}): login id is not an email address, fix it on the roster first`);
			continue;
		}
		if (u.clerkUserId && !refresh) {
			r.alreadyLinked++;
			continue;
		}
		try {
			const existing = u.clerkUserId ?? (await clerkIdForEmail(u.email));

			if (existing && !refresh) {
				// A Clerk account with this email already exists (made in the
				// Dashboard, or by an earlier run that died before writing back).
				if (!dryRun) {
					await db.update(users).set({ clerkUserId: existing }).where(eq(users.id, u.id));
					await clerk().users.updateUser(existing, { externalId: u.id });
				}
				r.linked++;
				log(`linked    ${u.email} → ${existing}`);
				continue;
			}

			if (dryRun) {
				if (existing) r.recreated++;
				else r.created++;
				log(`${existing ? 'recreate ' : 'create   '} ${u.email}`);
				continue;
			}

			if (existing) await clerk().users.deleteUser(existing);
			// Someone who has not chosen a password yet gets a passwordless account:
			// they sign in with the emailed code and choose one in the portal.
			const created = await clerk().users.createUser({
				externalId: u.id,
				emailAddress: [u.email],
				...splitName(u.fullName),
				...(hasPassword(u.passwordHash)
					? { passwordDigest: u.passwordHash, passwordHasher: 'argon2id' as const, skipPasswordChecks: true }
					: { skipPasswordRequirement: true })
			});
			await db.update(users).set({ clerkUserId: created.id }).where(eq(users.id, u.id));
			if (existing) r.recreated++;
			else r.created++;
			log(`${existing ? 'recreated' : 'created  '} ${u.email} → ${created.id}`);
		} catch (err) {
			r.failed++;
			const detail = (err as { errors?: { longMessage?: string; message?: string }[] }).errors?.[0];
			r.problems.push(`${u.email}: ${detail?.longMessage ?? detail?.message ?? String(err)}`);
		}
	}

	const rows = await db.select({ isActive: users.isActive, clerkUserId: users.clerkUserId, email: users.email }).from(users);
	r.unmappedActive = rows.filter((row) => row.isActive && !row.clerkUserId && !isNoLoginEmail(row.email)).length;
	return r;
}

/**
 * The automatic migration: shortly after boot, then hourly, every active login
 * that has no Clerk account yet gets one. A no-op until Clerk keys are set.
 * The logins already on the portal therefore reach Clerk on the first deploy
 * that has the keys, and anyone a failed mirror left out is caught up within
 * the hour. Re-entrant runs are skipped; two servers running it at once are
 * safe too, because the second finds the first's account by email and links it.
 */
export function startClerkAccountSync() {
	const g = globalThis as { __essClerkSync?: boolean };
	if (g.__essClerkSync) return;
	g.__essClerkSync = true;

	let running = false;
	const tick = async () => {
		if (running || !clerkConfigured()) return;
		running = true;
		try {
			const r = await syncClerkAccounts();
			if (r.created || r.linked || r.failed) {
				console.log(
					`[clerk] account sync: ${r.created} created, ${r.linked} linked, ${r.alreadyLinked} already linked, ${r.failed} failed; ${r.unmappedActive} active logins still without a Clerk account`
				);
				for (const p of r.problems) console.log('[clerk]   ' + p);
			}
		} catch (err) {
			console.error('[clerk] account sync failed:', err);
		} finally {
			running = false;
		}
	};
	setTimeout(tick, 5_000);
	setInterval(tick, 60 * 60_000);
}

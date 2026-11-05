import { redirect, type Handle } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import { withClerkHandler } from 'svelte-clerk/server';
import {
	getAccessTokenCookie,
	getRefreshTokenCookie,
	verifyAccessToken,
	verifyAndRotateRefreshToken,
	issueAccessToken,
	issueRefreshToken,
	setAuthCookies,
	clearAuthCookies
} from '$lib/server/auth';
import { db } from '$lib/server/db/client';
import { users } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { startProhancePoller } from '$lib/server/prohance';
import { startAnnouncementScheduler } from '$lib/server/announcements';
import { loadCapabilities } from '$lib/server/capabilities';
import { startChatScheduler } from '$lib/server/chat/scheduler';
import { startLoginEmailSender } from '$lib/server/login-emails';
import { startClerkAccountSync } from '$lib/server/clerk-sync';
import type { SessionUser } from '$lib/server/auth';
import { clerkAuthActive, authorizedParties, userForClerkId } from '$lib/server/clerk';
import { actingTarget } from '$lib/server/act-as';
import { onCloudflare, runWithPlatform, type CloudflareBindings } from '$lib/server/platform';

// Background jobs. On Cloudflare Workers there is no long-lived process, so
// the cron trigger runs them instead (src/lib/server/cron.ts); under Node
// (Docker, vite dev) they run on timers inside this process as before.
if (!onCloudflare) {
	// ProHance attendance poller. No-op unless PROHANCE_BASE_URL + Prohance_API_KEY
	// are set; guarded internally against dev-HMR double starts.
	startProhancePoller();
	// Sends the email copy of scheduled announcements once they go live.
	startAnnouncementScheduler();
	// Champ Chat: roster sync, reminders, digests, celebrations, retention.
	startChatScheduler();
	// Approved login emails go out one at a time at the cadence HR set.
	startLoginEmailSender();
	// Copies every existing login into Clerk (same password) once Clerk keys are
	// set, then hourly picks up anyone missing. No-op without keys.
	startClerkAccountSync();
}

/** Privileges ride along on the request user (src/lib/capabilities.ts). */
async function withCapabilities(user: SessionUser): Promise<SessionUser> {
	const loaded = await loadCapabilities(user);
	return { ...user, capabilities: loaded.caps, customRoleName: loaded.customRoleName };
}

// Background work (chat notifications, cards, Champ in chat) is started with
// `void promise.catch(...)`; this is the net under anything that slips
// through, so one failed notification can never take the whole portal down.
const g = globalThis as { __essRejectionNet?: boolean };
if (!g.__essRejectionNet && typeof process !== 'undefined' && typeof process.on === 'function' && !onCloudflare) {
	g.__essRejectionNet = true;
	process.on('unhandledRejection', (reason) => {
		console.error('[ess] unhandled rejection:', reason instanceof Error ? (reason.stack ?? reason.message) : reason);
	});
}

/** The portal's own sign-in: a 15-minute access JWT plus a rotating refresh token. */
const legacyHandle: Handle = async ({ event, resolve }) => {
	event.locals.user = null;

	const accessToken = getAccessTokenCookie(event.cookies);
	if (accessToken) {
		const user = await verifyAccessToken(accessToken);
		if (user) {
			event.locals.user = await withCapabilities(user);
			return resolve(event);
		}
	}

	// Access token missing/expired — try to rotate via refresh token.
	const refreshToken = getRefreshTokenCookie(event.cookies);
	if (refreshToken) {
		const rotated = await verifyAndRotateRefreshToken(refreshToken);
		if (rotated) {
			const [dbUser] = await db.select().from(users).where(eq(users.id, rotated.userId)).limit(1);
			if (dbUser && dbUser.isActive) {
				const sessionUser = {
					id: dbUser.id,
					email: dbUser.email,
					role: dbUser.role,
					fullName: dbUser.fullName,
					teamId: dbUser.teamId,
					mustChangePassword: dbUser.mustChangePassword
				};
				const newAccessToken = await issueAccessToken(sessionUser);
				const newRefreshToken = await issueRefreshToken(dbUser.id);
				setAuthCookies(event.cookies, newAccessToken, newRefreshToken);
				event.locals.user = await withCapabilities(sessionUser);
				return resolve(event);
			}
		}
		clearAuthCookies(event.cookies);
	}

	return resolve(event);
};

/**
 * Clerk sign-in (AUTH_PROVIDER=clerk, see src/lib/server/clerk.ts). Clerk's
 * handler verifies the session and puts `locals.auth` on the request; this
 * maps the Clerk user to its Postgres row. isActive and the role are read from
 * the database on every request, so deactivating or demoting someone takes
 * effect at once.
 */
const essUserFromClerk: Handle = async ({ event, resolve }) => {
	event.locals.user = null;
	const { userId } = event.locals.auth!();
	if (userId) {
		const dbUser = await userForClerkId(userId).catch((err) => {
			console.error('[clerk] could not resolve', userId, err);
			return null;
		});
		if (dbUser?.isActive) {
			event.locals.user = await withCapabilities({
				id: dbUser.id,
				email: dbUser.email,
				role: dbUser.role,
				fullName: dbUser.fullName,
				teamId: dbUser.teamId,
				mustChangePassword: dbUser.mustChangePassword
			});
		}
	}
	return resolve(event);
};

/**
 * "Open their portal" (src/lib/server/act-as.ts): while someone has a
 * blue-collar worker's portal open, the request runs as that worker, and
 * `locals.actingFor` remembers who is really there. Runs after either sign-in
 * has found the real person, and re-checks their right to do it every time.
 */
const actAs: Handle = async ({ event, resolve }) => {
	event.locals.actingFor = null;
	const real = event.locals.user;
	if (real) {
		const target = await actingTarget(event.cookies, real).catch(() => null);
		if (target) {
			event.locals.actingFor = { id: real.id, fullName: real.fullName };
			event.locals.user = await withCapabilities(target);
		}
	}
	return resolve(event);
};

/**
 * Portal pages need a signed-in person. The (app) layout redirects too, but
 * SvelteKit runs page loads alongside it, so a page reading locals.user.id
 * would crash with a 500 before that redirect landed.
 */
const signedInOnly: Handle = ({ event, resolve }) => {
	if (!event.locals.user && event.route.id?.startsWith('/(app)')) throw redirect(303, '/login');
	return resolve(event);
};

const legacyGuarded = sequence(legacyHandle, actAs, signedInOnly);
let clerkHandle: Handle | null = null;

// Which sign-in runs is decided per request, so flipping AUTH_PROVIDER (or
// rolling back) is a variable change plus restart/redeploy, not a rebuild.
const signIn: Handle = (input) => {
	if (!clerkAuthActive()) return legacyGuarded(input);
	clerkHandle ??= sequence(withClerkHandler({ authorizedParties: authorizedParties() }), essUserFromClerk, actAs, signedInOnly);
	return clerkHandle(input);
};

/**
 * Every request runs with its Cloudflare bindings and execution context
 * available to library code (src/lib/server/platform.ts): the per-request
 * Postgres pool, R2, the chat and key-value Durable Objects, and waitUntil for
 * background work.
 */
export const handle: Handle = async (input) => {
	const platform = input.event.platform as { env?: CloudflareBindings; ctx?: { waitUntil(p: Promise<unknown>): void } } | undefined;
	const response = await runWithPlatform(platform?.env ?? {}, platform?.ctx ?? null, async () => signIn(input));
	// Pages are per person. adapter-cloudflare stores responses in the edge
	// cache unless told otherwise, so anything that did not choose its own
	// caching is marked private.
	if (onCloudflare && !response.headers.has('Cache-Control')) {
		try {
			response.headers.set('Cache-Control', 'private, no-store');
		} catch {
			/* immutable headers (a proxied response): leave as is */
		}
	}
	return response;
};

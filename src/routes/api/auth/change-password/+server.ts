import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/postgres';
import { users } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import {
	verifyPassword,
	hashPassword,
	issueAccessToken,
	issueRefreshToken,
	setAuthCookies
} from '$lib/server/auth';
import { requireUser } from '$lib/server/rbac';
import { logActivity } from '$lib/server/db/store';
import { clerk, clerkAuthActive, mirrorPasswordToClerk, needsCurrentPassword } from '$lib/server/clerk';
import { isNoLoginEmail } from '$lib/no-login';

async function checkCurrentPassword(dbUser: typeof users.$inferSelect, currentPassword: string) {
	// Under Clerk the person may have reset their password through Clerk's own
	// "Forgot password?", which Postgres never sees; Clerk then has the say.
	let currentOk = await verifyPassword(dbUser.passwordHash, currentPassword);
	if (!currentOk && clerkAuthActive() && dbUser.clerkUserId) {
		currentOk = await clerk()
			.users.verifyPassword({ userId: dbUser.clerkUserId, password: currentPassword })
			.then(() => true, () => false);
	}
	if (!currentOk) {
		throw error(401, 'Current password is incorrect');
	}
}

export const POST: RequestHandler = async (event) => {
	const actor = requireUser(event);
	const { currentPassword, newPassword } = await event.request.json();

	if (typeof newPassword !== 'string' || !newPassword) {
		throw error(400, 'newPassword is required');
	}
	if (newPassword.length < 8) {
		throw error(400, 'New password must be at least 8 characters');
	}

	const [dbUser] = await db.select().from(users).where(eq(users.id, actor.id)).limit(1);
	if (!dbUser) {
		throw error(401, 'Authentication required');
	}
	// A blue-collar worker has no login to put a password on, and someone who
	// has their portal open must not be able to give them one.
	if (isNoLoginEmail(dbUser.email) || event.locals.actingFor) {
		throw error(400, 'This account has no login, so it has no password');
	}

	// A first password chosen after signing in through Clerk needs no current
	// one: they have none, or were never told it (see needsCurrentPassword).
	if (needsCurrentPassword(dbUser)) {
		await checkCurrentPassword(dbUser, typeof currentPassword === 'string' ? currentPassword : '');
	}

	const passwordHash = await hashPassword(newPassword);

	const [updated] = await db
		.update(users)
		.set({
			passwordHash,
			mustChangePassword: false,
			// The issued temporary password is kept readable only while it is still
			// the way into the account. This is the moment that stops being true, so
			// it goes — the person now has a password nobody else has ever seen.
			temporaryPassword: null,
			updatedAt: new Date()
		})
		.where(eq(users.id, actor.id))
		.returning();

	// Other browsers signed in as this person are signed out (Clerk only; the
	// portal's own tokens are not revocable per user).
	await mirrorPasswordToClerk(actor.id, newPassword, { signOutOtherSessions: true });

	const sessionUser = {
		id: updated.id,
		email: updated.email,
		role: updated.role,
		fullName: updated.fullName,
		teamId: updated.teamId,
		mustChangePassword: updated.mustChangePassword
	};

	if (!clerkAuthActive()) {
		const accessToken = await issueAccessToken(sessionUser);
		const refreshToken = await issueRefreshToken(updated.id);
		setAuthCookies(event.cookies, accessToken, refreshToken);
	}

	await logActivity({
		actorUserId: actor.id,
		action: 'password.change',
		targetType: 'user',
		targetId: actor.id
	});

	return json({ user: sessionUser });
};

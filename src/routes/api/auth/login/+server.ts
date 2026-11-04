import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/postgres';
import { users } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { verifyPassword, issueAccessToken, issueRefreshToken, setAuthCookies } from '$lib/server/auth';
import { isLoginRateLimited, clearLoginRateLimit } from '$lib/server/db/redis';
import { logActivity } from '$lib/server/db/store';
import { isNoLoginEmail } from '$lib/no-login';

export const POST: RequestHandler = async ({ request, cookies, getClientAddress }) => {
	const { email, password } = await request.json();

	if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
		throw error(400, 'Email and password are required');
	}

	const rateLimitKey = `${email.toLowerCase()}:${getClientAddress()}`;
	if (await isLoginRateLimited(rateLimitKey)) {
		throw error(429, 'Too many login attempts. Try again later.');
	}

	const [user] = await db
		.select()
		.from(users)
		.where(eq(users.email, email.toLowerCase()))
		.limit(1);

	// A blue-collar placeholder is never a sign-in, whatever its password says.
	if (!user || !user.isActive || isNoLoginEmail(user.email)) {
		throw error(401, 'Invalid email or password');
	}

	const passwordOk = await verifyPassword(user.passwordHash, password);
	if (!passwordOk) {
		throw error(401, 'Invalid email or password');
	}

	await clearLoginRateLimit(rateLimitKey);

	const sessionUser = {
		id: user.id,
		email: user.email,
		role: user.role,
		fullName: user.fullName,
		teamId: user.teamId,
		mustChangePassword: user.mustChangePassword
	};

	const accessToken = await issueAccessToken(sessionUser);
	const refreshToken = await issueRefreshToken(user.id);
	setAuthCookies(cookies, accessToken, refreshToken);

	await logActivity({
		actorUserId: user.id,
		action: 'login',
		targetType: 'user',
		targetId: user.id
	});

	return json({ user: sessionUser });
};

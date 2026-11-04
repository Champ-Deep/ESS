import { SignJWT, jwtVerify } from 'jose';
import { hash, verify } from '@node-rs/argon2';
import { randomUUID } from 'node:crypto';
import type { Cookies } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { storeRefreshToken, getUserIdForRefreshToken, revokeRefreshToken } from './db/redis';
import { hasPassword } from './password-state';

export type Role = 'super_admin' | 'admin' | 'team_lead' | 'employee';

export interface SessionUser {
	id: string;
	email: string;
	role: Role;
	fullName: string;
	teamId: string | null;
	mustChangePassword: boolean;
	/** Effective privileges, loaded per request in hooks.server.ts. */
	capabilities?: import('$lib/capabilities').CapabilityKey[];
	/** The named role on top of the base role, if any ("IT Support"). */
	customRoleName?: string | null;
}

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // 15 min
const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

const ARGON2_OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

function getAccessSecret() {
	const secret = env.JWT_SECRET;
	if (!secret) throw new Error('JWT_SECRET is not set');
	return new TextEncoder().encode(secret);
}

function getRefreshSecret() {
	const secret = env.JWT_REFRESH_SECRET;
	if (!secret) throw new Error('JWT_REFRESH_SECRET is not set');
	return new TextEncoder().encode(secret);
}

export async function hashPassword(password: string): Promise<string> {
	return hash(password, ARGON2_OPTS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
	if (!hasPassword(hash)) return false;
	return verify(hash, password);
}

export async function issueAccessToken(user: SessionUser): Promise<string> {
	return new SignJWT({
		email: user.email,
		role: user.role,
		fullName: user.fullName,
		teamId: user.teamId,
		mustChangePassword: user.mustChangePassword
	})
		.setProtectedHeader({ alg: 'HS256' })
		.setSubject(user.id)
		.setIssuedAt()
		.setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
		.sign(getAccessSecret());
}

export async function issueRefreshToken(userId: string): Promise<string> {
	const tokenId = randomUUID();
	await storeRefreshToken(userId, tokenId, REFRESH_TOKEN_TTL_SECONDS);
	return new SignJWT({ tokenId })
		.setProtectedHeader({ alg: 'HS256' })
		.setSubject(userId)
		.setIssuedAt()
		.setExpirationTime(`${REFRESH_TOKEN_TTL_SECONDS}s`)
		.sign(getRefreshSecret());
}

export async function verifyAccessToken(token: string): Promise<SessionUser | null> {
	try {
		const { payload } = await jwtVerify(token, getAccessSecret());
		return {
			id: payload.sub as string,
			email: payload.email as string,
			role: payload.role as Role,
			fullName: payload.fullName as string,
			teamId: (payload.teamId as string) ?? null,
			mustChangePassword: Boolean(payload.mustChangePassword)
		};
	} catch {
		return null;
	}
}

export async function verifyAndRotateRefreshToken(
	token: string
): Promise<{ userId: string; tokenId: string } | null> {
	try {
		const { payload } = await jwtVerify(token, getRefreshSecret());
		const tokenId = payload.tokenId as string;
		const storedUserId = await getUserIdForRefreshToken(tokenId);
		if (!storedUserId || storedUserId !== payload.sub) return null;
		await revokeRefreshToken(tokenId);
		return { userId: storedUserId, tokenId };
	} catch {
		return null;
	}
}

const ACCESS_COOKIE = 'champ_access';
const REFRESH_COOKIE = 'champ_refresh';

export function setAuthCookies(cookies: Cookies, accessToken: string, refreshToken: string) {
	const secure = env.NODE_ENV === 'production';
	cookies.set(ACCESS_COOKIE, accessToken, {
		path: '/',
		httpOnly: true,
		secure,
		sameSite: 'lax',
		maxAge: ACCESS_TOKEN_TTL_SECONDS
	});
	cookies.set(REFRESH_COOKIE, refreshToken, {
		path: '/',
		httpOnly: true,
		secure,
		sameSite: 'lax',
		maxAge: REFRESH_TOKEN_TTL_SECONDS
	});
}

export function clearAuthCookies(cookies: Cookies) {
	cookies.delete(ACCESS_COOKIE, { path: '/' });
	cookies.delete(REFRESH_COOKIE, { path: '/' });
}

export function getAccessTokenCookie(cookies: Cookies): string | undefined {
	return cookies.get(ACCESS_COOKIE);
}

export function getRefreshTokenCookie(cookies: Cookies): string | undefined {
	return cookies.get(REFRESH_COOKIE);
}

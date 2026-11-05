import { kv } from '../kv';

/*
 * Login rate limiting and refresh tokens. Kept at this path so callers are
 * unchanged; the data now lives in the shared key-value store (src/lib/server/kv.ts):
 * a Durable Object on Cloudflare, an in-process map under Node.
 */

const LOGIN_ATTEMPT_LIMIT = 5;
const LOGIN_ATTEMPT_WINDOW_SECONDS = 15 * 60;

/** Returns true if the caller is currently rate-limited on login attempts. */
export async function isLoginRateLimited(identifier: string): Promise<boolean> {
	const key = `login-attempts:${identifier}`;
	const count = await kv().incr(key);
	if (count === 1) {
		await kv().expire(key, LOGIN_ATTEMPT_WINDOW_SECONDS);
	}
	return count > LOGIN_ATTEMPT_LIMIT;
}

export async function clearLoginRateLimit(identifier: string): Promise<void> {
	await kv().del(`login-attempts:${identifier}`);
}

const REFRESH_TOKEN_PREFIX = 'refresh-token:';

export async function storeRefreshToken(userId: string, tokenId: string, ttlSeconds: number) {
	await kv().set(`${REFRESH_TOKEN_PREFIX}${tokenId}`, userId, 'EX', ttlSeconds);
}

export async function getUserIdForRefreshToken(tokenId: string): Promise<string | null> {
	return kv().get(`${REFRESH_TOKEN_PREFIX}${tokenId}`);
}

export async function revokeRefreshToken(tokenId: string) {
	await kv().del(`${REFRESH_TOKEN_PREFIX}${tokenId}`);
}

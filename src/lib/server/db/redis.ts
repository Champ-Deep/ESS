import Redis from 'ioredis';
import { env } from '$env/dynamic/private';

export const redis = new Redis(env.REDIS_URL ?? 'redis://localhost:6379', {
	lazyConnect: true,
	maxRetriesPerRequest: 3
});

const LOGIN_ATTEMPT_LIMIT = 5;
const LOGIN_ATTEMPT_WINDOW_SECONDS = 15 * 60;

/** Returns true if the caller is currently rate-limited on login attempts. */
export async function isLoginRateLimited(identifier: string): Promise<boolean> {
	const key = `login-attempts:${identifier}`;
	const count = await redis.incr(key);
	if (count === 1) {
		await redis.expire(key, LOGIN_ATTEMPT_WINDOW_SECONDS);
	}
	return count > LOGIN_ATTEMPT_LIMIT;
}

export async function clearLoginRateLimit(identifier: string): Promise<void> {
	await redis.del(`login-attempts:${identifier}`);
}

const REFRESH_TOKEN_PREFIX = 'refresh-token:';

export async function storeRefreshToken(userId: string, tokenId: string, ttlSeconds: number) {
	await redis.set(`${REFRESH_TOKEN_PREFIX}${tokenId}`, userId, 'EX', ttlSeconds);
}

export async function getUserIdForRefreshToken(tokenId: string): Promise<string | null> {
	return redis.get(`${REFRESH_TOKEN_PREFIX}${tokenId}`);
}

export async function revokeRefreshToken(tokenId: string) {
	await redis.del(`${REFRESH_TOKEN_PREFIX}${tokenId}`);
}

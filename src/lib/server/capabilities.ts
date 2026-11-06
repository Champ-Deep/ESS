import { error, redirect, type RequestEvent } from '@sveltejs/kit';
import { db } from '$lib/server/db/postgres';
import { customRoles, users } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { effectiveCapabilities, type CapabilityKey } from '$lib/capabilities';
import type { SessionUser } from '$lib/server/auth';

/**
 * Loads what a signed-in person may do: base role defaults plus their named
 * role (src/lib/capabilities.ts).
 *
 * Read from the database rather than baked into the access token, so giving
 * or taking away a privilege applies within the cache window below instead of
 * waiting for the token to expire. Thirty seconds of staleness is the trade:
 * every request would otherwise pay a join.
 */

type Loaded = { role: SessionUser['role']; caps: CapabilityKey[]; customRoleId: string | null; customRoleName: string | null; at: number };

const TTL_MS = 30_000;
const cache = new Map<string, Loaded>();

export async function loadCapabilities(user: Pick<SessionUser, 'id' | 'role'>): Promise<Loaded> {
	const hit = cache.get(user.id);
	if (hit && hit.role === user.role && Date.now() - hit.at < TTL_MS) return hit;

	const [row] = await db
		.select({ customRoleId: users.customRoleId, name: customRoles.name, capabilities: customRoles.capabilities })
		.from(users)
		.leftJoin(customRoles, eq(customRoles.id, users.customRoleId))
		.where(eq(users.id, user.id))
		.limit(1);

	const loaded: Loaded = {
		role: user.role,
		caps: effectiveCapabilities(user.role, row?.capabilities ?? []),
		customRoleId: row?.customRoleId ?? null,
		customRoleName: row?.name ?? null,
		at: Date.now()
	};
	cache.set(user.id, loaded);
	return loaded;
}

/** Drop cached privileges after a role or named-role change. No id = everyone. */
export function invalidateCapabilities(userId?: string) {
	if (userId) cache.delete(userId);
	else cache.clear();
}

export function hasCap(user: SessionUser | null | undefined, key: CapabilityKey): boolean {
	if (!user) return false;
	if (user.role === 'super_admin') return true;
	if (key === 'system.design_tweaks') return false;
	if (key === 'policies.publish' && user.role !== 'admin') return false;
	return (user.capabilities ?? []).includes(key);
}

export function hasAnyCap(user: SessionUser | null | undefined, keys: CapabilityKey[]): boolean {
	return keys.some((k) => hasCap(user, k));
}

/** Throws 401/403 unless the signed-in person holds `key`. */
export function requireCap(event: RequestEvent, key: CapabilityKey): SessionUser {
	const user = event.locals.user;
	if (!user) throw error(401, 'Authentication required');
	if (!hasCap(user, key)) throw error(403, 'You do not have the privilege for this');
	return user;
}

/**
 * For an Admin Controls page: sends anyone without one of `keys` back to the
 * Overview. The admin layout already let them into Admin Controls; this is the
 * per-tab rule.
 */
export function gateAdminPage(locals: App.Locals, keys: CapabilityKey[]): SessionUser {
	const user = locals.user;
	if (!user) throw redirect(303, '/login');
	if (!hasAnyCap(user, keys)) throw redirect(303, '/admin');
	return user;
}

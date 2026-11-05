import { SignJWT, jwtVerify } from 'jose';
import type { Cookies } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { db } from './db/client';
import { teams, users } from './db/schema';
import { eq } from 'drizzle-orm';
import type { SessionUser } from './auth';
import { chainAbove, mayOpenPortal, type PortalActor } from '$lib/act-as';
import { isNoLoginEmail } from '$lib/no-login';

/**
 * The cookie behind "Open their portal" (src/lib/act-as.ts says who may).
 *
 * It sits on top of the real sign-in rather than replacing it: whoever opened
 * the portal stays signed in as themselves, under either sign-in (the
 * portal's own or Clerk), and the cookie only names the worker. Every request
 * re-checks it against the signed-in person — a stale cookie, a moved
 * reporting line or a worker who has since been given a login all fall back
 * to the person's own portal.
 */

const COOKIE = 'ess_act_as';
const TTL_SECONDS = 4 * 60 * 60;
const AUDIENCE = 'ess-act-as';

function secret() {
	const s = env.JWT_SECRET;
	if (!s) throw new Error('JWT_SECRET is not set');
	// Its own key, so this token can never pass for an access token or back.
	return new TextEncoder().encode(`${s}:act-as`);
}

/** Whether `actor` may open `targetId`'s portal right now. */
export async function canOpenPortal(actor: PortalActor, targetId: string): Promise<boolean> {
	if (!/^[0-9a-f-]{36}$/i.test(targetId)) return false;
	const [target] = await db
		.select({ id: users.id, email: users.email, isActive: users.isActive, teamId: users.teamId, hidden: users.hidden })
		.from(users)
		.where(eq(users.id, targetId))
		.limit(1);
	if (!target || target.hidden || !isNoLoginEmail(target.email)) return false;
	if (actor.role === 'super_admin' || actor.role === 'admin') return mayOpenPortal(actor, target, { chainAbove: [], teamLeadId: null });

	const [lines, team] = await Promise.all([
		db.select({ id: users.id, reportsTo: users.reportsTo }).from(users),
		target.teamId ? db.select({ teamLeadId: teams.teamLeadId }).from(teams).where(eq(teams.id, target.teamId)).limit(1) : Promise.resolve([])
	]);
	const reportsToOf = new Map(lines.map((l) => [l.id, l.reportsTo]));
	return mayOpenPortal(actor, target, { chainAbove: chainAbove(target.id, reportsToOf), teamLeadId: team[0]?.teamLeadId ?? null });
}

/**
 * The blue-collar workers among `people` whose portal `actor` may open — one
 * pass for a whole roster.
 */
export async function openablePortals(
	actor: PortalActor,
	people: { id: string; email: string; isActive: boolean; teamId: string | null }[]
): Promise<Set<string>> {
	const workers = people.filter((p) => isNoLoginEmail(p.email));
	if (workers.length === 0) return new Set();
	const [lines, teamRows] = await Promise.all([
		db.select({ id: users.id, reportsTo: users.reportsTo }).from(users),
		db.select({ id: teams.id, teamLeadId: teams.teamLeadId }).from(teams)
	]);
	const reportsToOf = new Map(lines.map((l) => [l.id, l.reportsTo]));
	const leadOf = new Map(teamRows.map((t) => [t.id, t.teamLeadId]));
	return new Set(
		workers
			.filter((w) =>
				mayOpenPortal(actor, w, {
					chainAbove: chainAbove(w.id, reportsToOf),
					teamLeadId: w.teamId ? (leadOf.get(w.teamId) ?? null) : null
				})
			)
			.map((w) => w.id)
	);
}

export async function startActing(cookies: Cookies, actorId: string, targetId: string): Promise<void> {
	const token = await new SignJWT({ act: actorId })
		.setProtectedHeader({ alg: 'HS256' })
		.setSubject(targetId)
		.setAudience(AUDIENCE)
		.setIssuedAt()
		.setExpirationTime(`${TTL_SECONDS}s`)
		.sign(secret());
	cookies.set(COOKIE, token, {
		path: '/',
		httpOnly: true,
		secure: env.NODE_ENV === 'production',
		sameSite: 'lax',
		maxAge: TTL_SECONDS
	});
}

export function stopActing(cookies: Cookies): void {
	cookies.delete(COOKIE, { path: '/' });
}

/**
 * The worker whose portal `realUser` has open, as the request's user — or
 * null, clearing a cookie that no longer holds.
 */
export async function actingTarget(cookies: Cookies, realUser: SessionUser): Promise<SessionUser | null> {
	const token = cookies.get(COOKIE);
	if (!token) return null;
	try {
		const { payload } = await jwtVerify(token, secret(), { audience: AUDIENCE });
		const targetId = typeof payload.sub === 'string' ? payload.sub : '';
		if (payload.act !== realUser.id || !(await canOpenPortal(realUser, targetId))) throw new Error('no longer allowed');
		const [target] = await db.select().from(users).where(eq(users.id, targetId)).limit(1);
		if (!target) throw new Error('gone');
		return {
			id: target.id,
			email: target.email,
			role: target.role,
			fullName: target.fullName,
			teamId: target.teamId,
			mustChangePassword: false
		};
	} catch {
		stopActing(cookies);
		return null;
	}
}

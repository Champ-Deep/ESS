import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/postgres';
import { delegations, users } from '$lib/server/db/schema';
import { and, eq, gte, isNull, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { requireUser } from '$lib/server/rbac';
import { hasCap } from '$lib/server/capabilities';
import { logActivity } from '$lib/server/db/mongo';
import { invalidateOrgScope, todayIst } from '$lib/server/org-scope';
import type { SessionUser } from '$lib/server/auth';
import { hiddenFrom } from '$lib/server/hidden-users';

/**
 * Manager delegations: "approve my team's requests while I'm away"
 * (src/lib/org-scope.ts). A manager delegates their own manager stage; HR
 * (people.edit_settings) or a Super Admin can set one up for a manager who is
 * away unexpectedly. The HR stage never delegates.
 *
 * GET lists live and upcoming delegations the caller is on either side of;
 * `?all=1` lists everyone's, for HR and Super Admin.
 */

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_DAYS = 90;
const mayManageOthers = (u: SessionUser) => u.role === 'super_admin' || hasCap(u, 'people.edit_settings');

export const GET: RequestHandler = async (event) => {
	const user = requireUser(event);
	const all = event.url.searchParams.get('all') === '1';
	if (all && !mayManageOthers(user)) throw error(403, 'Only HR can list every delegation');
	const from = alias(users, 'from_user');
	const to = alias(users, 'to_user');
	const live = and(
		isNull(delegations.revokedAt),
		gte(delegations.endsOn, todayIst()),
		or(eq(from.hidden, false), eq(from.id, user.id)),
		or(eq(to.hidden, false), eq(to.id, user.id))
	);
	const rows = await db
		.select({
			id: delegations.id,
			fromId: delegations.fromId,
			fromName: from.fullName,
			toId: delegations.toId,
			toName: to.fullName,
			startsOn: delegations.startsOn,
			endsOn: delegations.endsOn,
			reason: delegations.reason,
			createdAt: delegations.createdAt
		})
		.from(delegations)
		.innerJoin(from, eq(from.id, delegations.fromId))
		.innerJoin(to, eq(to.id, delegations.toId))
		.where(all ? live : and(live, or(eq(delegations.fromId, user.id), eq(delegations.toId, user.id))));
	return json({ delegations: rows });
};

export const POST: RequestHandler = async (event) => {
	const actor = requireUser(event);
	const body = (await event.request.json().catch(() => null)) as Record<string, unknown> | null;
	if (!body) throw error(400, 'Expected a JSON body');
	const fromId = typeof body.fromId === 'string' && body.fromId ? body.fromId : actor.id;
	const toId = typeof body.toId === 'string' ? body.toId : '';
	const startsOn = typeof body.startsOn === 'string' ? body.startsOn : '';
	const endsOn = typeof body.endsOn === 'string' ? body.endsOn : '';
	const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 300) : '';

	if (!UUID.test(fromId) || !UUID.test(toId)) throw error(400, 'Pick the people by their portal account');
	const onBehalf = fromId !== actor.id;
	if (onBehalf && !mayManageOthers(actor)) throw error(403, 'Only HR can set up a delegation for someone else');
	if (toId === fromId) throw error(400, 'Pick someone other than the manager');
	if (!ISO.test(startsOn) || !ISO.test(endsOn) || endsOn < startsOn) throw error(400, 'Give a start and end date, end on or after start');
	if (endsOn < todayIst()) throw error(400, 'That window is already over');
	const days = (Date.parse(endsOn) - Date.parse(startsOn)) / 86_400_000 + 1;
	if (days > MAX_DAYS) throw error(400, `Keep a delegation to ${MAX_DAYS} days or fewer`);

	const people = await db.select({ id: users.id, isActive: users.isActive, hidden: users.hidden }).from(users).where(or(eq(users.id, fromId), eq(users.id, toId)));
	if (people.length !== 2 || people.some((p) => !p.isActive || hiddenFrom(actor.id, p))) throw error(404, 'Both people must have active logins');

	const [row] = await db.insert(delegations).values({ fromId, toId, startsOn, endsOn, reason: reason || null, createdBy: actor.id }).returning();
	await logActivity({
		actorUserId: actor.id,
		action: 'delegation.create',
		targetType: 'user',
		targetId: fromId,
		details: { delegationId: row.id, toId, startsOn, endsOn, onBehalf }
	});
	invalidateOrgScope();
	return json({ delegation: row }, { status: 201 });
};

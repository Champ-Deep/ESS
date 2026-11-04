import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/postgres';
import { delegations } from '$lib/server/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import { requireUser } from '$lib/server/rbac';
import { hasCap } from '$lib/server/capabilities';
import { logActivity } from '$lib/server/db/mongo';
import { invalidateOrgScope } from '$lib/server/org-scope';

/** Ends a delegation early. Kept as a row (revoked_at) so the audit holds. */
export const DELETE: RequestHandler = async (event) => {
	const actor = requireUser(event);
	if (!/^[0-9a-f-]{36}$/i.test(event.params.id)) throw error(404, 'That delegation is not active');
	const [row] = await db
		.select()
		.from(delegations)
		.where(and(eq(delegations.id, event.params.id), isNull(delegations.revokedAt)))
		.limit(1);
	if (!row) throw error(404, 'That delegation is not active');
	const mayEnd = row.fromId === actor.id || row.toId === actor.id || actor.role === 'super_admin' || hasCap(actor, 'people.edit_settings');
	if (!mayEnd) throw error(403, 'Only the people involved or HR can end this');
	await db.update(delegations).set({ revokedAt: new Date() }).where(eq(delegations.id, row.id));
	await logActivity({
		actorUserId: actor.id,
		action: 'delegation.revoke',
		targetType: 'user',
		targetId: row.fromId,
		details: { delegationId: row.id }
	});
	invalidateOrgScope();
	return json({ ok: true });
};

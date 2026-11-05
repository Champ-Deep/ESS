import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireCap, loadCapabilities } from '$lib/server/capabilities';
import { db } from '$lib/server/db/client';
import { users } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { hiddenFrom } from '$lib/server/hidden-users';
import { explainReach } from '$lib/server/org-scope';
import { SCOPE_PERMISSIONS } from '$lib/org-scope';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * "Why can A see B?" for Admin Controls › Roles & access.
 * GET ?actor=<userId>&target=<userId> → every scoped permission with the
 * privilege or relationship that grants it. Needs "See roles and access".
 */
export const GET: RequestHandler = async (event) => {
	const viewer = requireCap(event, 'access.view');
	const actorId = event.url.searchParams.get('actor') ?? '';
	const targetId = event.url.searchParams.get('target') ?? '';
	if (!UUID.test(actorId) || !UUID.test(targetId)) throw error(400, 'actor and target must be user ids');

	const [[row], [target]] = await Promise.all([
		db.select({ id: users.id, role: users.role, hidden: users.hidden }).from(users).where(eq(users.id, actorId)).limit(1),
		db.select({ id: users.id, hidden: users.hidden }).from(users).where(eq(users.id, targetId)).limit(1)
	]);
	if (!row || !target || hiddenFrom(viewer.id, row) || hiddenFrom(viewer.id, target)) throw error(404, 'No such person');
	const caps = await loadCapabilities({ id: row.id, role: row.role });
	const actor = { id: row.id, role: row.role, capabilities: caps.caps };
	const permissions = Object.fromEntries(
		await Promise.all(SCOPE_PERMISSIONS.map(async (p) => [p, await explainReach(actor, targetId, p)] as const))
	);
	return json({ actorId, targetId, permissions });
};

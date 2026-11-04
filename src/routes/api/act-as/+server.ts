import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { canOpenPortal, startActing, stopActing } from '$lib/server/act-as';
import { db } from '$lib/server/db/postgres';
import { users } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { logActivity } from '$lib/server/db/store';

/**
 * Opens (POST { userId }) or closes (DELETE) a blue-collar worker's portal.
 * Who may is src/lib/act-as.ts; the cookie is src/lib/server/act-as.ts.
 */
export const POST: RequestHandler = async ({ locals, cookies, request }) => {
	const actor = locals.user;
	if (!actor) throw error(401, 'Sign in first');
	// One portal at a time: go back to your own before opening another.
	if (locals.actingFor) throw error(400, 'Go back to your own account first');
	const { userId } = await request.json().catch(() => ({}));
	if (typeof userId !== 'string' || !(await canOpenPortal(actor, userId))) {
		throw error(403, 'You cannot open this person’s portal');
	}
	const [target] = await db.select({ fullName: users.fullName }).from(users).where(eq(users.id, userId)).limit(1);
	await startActing(cookies, actor.id, userId);
	await logActivity({
		actorUserId: actor.id,
		action: 'user.portal_open',
		targetType: 'user',
		targetId: userId,
		details: { fullName: target?.fullName ?? null }
	});
	return json({ ok: true });
};

export const DELETE: RequestHandler = async ({ locals, cookies }) => {
	stopActing(cookies);
	if (locals.actingFor && locals.user) {
		await logActivity({
			actorUserId: locals.actingFor.id,
			action: 'user.portal_close',
			targetType: 'user',
			targetId: locals.user.id,
			details: { fullName: locals.user.fullName }
		});
	}
	return json({ ok: true });
};

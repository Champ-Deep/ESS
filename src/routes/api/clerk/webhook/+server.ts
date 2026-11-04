import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { verifyWebhook } from 'svelte-clerk/webhooks';
import { db } from '$lib/server/db/postgres';
import { users } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { logActivity } from '$lib/server/db/mongo';

/**
 * Clerk → portal events, signed by Svix with CLERK_WEBHOOK_SIGNING_SECRET.
 * Sign-ins and sign-outs land in the same activity log as everything else, so
 * the audit trail keeps covering logins after Clerk takes them over.
 */
export const POST: RequestHandler = async ({ request }) => {
	let evt;
	try {
		evt = await verifyWebhook(request);
	} catch {
		throw error(400, 'Invalid signature');
	}

	const portalUserId = async (clerkUserId: string | undefined) => {
		if (!clerkUserId) return null;
		const [row] = await db.select({ id: users.id }).from(users).where(eq(users.clerkUserId, clerkUserId)).limit(1);
		return row?.id ?? null;
	};

	switch (evt.type) {
		case 'session.created':
		case 'session.ended':
		case 'session.revoked': {
			const userId = await portalUserId(evt.data.user_id);
			if (userId) {
				await logActivity({
					actorUserId: userId,
					action: evt.type === 'session.created' ? 'auth.login' : 'auth.logout',
					targetType: 'user',
					targetId: userId,
					details: { provider: 'clerk', clerkSessionId: evt.data.id, event: evt.type }
				});
			}
			break;
		}
		case 'user.deleted': {
			// Deleted in the Clerk Dashboard: that person can no longer sign in.
			// Their portal record is left as it is; HR decides what happens to it.
			const userId = await portalUserId(evt.data.id);
			if (userId) {
				await db.update(users).set({ clerkUserId: null }).where(eq(users.id, userId));
				await logActivity({
					actorUserId: userId,
					action: 'auth.clerk_user_deleted',
					targetType: 'user',
					targetId: userId,
					details: { clerkUserId: evt.data.id }
				});
			}
			break;
		}
	}
	return json({ ok: true });
};

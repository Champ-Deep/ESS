import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { recordView } from '$lib/server/engagement';

/** Marks one reel or celebration as watched today (for the studio's numbers). */
export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) throw error(401, 'Sign in again to continue');
	const body = (await request.json().catch(() => ({}))) as { key?: unknown };
	if (typeof body.key === 'string') await recordView(locals.user, body.key);
	return json({ ok: true });
};

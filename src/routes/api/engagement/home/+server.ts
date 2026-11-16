import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { homeReel, loadBrand } from '$lib/server/engagement';

/** Today's Home reel for the signed-in person (celebrations, then reels) and the brand kit to draw them in. */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'Sign in again to continue');
	const [items, brand] = await Promise.all([homeReel(locals.user), loadBrand()]);
	return json({ items, brand });
};

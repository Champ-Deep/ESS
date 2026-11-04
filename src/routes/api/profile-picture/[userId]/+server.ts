import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/rbac';
import { getProfilePicture } from '$lib/server/db/mongo';

/**
 * Serves an employee's profile picture. Any signed-in user may view any
 * colleague's picture — the same as seeing their name in the roster — but
 * only the owner can change it (see POST /api/profile-picture).
 */
export const GET: RequestHandler = async (event) => {
	requireUser(event);
	const picture = await getProfilePicture(event.params.userId);
	if (!picture) throw error(404, 'No profile picture');

	const bytes = Buffer.from(picture.fileBase64, 'base64');

	return new Response(new Uint8Array(bytes), {
		headers: {
			'Content-Type': picture.mimeType,
			'Content-Length': String(bytes.length),
			// Private: these are employee photos, so proxies must not cache them.
			// The short max-age keeps repeat renders cheap; ?v=<updatedAt> on the
			// img src busts it the moment someone uploads a new one.
			'Cache-Control': 'private, max-age=300',
			'Last-Modified': picture.updatedAt.toUTCString()
		}
	});
};

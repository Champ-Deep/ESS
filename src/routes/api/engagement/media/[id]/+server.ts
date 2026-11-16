import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { mediaInfo, mediaStream, parseRange } from '$lib/server/engagement-media';

/**
 * Streams an engagement video from the portal's own storage (GridFS), with
 * byte ranges so players can seek and Safari will play it. Signed-in people
 * only; ids never change, so the browser may keep a copy.
 */
export const GET: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.user) throw error(401, 'Sign in again to continue');
	const info = await mediaInfo(params.id);
	if (!info) throw error(404, 'That video is no longer available');
	const headers = {
		'Content-Type': info.contentType,
		'Accept-Ranges': 'bytes',
		'Cache-Control': 'private, max-age=86400, immutable',
		'X-Content-Type-Options': 'nosniff'
	};
	const rangeHeader = request.headers.get('range');
	const range = parseRange(rangeHeader, info.length);
	if (rangeHeader && !range) {
		return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${info.length}` } });
	}
	const { start, end } = range ?? { start: 0, end: info.length - 1 };
	return new Response(await mediaStream(params.id, start, end), {
		status: range ? 206 : 200,
		headers: { ...headers, 'Content-Length': String(end - start + 1), ...(range ? { 'Content-Range': `bytes ${start}-${end}/${info.length}` } : {}) }
	});
};

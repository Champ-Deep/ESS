import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/rbac';
import { findVisible } from '$lib/server/announcements';
import { getAnnouncementFile } from '$lib/server/db/mongo';

/** The file attached to an announcement, for anyone the post is meant for. */
export const GET: RequestHandler = async (event) => {
	const user = requireUser(event);
	const isAdmin = user.role === 'admin' || user.role === 'super_admin';
	const post = await findVisible(user.id, isAdmin, event.params.id);
	if (!post?.attachmentId) throw error(404, 'No attachment');

	const file = await getAnnouncementFile(post.attachmentId);
	if (!file) throw error(404, 'The attachment is no longer available');

	const safeName = file.filename.replace(/["\\r\n]/g, '');
	return new Response(Buffer.from(file.fileBase64, 'base64'), {
		headers: {
			'Content-Type': file.mimeType,
			// Inline so a PDF or image opens in the browser tab.
			'Content-Disposition': `inline; filename="${safeName}"`,
			'X-Content-Type-Options': 'nosniff'
		}
	});
};

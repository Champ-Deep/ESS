import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireCap } from '$lib/server/capabilities';
import { deletePolicyDocument, getPolicyDocument, logActivity } from '$lib/server/db/mongo';

/** The uploaded file itself, so an admin can check what a calendar or policy was read from. */
export const GET: RequestHandler = async (event) => {
	requireCap(event, 'policies.publish');
	const doc = await getPolicyDocument(event.params.id).catch(() => null);
	if (!doc) throw error(404, 'Document not found');
	const safeName = doc.filename.replace(/["\r\n]/g, '');
	return new Response(Buffer.from(doc.fileBase64, 'base64'), {
		headers: {
			'Content-Type': doc.mimeType,
			'Content-Disposition': `inline; filename="${safeName}"`,
			'Cache-Control': 'private, no-store'
		}
	});
};

/**
 * Deletes an uploaded policy document. What was published from it stays in
 * effect — delete or archive the calendar or leave type for that — and a
 * corrected document can be uploaded again at any time.
 */
export const DELETE: RequestHandler = async (event) => {
	const user = requireCap(event, 'policies.publish');
	const id = event.params.id;
	const doc = await getPolicyDocument(id).catch(() => null);
	if (!doc || !(await deletePolicyDocument(id))) throw error(404, 'Document not found');

	await logActivity({
		actorUserId: user.id,
		action: 'policy_document.delete',
		targetType: 'policy_document',
		targetId: id,
		details: { filename: doc.filename, kind: doc.kind, status: doc.status }
	});
	return json({ ok: true });
};

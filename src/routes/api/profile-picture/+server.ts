import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/rbac';
import { upsertProfilePicture, deleteProfilePicture, logActivity } from '$lib/server/db/mongo';

// Images arrive already resized to a small square by the browser (see
// AvatarUpload.svelte), so anything large means the client-side step was
// bypassed — reject rather than store an unbounded blob.
const MAX_BYTES = 512 * 1024;
const ALLOWED = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * Uploads the signed-in user's own profile picture. Every role can do this;
 * nobody can change anyone else's — the target is always the session user, so
 * there is no id parameter to tamper with.
 */
export const POST: RequestHandler = async (event) => {
	const user = requireUser(event);

	const form = await event.request.formData();
	const file = form.get('file');

	if (!(file instanceof File) || file.size === 0) {
		throw error(400, 'Choose an image to upload');
	}
	if (!ALLOWED.includes(file.type)) {
		throw error(400, 'Profile picture must be a JPEG, PNG, or WebP image');
	}
	if (file.size > MAX_BYTES) {
		throw error(400, 'Image is too large — please choose a smaller picture');
	}

	const buffer = Buffer.from(await file.arrayBuffer());

	await upsertProfilePicture({
		userId: user.id,
		mimeType: file.type,
		fileBase64: buffer.toString('base64'),
		byteSize: buffer.length
	});

	await logActivity({
		actorUserId: user.id,
		action: 'profile.picture_update',
		targetType: 'user',
		targetId: user.id,
		details: { byteSize: buffer.length, mimeType: file.type }
	});

	return json({ ok: true, updatedAt: new Date().toISOString() });
};

/** Removes the signed-in user's own picture, falling back to their initials. */
export const DELETE: RequestHandler = async (event) => {
	const user = requireUser(event);

	await deleteProfilePicture(user.id);

	await logActivity({
		actorUserId: user.id,
		action: 'profile.picture_remove',
		targetType: 'user',
		targetId: user.id
	});

	return json({ ok: true });
};

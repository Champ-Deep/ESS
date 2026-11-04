import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { insertPolicyDocument, updatePolicyDocument, logActivity } from '$lib/server/db/mongo';
import { extractHolidayCalendar, extractLeavePolicy } from '$lib/server/ai/extract-policy';
import { env } from '$env/dynamic/private';
import { requireCap } from '$lib/server/capabilities';

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10MB — well above any real policy doc/scan

/**
 * Super Admin uploads a raw holiday-calendar or leave-policy document (image or PDF).
 * The file is stored in Mongo (system of record for versioned/rich-content documents,
 * PRD §6.2) and immediately sent to the vision-capable LLM to extract structured rows.
 * Nothing is written to Postgres yet — the admin reviews/edits the extraction first
 * (see POST .../publish-holiday-calendar and .../publish-leave-policy).
 */
export const POST: RequestHandler = async (event) => {
	const user = requireCap(event, 'policies.publish');

	const form = await event.request.formData();
	const file = form.get('file');
	const kind = form.get('kind');

	if (!(file instanceof File)) throw error(400, 'file is required');
	if (kind !== 'holiday_calendar' && kind !== 'leave_policy') {
		throw error(400, 'kind must be "holiday_calendar" or "leave_policy"');
	}
	if (file.size > MAX_UPLOAD_BYTES) throw error(400, 'File too large (max 10MB)');

	const allowedMimeTypes = ['image/jpeg', 'image/png', 'application/pdf'];
	if (!allowedMimeTypes.includes(file.type)) {
		throw error(400, `Unsupported file type: ${file.type}. Allowed: JPEG, PNG, PDF`);
	}

	const buffer = Buffer.from(await file.arrayBuffer());
	const fileBase64 = buffer.toString('base64');

	const documentId = await insertPolicyDocument({
		kind,
		filename: file.name,
		mimeType: file.type,
		fileBase64,
		uploadedBy: user.id,
		status: 'uploaded'
	});

	try {
		const extracted =
			kind === 'holiday_calendar'
				? await extractHolidayCalendar(fileBase64, file.type, file.name)
				: await extractLeavePolicy(fileBase64, file.type, file.name);

		await updatePolicyDocument(documentId, {
			extractedJson: extracted,
			extractionModel: env.OPENROUTER_MODEL ?? 'google/gemini-3.5-flash',
			status: 'extracted'
		});

		await logActivity({
			actorUserId: user.id,
			action: 'policy_document.upload_and_extract',
			targetType: 'policy_document',
			targetId: documentId,
			details: { kind, filename: file.name }
		});

		return json({ documentId, kind, extracted }, { status: 201 });
	} catch (err) {
		await updatePolicyDocument(documentId, { status: 'extraction_failed' });
		await logActivity({
			actorUserId: user.id,
			action: 'policy_document.extraction_failed',
			targetType: 'policy_document',
			targetId: documentId,
			details: { kind, filename: file.name, error: err instanceof Error ? err.message : String(err) }
		});
		throw error(502, `Upload saved, but AI extraction failed: ${err instanceof Error ? err.message : String(err)}`);
	}
};

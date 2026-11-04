import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { parseBiometricSheet, BiometricSheetError } from '$lib/server/biometric-sheet';
import { applyBiometricDays } from '$lib/server/biometric-apply';
import { logActivity } from '$lib/server/db/mongo';
import { requireCap } from '$lib/server/capabilities';

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

/**
 * Applies a manually uploaded biometric report to attendance — Super Admin and
 * Admin (HR).
 *
 * Takes the same file the preview accepted and writes it: `attendance` gets each
 * employee's in/out for the day, `device_punches` gets the audit trail, and
 * `attendance_imports` records who uploaded what. The employee's own attendance
 * page reads those tables, so the day appears on their calendar immediately.
 */
export const POST: RequestHandler = async (event) => {
	const user = requireCap(event, 'attendance.biometric_upload');

	const form = await event.request.formData();
	const file = form.get('file');
	const suppliedDate = form.get('date');
	const overwrite = form.get('overwrite');

	if (!(file instanceof File)) throw error(400, 'file is required');
	if (file.size === 0) throw error(400, 'That file is empty');
	if (file.size > MAX_UPLOAD_BYTES) throw error(400, 'File too large (max 15MB)');

	const date = typeof suppliedDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(suppliedDate)
		? suppliedDate
		: null;

	const buffer = Buffer.from(await file.arrayBuffer());

	let parsed;
	try {
		parsed = await parseBiometricSheet(buffer, { filename: file.name, suppliedDate: date });
	} catch (err) {
		if (err instanceof BiometricSheetError) throw error(400, err.message);
		throw err;
	}

	const result = await applyBiometricDays(parsed.days, {
		uploadedBy: user.id,
		filename: file.name,
		overwriteExisting: overwrite === 'true'
	});

	// Attendance is payroll input, so who changed it is worth keeping outside the
	// attendance tables themselves.
	await logActivity({
		actorUserId: user.id,
		action: 'attendance.biometric_upload',
		targetType: 'attendance_import',
		targetId: result.importId,
		details: {
			filename: file.name,
			layout: parsed.layout,
			rowCount: result.rowCount,
			matchedCount: result.matchedCount,
			unmatchedCount: result.unmatchedCount,
			createdCount: result.createdCount,
			updatedCount: result.updatedCount,
			overwrite: overwrite === 'true'
		}
	}).catch(() => {
		// Mongo is the activity log, not the system of record for attendance — a
		// logging outage must not undo an applied import.
	});

	return json(result);
};

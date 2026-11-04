import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { logActivity } from '$lib/server/db/mongo';
import { runCleanup, type CleanupOptions } from '$lib/server/admin-cleanup';
import { requireCap } from '$lib/server/capabilities';

/**
 * Bulk maintenance reset — Super Admin only. Each part is opt-in and the
 * signed-in account is always preserved, so this can't lock anyone out.
 * Intended for clearing seeded/test data from a portal before real use.
 */
export const POST: RequestHandler = async (event) => {
	const actor = requireCap(event, 'system.cleanup');
	const body = await event.request.json();

	const options: CleanupOptions = {
		seededLeaveTypes: body.seededLeaveTypes === true,
		leaveAndAttendanceData: body.leaveAndAttendanceData === true,
		otherEmployees: body.otherEmployees === true,
		bulkImportHistory: body.bulkImportHistory === true
	};

	if (!Object.values(options).some(Boolean)) {
		throw error(400, 'Select at least one thing to clean up');
	}

	const counts = await runCleanup(actor.id, options);

	await logActivity({
		actorUserId: actor.id,
		action: 'admin.cleanup',
		targetType: 'system',
		details: { options, counts }
	});

	return json({ counts });
};

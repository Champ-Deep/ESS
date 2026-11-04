import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/postgres';
import { leaveTypes } from '$lib/server/db/schema';
import { logActivity } from '$lib/server/db/mongo';
import { eq } from 'drizzle-orm';
import { requireCap } from '$lib/server/capabilities';

/** Brings an archived leave type back, so employees can apply for it again. */
export const POST: RequestHandler = async (event) => {
	const user = requireCap(event, 'policies.publish');
	const leaveTypeId = event.params.id;

	const [restored] = await db
		.update(leaveTypes)
		.set({ isActive: true })
		.where(eq(leaveTypes.id, leaveTypeId))
		.returning();
	if (!restored) throw error(404, 'Leave type not found');

	await logActivity({
		actorUserId: user.id,
		action: 'leave_type.restore',
		targetType: 'leave_type',
		targetId: leaveTypeId,
		details: { code: restored.code, name: restored.name }
	});

	return json({ leaveType: restored });
};

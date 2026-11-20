import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/postgres';
import { leaveApplications, leaveTypes } from '$lib/server/db/schema';
import { requireUser } from '$lib/server/rbac';
import { and, eq, inArray } from 'drizzle-orm';
import { logActivity } from '$lib/server/db/mongo';
import { isCompOffLeaveCode, releaseCredits } from '$lib/server/comp-off';
import { notifyDecision } from '$lib/server/chat/cards';

/**
 * The applicant withdraws their own leave request while it is still waiting
 * (with the manager, or with HR after the manager's sign-off). Nothing has
 * been taken from the balance yet — that happens at approval — so the only
 * thing to give back is comp-off credits, which are reserved at apply time.
 * A decided request is not withdrawn here: changing an approval is a Super
 * Admin reversal on the approve endpoint.
 */
export const POST: RequestHandler = async (event) => {
	const user = requireUser(event);
	const id = event.params.id!;

	const [application] = await db.select().from(leaveApplications).where(eq(leaveApplications.id, id)).limit(1);
	if (!application || application.userId !== user.id) throw error(404, 'Leave request not found');
	if (application.status !== 'pending' && application.status !== 'escalated') {
		throw error(
			400,
			application.status === 'cancelled'
				? 'This request was already withdrawn'
				: 'This request has already been decided. Ask HR if it needs to change.'
		);
	}

	const [type] = await db.select({ code: leaveTypes.code }).from(leaveTypes).where(eq(leaveTypes.id, application.leaveTypeId)).limit(1);

	let withdrawn = false;
	await db.transaction(async (tx) => {
		// Guarded on the status so a decision landing at the same moment wins
		// cleanly instead of being overwritten.
		const rows = await tx
			.update(leaveApplications)
			.set({ status: 'cancelled', decidedAt: new Date(), decisionNote: 'Withdrawn by the employee' })
			.where(and(eq(leaveApplications.id, id), inArray(leaveApplications.status, ['pending', 'escalated'])))
			.returning({ id: leaveApplications.id });
		withdrawn = rows.length > 0;
		if (withdrawn && isCompOffLeaveCode(type?.code)) await releaseCredits(id, tx);
	});
	if (!withdrawn) throw error(409, 'This request was decided just now. Refresh to see the outcome.');

	await logActivity({
		actorUserId: user.id,
		action: 'leave.withdrawn',
		targetType: 'leave_application',
		targetId: id,
		details: { previousStatus: application.status, days: Number(application.days) }
	});

	// Approvers' cards for this request update to show it is gone.
	void notifyDecision('leave', id, user.id).catch((err) => console.error('[chat] card failed:', err));
	return json({ ok: true });
};

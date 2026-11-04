import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/postgres';
import { compOffCredits } from '$lib/server/db/schema';
import { requireUser } from '$lib/server/rbac';
import { eq } from 'drizzle-orm';
import { logActivity } from '$lib/server/db/mongo';

/**
 * Withdraws a comp-off claim the employee raised themselves.
 *
 * Only while it is still undecided. Once HR has credited it the day is a real
 * balance the employee may already have spent, and once spent it backs a leave
 * application — deleting either would silently take back leave that was granted.
 * A credited comp-off is HR's to reverse, not the claimant's to delete.
 *
 * Deleted rather than marked cancelled: a claim nobody acted on carries no
 * decision worth auditing, and leaving withdrawn rows behind would clutter the
 * employee's own list. The activity log records that it happened.
 */
export const DELETE: RequestHandler = async (event) => {
	const user = requireUser(event);
	const creditId = event.params.id!;

	const [credit] = await db
		.select()
		.from(compOffCredits)
		.where(eq(compOffCredits.id, creditId))
		.limit(1);
	if (!credit) throw error(404, 'Comp-off claim not found');

	// Your own only. A manager withdrawing someone's claim would look like an
	// approval decision without being recorded as one — they reject instead.
	if (credit.userId !== user.id) {
		throw error(403, 'You can only withdraw your own comp-off claim');
	}

	// The one hard stop: a spent credit is backing a leave application, so
	// removing it would leave that leave unfunded.
	if (credit.status === 'used' || credit.usedApplicationId) {
		throw error(400, 'This comp-off has been spent on leave and can no longer be withdrawn');
	}
	// Credited but unspent is still the employee's to give up — it is their own
	// day off to decline, and holding one they did not want is not something they
	// should have to ask HR to undo.
	if (!['pending', 'manager_approved', 'approved'].includes(credit.status)) {
		throw error(400, `A ${credit.status} claim cannot be withdrawn`);
	}

	await db.delete(compOffCredits).where(eq(compOffCredits.id, creditId));

	await logActivity({
		actorUserId: user.id,
		action: 'comp_off.withdrawn',
		targetType: 'comp_off_credit',
		targetId: creditId,
		details: {
			workedDate: credit.workedDate,
			// Worth recording: withdrawing after a manager signed off wastes their
			// review, and a pattern of it is something HR would want to see.
			statusWhenWithdrawn: credit.status
		}
	});

	return json({ ok: true, withdrawn: creditId });
};

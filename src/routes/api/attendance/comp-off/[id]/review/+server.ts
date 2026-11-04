import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/postgres';
import { compOffCredits, users } from '$lib/server/db/schema';
import { requireUser } from '$lib/server/rbac';
import { eq } from 'drizzle-orm';
import { logActivity } from '$lib/server/db/mongo';
import { evaluateCompOffEligibility } from '$lib/server/comp-off';
import { canReviewStage, isSingleStageFor } from '$lib/server/approval-chain';
import { notifyNewRequest, notifyDecision } from '$lib/server/chat/cards';
import { hiddenFrom } from '$lib/server/hidden-users';

/**
 * SOP §1: verify attendance, confirm 7+ hours, then credit the comp-off.
 *
 * Comp-off is a ONE-step approval — the claimant's reporting manager decides and
 * that credits it. The only question is whether the person really worked the
 * day, which the manager is the one placed to answer; there is no HR stage to
 * add. Leave and attendance corrections keep the two-step manager → HR chain.
 *
 * Eligibility is re-checked at decision time rather than trusting the snapshot
 * taken when the employee claimed. A ProHance re-sync between claim and decision
 * can change the worked hours, and crediting a comp-off the record no longer
 * supports is exactly what the verification step is meant to prevent.
 */
export const POST: RequestHandler = async (event) => {
	// Authorisation is by assignment — canReviewStage below is the real gate. A
	// named reporting manager may hold no admin role, and a role check here
	// refused them before that logic ever ran.
	const approver = requireUser(event);
	const creditId = event.params.id!;
	const { decision, note } = await event.request.json();

	if (decision !== 'approve' && decision !== 'reject') {
		throw error(400, "decision must be 'approve' or 'reject'");
	}

	const [credit] = await db
		.select()
		.from(compOffCredits)
		.where(eq(compOffCredits.id, creditId))
		.limit(1);
	if (!credit) throw error(404, 'Comp-off claim not found');

	// A credited comp-off can still be overturned — an approval given in error
	// (or under the old single-step flow) otherwise leaves the employee holding a
	// day they were never really owed. Refused once spent: the credit is backing
	// a leave application, and revoking it would leave that leave unfunded.
	const isReversal = credit.status === 'approved';
	if (isReversal) {
		if (credit.usedApplicationId || credit.status === 'used') {
			throw error(400, 'This comp-off has been spent on leave and can no longer be reversed');
		}
		if (decision === 'approve') {
			throw error(400, 'This comp-off is already credited');
		}
	} else if (credit.status !== 'pending' && credit.status !== 'manager_approved') {
		throw error(400, 'This claim has already been decided');
	}

	// Comp-off runs manager → HR → credited, the same chain as leave and
	// attendance corrections. Which stage this call decides depends on where the
	// claim currently sits. Reversing a credited one is HR's call.
	const stage = credit.status === 'manager_approved' || isReversal ? 'hr' : 'manager';

	const [claimant] = await db.select().from(users).where(eq(users.id, credit.userId)).limit(1);
	if (!claimant || hiddenFrom(approver.id, claimant)) throw error(404, 'Claiming employee not found');

	// No distinct manager to give the first sign-off means HR covers both stages,
	// so this one approval credits the day. Without this the same person had to
	// approve twice and the first click credited nothing. Keyed on the approver
	// too, so a manager acting alone still hands over to the concerned HR.
	const singleStage = stage === 'manager' && (await isSingleStageFor(approver, claimant.id));

	// Routed by the reporting line, not by role: the claimant's own manager gives
	// the first sign-off, then their concerned HR credits it. Admins remain the
	// fallback when nobody is assigned, so a claim is never stranded — which is
	// what previously left a Super Admin's own claim pending with nobody able to
	// see it.
	// Whoever gave the manager sign-off cannot also credit it at the HR stage, or
	// a Super Admin who is the reporting manager walks the whole chain alone.
	const priorApproverId = stage === 'hr' ? credit.approverId : null;

	if (!(await canReviewStage(approver, claimant.id, stage, priorApproverId))) {
		throw error(
			403,
			claimant.id === approver.id
				? 'You cannot approve your own comp-off claim'
				: priorApproverId === approver.id
					? 'You gave the manager sign-off, so the concerned HR has to credit this one'
					: stage === 'hr'
						? 'This claim has manager sign-off and is now waiting on HR'
						: "Only this employee's reporting manager can give the first sign-off"
		);
	}

	// Re-verify against the current record before crediting. Only at the stage that
	// actually credits: that is the point the credit becomes real, and a ProHance
	// re-sync between the manager's sign-off and HR's could change the worked hours.
	let recheck: Awaited<ReturnType<typeof evaluateCompOffEligibility>> | null = null;
	if (decision === 'approve' && (stage === 'hr' || singleStage)) {
		recheck = await evaluateCompOffEligibility(credit.userId, credit.workedDate);
		// The claim itself is the one live row for this date, so "already claimed"
		// is expected here and is not a reason to refuse.
		const blocking = recheck.reasons.filter((r) => !r.includes('already been claimed'));
		if (blocking.length > 0) {
			throw error(422, `Cannot credit this comp-off — ${blocking[0]}`);
		}
	}

	// A rejection ends it at either stage. The manager's approval hands over to
	// HR; only HR's approval credits the day — unless there is no separate manager,
	// in which case this approval is the one that credits it.
	const newStatus =
		decision === 'reject'
			? 'rejected'
			: stage === 'hr' || singleStage
				? 'approved'
				: 'manager_approved';

	const [updated] = await db
		.update(compOffCredits)
		.set({
			status: newStatus,
			approverId: approver.id,
			decidedAt: new Date(),
			decisionNote: typeof note === 'string' && note.trim() ? note.trim().slice(0, 500) : null,
			// Keep the verified hours, so the credited balance reflects what HR confirmed.
			...(recheck?.workedMinutes != null ? { workedMinutes: recheck.workedMinutes } : {})
		})
		.where(eq(compOffCredits.id, creditId))
		.returning();

	await logActivity({
		actorUserId: approver.id,
		action: `comp_off.${newStatus}`,
		targetType: 'comp_off_credit',
		targetId: creditId,
		details: {
			workedDate: credit.workedDate,
			employeeId: credit.userId,
			workedMinutes: updated.workedMinutes,
			expiresOn: updated.expiresOn
		}
	});

	// Champ Chat: a card in each approver's ESS feed, and every copy kept current.
	void notifyDecision('comp_off', updated.id, approver.id).catch((err) => console.error('[chat] card failed:', err));
	return json({ credit: updated });
};

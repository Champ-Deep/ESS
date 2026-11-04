import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/postgres';
import {
	leaveApplications,
	leaveAllocations,
	leaveLedger,
	leaveTypes,
	teams,
	users
} from '$lib/server/db/schema';
import { requireUser } from '$lib/server/rbac';
import { eq, and } from 'drizzle-orm';
import { logActivity } from '$lib/server/db/mongo';
import { canReviewStage, isSingleStageFor } from '$lib/server/approval-chain';
import { isCompOffLeaveCode, consumeCredits, releaseCredits } from '$lib/server/comp-off';
import { notifyNewRequest, notifyDecision } from '$lib/server/chat/cards';
import { hiddenFrom } from '$lib/server/hidden-users';

const newStatusFor = (decision: 'approve' | 'reject') =>
	decision === 'approve' ? ('approved' as const) : ('rejected' as const);

export const POST: RequestHandler = async (event) => {
	// Authorisation is by assignment, not role — canReviewStage below is the real
	// gate. A named reporting manager or concerned HR may hold no admin role, and
	// a role check here refused them before that logic ever ran.
	const approver = requireUser(event);
	const applicationId = event.params.id!;
	const { decision, note } = await event.request.json(); // decision: 'approve' | 'reject'

	if (decision !== 'approve' && decision !== 'reject') {
		throw error(400, "decision must be 'approve' or 'reject'");
	}

	const [application] = await db
		.select()
		.from(leaveApplications)
		.where(eq(leaveApplications.id, applicationId))
		.limit(1);

	if (!application) throw error(404, 'Leave application not found');
	// A withdrawn request is out of the flow entirely — there is nothing to
	// decide and nothing to overturn.
	if (application.status === 'cancelled') {
		throw error(400, 'This application was cancelled and can no longer be decided');
	}

	// A decided application is normally final. A Super Admin may still overturn
	// it — an approval given in error otherwise has no route back, and the
	// employee's balance stays spent. Reversing settles the balance below rather
	// than only flipping the status.
	// Only a *settled* decision is a reversal. 'escalated' is mid-chain — the
	// manager has signed off and HR has yet to — so completing it is a normal
	// second-stage decision, not an overturn.
	const isReversal = application.status === 'approved' || application.status === 'rejected';
	if (isReversal) {
		if (approver.role !== 'super_admin') {
			throw error(403, 'Only a Super Admin can change a decision that has already been made');
		}
		if (application.status === newStatusFor(decision)) {
			throw error(400, `This application is already ${application.status}`);
		}
	}

	const [applicant] = await db.select().from(users).where(eq(users.id, application.userId)).limit(1);
	if (!applicant || hiddenFrom(approver.id, applicant)) throw error(404, 'Applicant not found');

	// Leave runs manager → HR → approved. `escalated` is the middle of that
	// chain: the manager has signed off and HR has yet to.
	const stage = application.status === 'escalated' ? 'hr' : 'manager';

	// When no distinct manager fills the first stage — someone who reports to
	// Chief, or has no reporting line at all — the person who would close it at
	// HR is standing in for the manager too, and one approval finishes it.
	// Without this they approved twice: the first click only escalated it back
	// to themselves. Same rule as comp-off and attendance corrections.
	const singleStage =
		!isReversal && stage === 'manager' && (await isSingleStageFor(approver, applicant.id));

	// Reversal is Super-Admin-only (enforced above), so the stage guard and the
	// Team Lead limits only ever apply to a live request.
	if (!isReversal) {
		if (!(await canReviewStage(approver, applicant.id, stage))) {
			throw error(
				403,
				applicant.id === approver.id
					? 'You cannot approve your own leave'
					: stage === 'hr'
						? 'This request has manager sign-off and is now waiting on HR'
						: "Only this employee's reporting manager can give the first sign-off"
			);
		}

		if (approver.role === 'team_lead') {
			const [team] = await db.select().from(teams).where(eq(teams.id, approver.teamId ?? '')).limit(1);
			const threshold = team?.maxLeaveDaysAutoApprove ?? 2;
			if (Number(application.days) > threshold) {
				throw error(
					403,
					`Exceeds auto-approve threshold of ${threshold} day(s); must be approved by Super Admin`
				);
			}
		}
	}

	// A rejection ends it at either stage. A reversal is a Super Admin setting the
	// final state directly, so it skips the chain. Otherwise a manager's approval
	// hands over to HR; only HR's approval is final.
	const newStatus =
		decision === 'reject'
			? ('rejected' as const)
			: isReversal || stage === 'hr' || singleStage
				? ('approved' as const)
				: ('escalated' as const);
	const days = Number(application.days);

	// The balance only moves when the *approved-ness* changes: pending→rejected
	// never spent anything, and approved→rejected has to give it back.
	const wasApproved = application.status === 'approved';
	const nowApproved = newStatus === 'approved';
	const balanceDelta = (nowApproved ? days : 0) - (wasApproved ? days : 0);

	const year = new Date(application.startDate).getFullYear();
	const [allocation] = await db
		.select()
		.from(leaveAllocations)
		.where(
			and(
				eq(leaveAllocations.userId, application.userId),
				eq(leaveAllocations.leaveTypeId, application.leaveTypeId),
				eq(leaveAllocations.year, year)
			)
		)
		.limit(1);

	// Re-approving something previously rejected spends the balance again, so it
	// has to be affordable now — the days may have been used elsewhere since.
	if (balanceDelta > 0 && allocation) {
		const remaining = Number(allocation.allocatedDays) - Number(allocation.usedDays);
		if (balanceDelta > remaining) {
			throw error(
				400,
				`Cannot approve: ${applicant.fullName} has ${remaining} day(s) left but this request needs ${days}`
			);
		}
	}

	// Comp-off leave is paid for in credits, which were reserved at apply time.
	// A rejection hands them back; a re-approval takes them again, and fails
	// loudly if they have since expired or been spent elsewhere.
	const [leaveType] = await db
		.select({ code: leaveTypes.code })
		.from(leaveTypes)
		.where(eq(leaveTypes.id, application.leaveTypeId))
		.limit(1);
	const isCompOff = isCompOffLeaveCode(leaveType?.code);

	// One transaction: the status, the balance, the ledger entry and any credit
	// movement describe a single decision. Applied separately, a failure midway
	// leaves a leave approved with its days never deducted, or a comp-off credit
	// spent against a request that was never approved.
	let creditShortfall = false;
	try {
		await db.transaction(async (tx) => {
			if (isCompOff) {
				if (newStatus === 'rejected') {
					await releaseCredits(application.id, tx);
				} else if (isReversal && newStatus === 'approved') {
					// Reversing a rejection: re-reserve what was released.
					try {
						await consumeCredits({
							userId: application.userId,
							count: days,
							onDate: String(application.startDate).slice(0, 10),
							applicationId: application.id,
							tx
						});
					} catch {
						// Signals a rollback; reported as a 400 outside the callback so
						// the whole decision is undone rather than half-applied.
						creditShortfall = true;
						throw new Error('credit_shortfall');
					}
				}
			}

			await tx
				.update(leaveApplications)
				.set({
					status: newStatus,
					approverId: approver.id,
					decidedAt: new Date(),
					decisionNote: note ?? null
				})
				.where(eq(leaveApplications.id, applicationId));

			if (balanceDelta !== 0) {
				if (allocation) {
					// Clamped at zero so a double-reversal can never drive usedDays
					// negative and hand out days the employee was never allocated.
					const nextUsed = Math.max(0, Number(allocation.usedDays) + balanceDelta);
					await tx
						.update(leaveAllocations)
						.set({ usedDays: String(nextUsed) })
						.where(eq(leaveAllocations.id, allocation.id));
				}

				// The original approval entry is left in place — the ledger records what
				// happened, so a reversal reads as approve-then-refund rather than the
				// approval never having existed.
				await tx.insert(leaveLedger).values({
					userId: application.userId,
					leaveTypeId: application.leaveTypeId,
					delta: String(-balanceDelta),
					reason: isReversal
						? nowApproved
							? 'Rejection reversed — leave re-approved'
							: 'Approval reversed by Super Admin'
						: 'Leave approved',
					relatedApplicationId: application.id
				});
			}
		});
	} catch (err) {
		// The shortfall throw is our own rollback signal; anything else is real.
		if (!creditShortfall) throw err;
	}

	if (creditShortfall) {
		throw error(
			400,
			`Cannot re-approve: ${applicant.fullName} no longer has ${days} comp-off credit(s) available`
		);
	}

	await logActivity({
		actorUserId: approver.id,
		action: isReversal ? `leave.reversed_to_${newStatus}` : `leave.${newStatus}`,
		targetType: 'leave_application',
		targetId: application.id,
		details: {
			previousStatus: application.status,
			newStatus,
			days,
			balanceDelta,
			reversal: isReversal
		}
	});

	// Champ Chat: a card in each approver's ESS feed, and every copy kept current.
	void notifyDecision('leave', applicationId, approver.id).catch((err) => console.error('[chat] card failed:', err));
	return json({ status: newStatus, reversed: isReversal, balanceDelta });
};

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/postgres';
import { attendance, attendanceDeviations, users } from '$lib/server/db/schema';
import { requireUser } from '$lib/server/rbac';
import { and, eq } from 'drizzle-orm';
import { logActivity } from '$lib/server/db/mongo';
import { canReviewStage, isSingleStageFor } from '$lib/server/approval-chain';
import { notifyNewRequest, notifyDecision } from '$lib/server/chat/cards';
import { hiddenFrom } from '$lib/server/hidden-users';
import { deviceUtcOffsetMinutes } from '$lib/server/easytime-import';
import { loadShiftsFor } from '$lib/server/shifts';

/**
 * SOP §2–§4: HR (or the Reporting Manager) decides an attendance correction.
 *
 * Approving is what actually fixes the record — the SOP says "attendance will be
 * corrected upon approval", so when the employee supplied the times they claim
 * are correct, those are written to the attendance row here. Without that the
 * approval would be a note on a request and the underlying attendance would stay
 * wrong, which is the whole problem the SOP exists to solve.
 */
export const POST: RequestHandler = async (event) => {
	// Authorisation is by assignment — canReviewStage below is the real gate. A
	// named reporting manager or concerned HR may hold no admin role, and a role
	// check here refused them before that logic ever ran.
	const reviewer = requireUser(event);
	const deviationId = event.params.id!;
	const { decision, note } = await event.request.json();

	if (decision !== 'approve' && decision !== 'reject') {
		throw error(400, "decision must be 'approve' or 'reject'");
	}

	const [deviation] = await db
		.select()
		.from(attendanceDeviations)
		.where(eq(attendanceDeviations.id, deviationId))
		.limit(1);
	if (!deviation) throw error(404, 'Deviation request not found');

	if (
		deviation.status !== 'pending' &&
		deviation.status !== 'needs_manager_approval' &&
		deviation.status !== 'manager_approved'
	) {
		throw error(400, 'This request has already been decided');
	}

	// Attendance corrections run manager → HR → approved. Which stage this call
	// is deciding depends on where the request currently sits.
	const stage = deviation.status === 'manager_approved' ? 'hr' : 'manager';

	const [requester] = await db.select().from(users).where(eq(users.id, deviation.userId)).limit(1);
	if (!requester || hiddenFrom(reviewer.id, requester)) throw error(404, 'Requesting employee not found');

	// When no distinct manager exists, HR stands in for the manager stage as well
	// and one approval has to finish the job — otherwise the same person approves
	// twice, and the first click silently corrects nothing. Keyed on the reviewer
	// too: a manager approving alone must still hand over to the concerned HR.
	const singleStage = stage === 'manager' && (await isSingleStageFor(reviewer, requester.id));

	// Routed by the reporting line. Nobody decides their own correction — the
	// request is a claim about your own attendance, so approving it yourself
	// would defeat the review entirely.
	// At the HR stage, whoever gave the manager sign-off cannot also close it —
	// otherwise a Super Admin who is the reporting manager walks both stages.
	const priorReviewerId = stage === 'hr' ? deviation.reviewerId : null;

	if (!(await canReviewStage(reviewer, requester.id, stage, priorReviewerId))) {
		throw error(
			403,
			requester.id === reviewer.id
				? 'You cannot decide your own attendance correction request'
				: priorReviewerId === reviewer.id
					? 'You gave the manager sign-off, so the concerned HR has to close this one'
					: stage === 'hr'
						? 'This request has manager sign-off and is now waiting on HR'
						: "Only this employee's reporting manager can give the first sign-off"
		);
	}

	// A rejection at either stage ends it. An approval at the manager stage hands
	// over to HR rather than crediting straight away; only HR's approval is final —
	// unless this employee has no separate manager, in which case this *is* the
	// final approval.
	const newStatus =
		decision === 'reject'
			? 'rejected'
			: stage === 'hr' || singleStage
				? 'approved'
				: 'manager_approved';

	await db
		.update(attendanceDeviations)
		.set({
			status: newStatus,
			reviewerId: reviewer.id,
			reviewedAt: new Date(),
			reviewNote: typeof note === 'string' && note.trim() ? note.trim().slice(0, 1000) : null
		})
		.where(eq(attendanceDeviations.id, deviationId));

	// --- Apply the correction (SOP §3: "attendance will be corrected upon approval") ---
	let attendanceCorrected = false;
	if (newStatus === 'approved' && (deviation.claimedCheckIn || deviation.claimedCheckOut)) {
		const [existing] = await db
			.select()
			.from(attendance)
			.where(and(eq(attendance.userId, deviation.userId), eq(attendance.date, deviation.date)))
			.limit(1);

		// The employee gives office wall-clock 'HH:MM' for the shift that day. It is
		// read in the devices' zone, not the server's: on a UTC host the bare
		// string landed 5h 30m late.
		const offset = deviceUtcOffsetMinutes();
		const stamp = (hhmm: string | null, dayOffset = 0) => {
			if (!hhmm) return null;
			const day = new Date(`${deviation.date}T00:00:00Z`);
			day.setUTCDate(day.getUTCDate() + dayOffset);
			return new Date(Date.parse(`${day.toISOString().slice(0, 10)}T${hhmm}:00Z`) - offset * 60_000);
		};

		// The shift credited to that day (built from every punch), so a claimed
		// check-out is measured against the shift's real check-in rather than the
		// calendar day's first punch, which may be last night's check-out.
		const [shift] = await loadShiftsFor(deviation.userId, deviation.date, deviation.date);
		const checkInAt = stamp(deviation.claimedCheckIn) ?? existing?.checkInAt ?? null;
		let checkOutAt = stamp(deviation.claimedCheckOut) ?? existing?.checkOutAt ?? null;
		// A claimed check-out at or before the check-in ends a shift that ran
		// past midnight: it is the next morning's time.
		const shiftStart = stamp(deviation.claimedCheckIn) ?? shift?.checkInAt ?? null;
		if (deviation.claimedCheckOut && shiftStart && checkOutAt && checkOutAt <= shiftStart) {
			checkOutAt = stamp(deviation.claimedCheckOut, 1);
		}

		if (existing) {
			await db
				.update(attendance)
				.set({ checkInAt, checkOutAt })
				.where(eq(attendance.id, existing.id));
		} else {
			await db.insert(attendance).values({
				userId: deviation.userId,
				date: deviation.date,
				checkInAt,
				checkOutAt,
				source: 'manual'
			});
		}
		attendanceCorrected = true;
	}

	await logActivity({
		actorUserId: reviewer.id,
		action: `attendance.deviation_${newStatus}`,
		targetType: 'attendance_deviation',
		targetId: deviationId,
		details: {
			date: deviation.date,
			reason: deviation.reason,
			employeeId: deviation.userId,
			attendanceCorrected,
			// Recorded so an audit can see whether HR agreed with the model, not just
			// what the model said.
			aiSuggestedReason: deviation.aiSuggestedReason,
			aiConfidence: deviation.aiConfidence
		}
	});

	// Champ Chat: a card in each approver's ESS feed, and every copy kept current.
	void notifyDecision('deviation', deviation.id, reviewer.id).catch((err) => console.error('[chat] card failed:', err));
	return json({ status: newStatus, attendanceCorrected });
};

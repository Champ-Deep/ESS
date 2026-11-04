import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/postgres';
import {
	attendance,
	attendanceDeviations,
	employeeProfiles,
	holidayCalendars,
	holidays,
	prohanceDays
} from '$lib/server/db/schema';
import { and, eq, inArray, desc } from 'drizzle-orm';
import { logActivity } from '$lib/server/db/mongo';
import {
	triageDeviation,
	DEVIATION_REASONS,
	type DeviationReason,
	type DeviationEvidence
} from '$lib/server/ai/triage-deviation';
import {
	DEVIATION_MONTHLY_CAP,
	CAPPED_DEVIATION_REASONS,
	countsTowardCap,
	monthKeyOf
} from '$lib/server/comp-off';
import { notifyNewRequest, notifyDecision } from '$lib/server/chat/cards';
import { officeToday } from '$lib/server/shifts';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Timestamps go to the model as local wall-clock 'HH:MM', not ISO/UTC.
 *
 * The employee's claimed times and the configured shift window are both local,
 * so handing over UTC made the model compare 09:15 IST against "03:45Z" and
 * narrate the mismatch back to HR in UTC. Same instant, but unreadable next to
 * everything else on the request.
 */
function localTime(value: Date | string | null | undefined): string | null {
	if (!value) return null;
	const d = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(d.getTime())) return null;
	return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Gathers the corroborating record for one employee/date. Nothing user-supplied. */
async function buildEvidence(
	userId: string,
	date: string,
	priorRequestsThisMonth: number
): Promise<DeviationEvidence> {
	const [profile] = await db
		.select({ shiftGroupId: employeeProfiles.shiftGroupId, employeeCode: employeeProfiles.employeeCode, timings: employeeProfiles.officeTimings })
		.from(employeeProfiles)
		.where(eq(employeeProfiles.userId, userId))
		.limit(1);

	const [att] = await db
		.select()
		.from(attendance)
		.where(and(eq(attendance.userId, userId), eq(attendance.date, date)))
		.limit(1);

	let ph: { firstLogin: Date | null; lastLogout: Date | null; logged: number | null; active: number | null; dayType: string | null } | null =
		null;
	if (profile?.employeeCode) {
		const [row] = await db
			.select({
				firstLogin: prohanceDays.firstLogin,
				lastLogout: prohanceDays.lastLogout,
				logged: prohanceDays.loggedMinutes,
				active: prohanceDays.activeMinutes,
				dayType: prohanceDays.dayType
			})
			.from(prohanceDays)
			.where(and(eq(prohanceDays.empCode, profile.employeeCode), eq(prohanceDays.sessionDate, date)))
			.limit(1);
		ph = row ?? null;
	}

	let holidayName: string | null = null;
	if (profile?.shiftGroupId) {
		const [cal] = await db
			.select({ id: holidayCalendars.id })
			.from(holidayCalendars)
			.where(
				and(eq(holidayCalendars.shiftGroupId, profile.shiftGroupId), eq(holidayCalendars.status, 'published'))
			)
			.limit(1);
		if (cal) {
			const [h] = await db
				.select({ name: holidays.name })
				.from(holidays)
				.where(and(eq(holidays.calendarId, cal.id), eq(holidays.date, date)))
				.limit(1);
			holidayName = h?.name ?? null;
		}
	}

	return {
		date,
		dayOfWeek: new Date(date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long' }),
		portalCheckIn: localTime(att?.checkInAt),
		portalCheckOut: localTime(att?.checkOutAt),
		attendanceSource: att?.source ?? null,
		prohanceFirstLogin: localTime(ph?.firstLogin),
		prohanceLastLogout: localTime(ph?.lastLogout),
		prohanceLoggedMinutes: ph?.logged ?? null,
		prohanceActiveMinutes: ph?.active ?? null,
		prohanceDayType: ph?.dayType ?? null,
		isHoliday: Boolean(holidayName),
		holidayName,
		shiftWindow: profile?.timings ?? null,
		priorRequestsThisMonth
	};
}

/** The employee's own deviation requests, newest first. */
export const GET: RequestHandler = async ({ locals }) => {
	const user = locals.user;
	if (!user) throw error(401, 'Not signed in');

	const rows = await db
		.select()
		.from(attendanceDeviations)
		.where(eq(attendanceDeviations.userId, user.id))
		.orderBy(desc(attendanceDeviations.createdAt));

	return json({ deviations: rows });
};

export const POST: RequestHandler = async ({ locals, request }) => {
	const user = locals.user;
	if (!user) throw error(401, 'Not signed in');

	const body = await request.json();
	const { date, reason, description, claimedCheckIn, claimedCheckOut } = body ?? {};

	if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
		throw error(400, 'A valid date (YYYY-MM-DD) is required');
	}
	if (!(DEVIATION_REASONS as readonly string[]).includes(reason)) {
		throw error(400, 'A valid reason is required');
	}
	if (typeof description !== 'string' || description.trim().length < 10) {
		throw error(400, 'Please describe what happened in at least 10 characters');
	}
	for (const [label, value] of [['claimedCheckIn', claimedCheckIn], ['claimedCheckOut', claimedCheckOut]] as const) {
		if (value != null && value !== '' && !HHMM.test(value)) {
			throw error(400, `${label} must be in HH:MM format`);
		}
	}
	// The office's today (IST), not UTC's, which lags until 05:30.
	if (date > officeToday()) {
		throw error(400, 'You cannot raise a deviation for a future date');
	}

	// One live request per date — a second one for the same day is almost always
	// a duplicate submission rather than a distinct problem.
	const [dupe] = await db
		.select({ id: attendanceDeviations.id })
		.from(attendanceDeviations)
		.where(
			and(
				eq(attendanceDeviations.userId, user.id),
				eq(attendanceDeviations.date, date),
				inArray(attendanceDeviations.status, ['pending', 'needs_manager_approval', 'approved'])
			)
		)
		.limit(1);
	if (dupe) throw error(409, 'You already have an open or approved request for this date');

	// SOP §2: 3 biometric-related requests per month; the 4th needs HR *and* the
	// Reporting Manager, so it is accepted but routed differently rather than blocked.
	const monthKey = monthKeyOf(date);
	const capped = countsTowardCap(reason);
	const priorRows = await db
		.select({ id: attendanceDeviations.id })
		.from(attendanceDeviations)
		.where(
			and(
				eq(attendanceDeviations.userId, user.id),
				eq(attendanceDeviations.monthKey, monthKey),
				eq(attendanceDeviations.countsTowardMonthlyCap, true),
				inArray(attendanceDeviations.status, ['pending', 'needs_manager_approval', 'approved'])
			)
		);
	const priorCount = priorRows.length;
	const overCap = capped && priorCount >= DEVIATION_MONTHLY_CAP;

	const evidence = await buildEvidence(user.id, date, priorCount);

	// Advisory triage. A provider outage must not stop someone filing a request,
	// so a null result is saved as an untriaged row for HR to read unaided.
	const triage = await triageDeviation({
		employeeStatement: description.trim(),
		employeeSelectedReason: reason as DeviationReason,
		claimedCheckIn: claimedCheckIn || null,
		claimedCheckOut: claimedCheckOut || null,
		evidence
	});

	const [created] = await db
		.insert(attendanceDeviations)
		.values({
			userId: user.id,
			date,
			reason: reason as DeviationReason,
			description: description.trim(),
			claimedCheckIn: claimedCheckIn || null,
			claimedCheckOut: claimedCheckOut || null,
			status: overCap ? 'needs_manager_approval' : 'pending',
			countsTowardMonthlyCap: capped,
			monthKey,
			evidenceSnapshot: evidence,
			aiSummary: triage?.summary ?? null,
			aiSuggestedReason: triage?.suggested_reason ?? null,
			aiConfidence: triage ? String(triage.confidence) : null,
			aiEvidenceNote: triage?.evidence_note ?? null,
			aiFlags: triage?.flags ?? null,
			aiModel: triage?.model ?? null,
			aiRanAt: triage ? new Date() : null
		})
		.returning();

	await logActivity({
		actorUserId: user.id,
		action: 'attendance.deviation_raised',
		targetType: 'attendance_deviation',
		targetId: created.id,
		details: { date, reason, overCap, triaged: Boolean(triage) }
	});

	// Champ Chat: a card in each approver's ESS feed, and every copy kept current.
	void notifyNewRequest('deviation', created.id).catch((err) => console.error('[chat] card failed:', err));

	return json({
		deviation: created,
		monthlyUsage: { used: priorCount + (capped ? 1 : 0), cap: DEVIATION_MONTHLY_CAP, capped },
		triaged: Boolean(triage)
	});
};

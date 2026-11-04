import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/postgres';
import {
	leaveApplications,
	leaveAllocations,
	leaveTypes,
	employeeProfiles,
	users
} from '$lib/server/db/schema';
import { requireUser } from '$lib/server/rbac';
import { leaveReach } from '$lib/server/org-scope';
import { and, eq, gte, lte, inArray, or, sql } from 'drizzle-orm';
import { logActivity } from '$lib/server/db/mongo';
import { checkPinkLeaveEligibility, monthBounds } from '$lib/server/leave-eligibility';
import { weekOffResolverForUser } from '$lib/server/week-off';
import { isCompOffLeaveCode, spendableCredits, consumeCredits } from '$lib/server/comp-off';
import { workingDaysInRange } from '$lib/week-off';
import { notifyNewRequest, notifyDecision } from '$lib/server/chat/cards';
import { notHidden } from '$lib/server/hidden-users';

/** Leave is booked in half days; float subtraction otherwise yields 2.9999… */
const round2 = (n: number) => Math.round(n * 100) / 100;

export const POST: RequestHandler = async (event) => {
	const user = requireUser(event);
	const { leaveTypeId, startDate, endDate, reason } = await event.request.json();

	if (!leaveTypeId || !startDate || !endDate) {
		throw error(400, 'leaveTypeId, startDate, and endDate are required');
	}

	const start = new Date(startDate);
	const end = new Date(endDate);
	if (end < start) {
		throw error(400, 'endDate cannot be before startDate');
	}
	// Days are counted against this employee's own week-off roster, not a fixed
	// Sat/Sun: someone whose only weekly off is Sunday must be charged for the
	// Saturdays inside their leave, and someone on a rotation for whichever days
	// that week's rotation actually gives them off.
	const isWeekOff = await weekOffResolverForUser(user.id);
	const days = workingDaysInRange(
		String(startDate).slice(0, 10),
		String(endDate).slice(0, 10),
		isWeekOff
	);

	const [type] = await db.select().from(leaveTypes).where(eq(leaveTypes.id, leaveTypeId)).limit(1);
	if (!type || !type.isActive) {
		throw error(400, 'That leave type is not available');
	}

	// Gender/tenure-restricted leave (pink leave). Enforced here, not just hidden
	// in the UI — the client can post any leaveTypeId it likes.
	if (type.genderEligibility || type.monthlyQuotaDays) {
		const [profile] = await db
			.select()
			.from(employeeProfiles)
			.where(eq(employeeProfiles.userId, user.id))
			.limit(1);

		const verdict = checkPinkLeaveEligibility(
			profile
				? {
						gender: profile.gender,
						dateOfJoining: profile.dateOfJoining,
						dateOfConfirmation: profile.dateOfConfirmation,
						pinkLeaveEligibleOverride: profile.pinkLeaveEligibleOverride
					}
				: null,
			start
		);

		if (!verdict.eligible) {
			throw error(403, `You are not eligible for ${type.name}`);
		}
	}

	// Monthly-quota leave: the entitlement refreshes each calendar month and does
	// not accumulate, so the check is "how much of THIS month's quota is already
	// spoken for", not a running balance.
	if (type.monthlyQuotaDays) {
		const quota = Number(type.monthlyQuotaDays);
		const { start: monthStart, end: monthEnd } = monthBounds(start);

		if (end.getMonth() !== start.getMonth() || end.getFullYear() !== start.getFullYear()) {
			throw error(400, `${type.name} must start and end within the same month`);
		}

		const [used] = await db
			.select({ total: sql<string>`coalesce(sum(${leaveApplications.days}), 0)` })
			.from(leaveApplications)
			.where(
				and(
					eq(leaveApplications.userId, user.id),
					eq(leaveApplications.leaveTypeId, leaveTypeId),
					inArray(leaveApplications.status, ['pending', 'approved', 'escalated']),
					gte(leaveApplications.startDate, monthStart),
					lte(leaveApplications.startDate, monthEnd)
				)
			);

		const alreadyUsed = Number(used?.total ?? 0);
		const remaining = quota - alreadyUsed;
		if (days > remaining) {
			throw error(
				400,
				remaining <= 0
					? `You have already used this month's ${type.name} (${quota} day${quota === 1 ? '' : 's'} per month, and it doesn't carry over)`
					: `Only ${remaining} day(s) of ${type.name} left this month`
			);
		}
	}

	// A ceiling on how fast an accumulated balance may be drawn down. Separate
	// from the balance check below, and from monthlyQuotaDays above: someone with
	// 127 days of earned leave still has all 127, they just may not spend them
	// all in one month. Null — the shipped default — means no ceiling, so this is
	// inert until a policy sets one.
	if (type.monthlyUsageCap != null) {
		const cap = Number(type.monthlyUsageCap);
		const { start: monthStart, end: monthEnd } = monthBounds(start);

		if (end.getMonth() !== start.getMonth() || end.getFullYear() !== start.getFullYear()) {
			throw error(
				400,
				`${type.name} is limited to ${cap} day(s) a month, so a request has to start and end within the same month`
			);
		}

		// Pending and escalated count against the cap as well as approved: two
		// requests that each fit under it but together exceed it must not both be
		// let through while the first is still awaiting a decision.
		const [used] = await db
			.select({ total: sql<string>`coalesce(sum(${leaveApplications.days}), 0)` })
			.from(leaveApplications)
			.where(
				and(
					eq(leaveApplications.userId, user.id),
					eq(leaveApplications.leaveTypeId, leaveTypeId),
					inArray(leaveApplications.status, ['pending', 'approved', 'escalated']),
					gte(leaveApplications.startDate, monthStart),
					lte(leaveApplications.startDate, monthEnd)
				)
			);

		const remaining = round2(cap - Number(used?.total ?? 0));
		if (days > remaining) {
			throw error(
				400,
				remaining <= 0
					? `You have already used this month's ${type.name} limit of ${cap} day(s). Your balance is unaffected — it can be taken from next month.`
					: `Only ${remaining} day(s) of ${type.name} can be taken this month (limit ${cap} a month). Your balance is unaffected.`
			);
		}
	}

	// Comp-off leave is paid for out of earned credits, not a yearly allocation:
	// one credit per day. Checked before the application is created so a request
	// can never exist against credits that are not there.
	const isCompOff = isCompOffLeaveCode(type.code);
	if (isCompOff) {
		const startKey = String(startDate).slice(0, 10);
		const credits = await spendableCredits(user.id, startKey);
		if (credits.length < days) {
			throw error(
				400,
				credits.length === 0
					? 'You have no comp-off credits available — work 7+ hours on a holiday or week off to earn one'
					: `Only ${credits.length} comp-off credit(s) available and this request needs ${days}`
			);
		}
	} else {
		const [allocation] = await db
			.select()
			.from(leaveAllocations)
			.where(
				and(
					eq(leaveAllocations.userId, user.id),
					eq(leaveAllocations.leaveTypeId, leaveTypeId),
					eq(leaveAllocations.year, start.getFullYear())
				)
			)
			.limit(1);

		if (allocation) {
			const remaining = Number(allocation.allocatedDays) - Number(allocation.usedDays);
			if (days > remaining) {
				throw error(400, `Insufficient leave balance: ${remaining} day(s) remaining`);
			}
		}
	}

	// Auto-escalation: if the requester is a Team Lead, or the request exceeds
	// their team's auto-approve threshold, it still routes to reports_to first —
	// the approve endpoint enforces the Super Admin escalation at decision time.
	const [applied] = await db
		.insert(leaveApplications)
		.values({
			userId: user.id,
			leaveTypeId,
			startDate,
			endDate,
			days: String(days),
			reason: reason ?? null,
			status: 'pending'
		})
		.returning();

	// Credits are reserved at apply time, not at approval: leaving them spendable
	// while a request is pending would let the same credit back two applications.
	// A rejection releases them again (see the approve endpoint).
	let creditsSpent = 0;
	if (isCompOff) {
		const spent = await consumeCredits({
			userId: user.id,
			count: days,
			onDate: String(startDate).slice(0, 10),
			applicationId: applied.id
		});
		creditsSpent = spent.length;
	}

	await logActivity({
		actorUserId: user.id,
		action: 'leave.apply',
		targetType: 'leave_application',
		targetId: applied.id,
		details: { days, leaveTypeId, compOff: isCompOff, creditsSpent }
	});

	// Champ Chat: a card in each approver's ESS feed, and every copy kept current.
	void notifyNewRequest('leave', applied.id).catch((err) => console.error('[chat] card failed:', err));
	return json({ application: applied, creditsSpent }, { status: 201 });
};

export const GET: RequestHandler = async (event) => {
	const user = requireUser(event);
	const scope = event.url.searchParams.get('scope'); // 'mine' | 'team'

	if (scope === 'team') {
		const applicantColumns = {
			id: users.id,
			fullName: users.fullName,
			email: users.email,
			role: users.role,
			teamId: users.teamId
		};
		// Same reach as the Leave calendar (src/lib/server/org-scope.ts): reports
		// in any team, concerned HR, a covering delegate, a Team Lead's team —
		// with the reason only where a relationship grants it.
		const reach = await leaveReach(user);
		const base = db
			.select({ application: leaveApplications, applicant: applicantColumns })
			.from(leaveApplications)
			.innerJoin(users, eq(leaveApplications.userId, users.id));
		const visible = or(notHidden, eq(users.id, user.id));
		const rows = await base.where(reach.ids === null ? visible : and(visible, inArray(leaveApplications.userId, reach.ids)));
		return json({
			applications: rows.map((r) => (reach.detail(r.application.userId) ? r : { ...r, application: { ...r.application, reason: null } }))
		});
	}

	const rows = await db
		.select()
		.from(leaveApplications)
		.where(eq(leaveApplications.userId, user.id));

	return json({ applications: rows });
};

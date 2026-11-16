import type { PageServerLoad } from './$types';
import { monthlyLeave } from '$lib/server/monthly-leave';
import { db } from '$lib/server/db/postgres';
import { leaveTypes, leaveAllocations, leaveApplications, employeeProfiles } from '$lib/server/db/schema';
import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { checkPinkLeaveEligibility, monthBounds } from '$lib/server/leave-eligibility';
import { ensureLeaveAllocations } from '$lib/server/leave-accrual';
import { managerFor } from '$lib/server/approval-chain';
import { loadWeekOffFor } from '$lib/server/week-off';

export const load: PageServerLoad = async ({ locals }) => {
	const user = locals.user!;
	const year = new Date().getFullYear();

	const allTypes = await db.select().from(leaveTypes).where(eq(leaveTypes.isActive, true));

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
			: null
	);

	// Restricted types are omitted entirely rather than shown disabled — nobody is
	// presented with a leave type they cannot use, or told on the employee-facing
	// screen that they don't qualify. The API enforces the same rule.
	const types = allTypes.filter((t) =>
		t.genderEligibility || t.monthlyQuotaDays ? verdict.eligible : true
	);

	// What is available in each type, so the impact panel can say what the
	// request leaves behind. Accrual types read their allocation; monthly-quota
	// types read this month's usage, the same way the Leave page does.
	await ensureLeaveAllocations([user.id]);
	const allocations = await db
		.select({ leaveTypeId: leaveAllocations.leaveTypeId, allocatedDays: leaveAllocations.allocatedDays, usedDays: leaveAllocations.usedDays })
		.from(leaveAllocations)
		.where(and(eq(leaveAllocations.userId, user.id), eq(leaveAllocations.year, year)));

	const available: Record<string, { remaining: number; total: number; monthly: boolean }> = {};
	// Shown for this month only, like every balance in the portal; the API
	// still checks the full balance when the request is sent.
	const myMonth = new Map(((await monthlyLeave([user.id])).get(user.id) ?? []).map((f) => [f.typeId, f]));
	for (const a of allocations) {
		const m = myMonth.get(a.leaveTypeId);
		available[a.leaveTypeId] = m
			? { remaining: m.left, total: m.credited, monthly: true }
			: { remaining: Number(a.allocatedDays) - Number(a.usedDays), total: Number(a.allocatedDays), monthly: false };
	}
	const monthlyTypes = types.filter((t) => t.monthlyQuotaDays != null);
	if (monthlyTypes.length > 0) {
		const { start: monthStart, end: monthEnd } = monthBounds(new Date());
		const usedRows = await db
			.select({ leaveTypeId: leaveApplications.leaveTypeId, total: sql<string>`coalesce(sum(${leaveApplications.days}), 0)` })
			.from(leaveApplications)
			.where(
				and(
					eq(leaveApplications.userId, user.id),
					inArray(leaveApplications.leaveTypeId, monthlyTypes.map((t) => t.id)),
					inArray(leaveApplications.status, ['pending', 'approved', 'escalated']),
					gte(leaveApplications.startDate, monthStart),
					lte(leaveApplications.startDate, monthEnd)
				)
			)
			.groupBy(leaveApplications.leaveTypeId);
		const usedByType = new Map(usedRows.map((r) => [r.leaveTypeId, Number(r.total)]));
		for (const t of monthlyTypes) {
			const quota = Number(t.monthlyQuotaDays);
			available[t.id] = { remaining: Math.max(0, quota - (usedByType.get(t.id) ?? 0)), total: quota, monthly: true };
		}
	}

	// Working days are counted against this person's own week-off roster, the
	// same way the API charges them; the rosters come along so the form can
	// show the count as the dates change.
	const { rosters, assignmentsByUser } = await loadWeekOffFor([user.id]);

	return {
		types,
		available,
		manager: await managerFor(user.id),
		weekOffRosters: rosters,
		weekOffAssignments: assignmentsByUser.get(user.id) ?? []
	};
};

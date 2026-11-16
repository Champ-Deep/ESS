import { db } from '$lib/server/db/postgres';
import { compOffCredits, employeeProfiles, leaveAllocations, leaveApplications, leaveTypes } from '$lib/server/db/schema';
import { and, eq, gte, inArray, lte } from 'drizzle-orm';
import { ensureLeaveAllocations } from '$lib/server/leave-accrual';
import { checkPinkLeaveEligibility } from '$lib/server/leave-eligibility';
import { officeToday } from '$lib/server/shifts';
import { isCompOffLeaveCode } from '$lib/server/comp-off';
import { monthOf, monthlyFigure, type MonthlyFigure } from '$lib/monthly-leave';

/**
 * Each person's leave, this month, for every type they have
 * (src/lib/monthly-leave.ts): the figure every balance in the portal shows.
 *
 * - Accrual types (Earned, Sick): this month's accrual, once their accrual
 *   has started (they have a balance this year).
 * - Monthly-quota types (Pink): the quota, for those eligible.
 * - Comp off: credits earned (worked) this month and approved.
 * - Event-based types (maternity, bereavement…) have no running balance.
 */
export async function monthlyLeave(userIds: string[], now = new Date()): Promise<Map<string, MonthlyFigure[]>> {
	const out = new Map<string, MonthlyFigure[]>();
	if (userIds.length === 0) return out;
	const w = monthOf(officeToday(now));
	const year = Number(w.start.slice(0, 4));
	await ensureLeaveAllocations(userIds);

	const [types, allocations, apps, credits, profiles] = await Promise.all([
		db.select().from(leaveTypes).where(eq(leaveTypes.isActive, true)),
		db
			.select({ userId: leaveAllocations.userId, leaveTypeId: leaveAllocations.leaveTypeId, allocatedDays: leaveAllocations.allocatedDays })
			.from(leaveAllocations)
			.where(and(inArray(leaveAllocations.userId, userIds), eq(leaveAllocations.year, year))),
		db
			.select({ userId: leaveApplications.userId, typeId: leaveApplications.leaveTypeId, start: leaveApplications.startDate, end: leaveApplications.endDate, days: leaveApplications.days, status: leaveApplications.status })
			.from(leaveApplications)
			.where(and(inArray(leaveApplications.userId, userIds), lte(leaveApplications.startDate, w.end), gte(leaveApplications.endDate, w.start), inArray(leaveApplications.status, ['approved', 'pending', 'escalated']))),
		db
			.select({ userId: compOffCredits.userId })
			.from(compOffCredits)
			.where(and(inArray(compOffCredits.userId, userIds), gte(compOffCredits.workedDate, w.start), lte(compOffCredits.workedDate, w.end), inArray(compOffCredits.status, ['approved', 'used']))),
		db.select().from(employeeProfiles).where(inArray(employeeProfiles.userId, userIds))
	]);

	const allocated = new Set(allocations.filter((a) => Number(a.allocatedDays) > 0).map((a) => `${a.userId}:${a.leaveTypeId}`));
	const creditsBy = new Map<string, number>();
	for (const c of credits) creditsBy.set(c.userId, (creditsBy.get(c.userId) ?? 0) + 1);
	const profileBy = new Map(profiles.map((p) => [p.userId, p]));

	for (const userId of userIds) {
		const figures: MonthlyFigure[] = [];
		for (const t of types) {
			let credited: number | null = null;
			if (isCompOffLeaveCode(t.code)) credited = creditsBy.get(userId) ?? 0;
			else if (t.monthlyQuotaDays != null) {
				const p = profileBy.get(userId) ?? null;
				const genderOk = !t.genderEligibility || String(p?.gender ?? '').toLowerCase().startsWith(t.genderEligibility.toLowerCase().slice(0, 1));
				if (genderOk && checkPinkLeaveEligibility(p as Parameters<typeof checkPinkLeaveEligibility>[0], now).eligible) credited = Number(t.monthlyQuotaDays);
			} else if (Number(t.accrualPerMonth) > 0) {
				credited = allocated.has(`${userId}:${t.id}`) ? Number(t.accrualPerMonth) : 0;
			}
			if (credited === null) continue; // event-based, or not theirs
			const mine = apps
				.filter((a) => a.userId === userId && a.typeId === t.id)
				.map((a) => ({ start: String(a.start), end: String(a.end), days: Number(a.days), approved: a.status === 'approved' }));
			figures.push(monthlyFigure({ id: t.id, code: t.code, name: t.name }, credited, mine, w));
		}
		figures.sort((a, b) => a.name.localeCompare(b.name));
		out.set(userId, figures);
	}
	return out;
}

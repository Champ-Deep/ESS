import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db/client';
import { leaveTypes, leaveAllocations, users, employeeProfiles } from '$lib/server/db/schema';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { gateAdminPage } from '$lib/server/capabilities';
import { notHidden } from '$lib/server/hidden-users';

/**
 * HR leave-balance upload — Super Admin and Admin (HR).
 *
 * Monthly accrual is computed from the published policy, but prior years'
 * carry-forward lives in HRone and cannot be derived here. This screen is how
 * those figures reach the portal.
 *
 * The published types are listed on screen so HR knows exactly which column
 * headings the sheet may use — guessing a code and having the row silently skip
 * is the main way this kind of upload wastes someone's afternoon.
 */
export const load: PageServerLoad = async ({ locals }) => {
	gateAdminPage(locals, ['leave.set_balances']);
	// Role is enforced by (app)/admin/+layout.server.ts — Super Admin and Admin
	// (HR), which is exactly this page's rule.

	const year = new Date().getFullYear();

	const types = await db
		.select({
			id: leaveTypes.id,
			code: leaveTypes.code,
			name: leaveTypes.name,
			accrualPerMonth: leaveTypes.accrualPerMonth,
			monthlyQuotaDays: leaveTypes.monthlyQuotaDays,
			fixedDays: leaveTypes.fixedDays
		})
		.from(leaveTypes)
		.where(eq(leaveTypes.isActive, true))
		.orderBy(leaveTypes.name);

	// Balances HR has already set by hand, so a previous upload is visible rather
	// than something to rediscover. These are the rows pinned against the accrual
	// recompute, which makes them worth showing explicitly.
	// Two joins onto `users` — the employee and whoever set the figure — so the
	// setter needs its own alias or both columns resolve to the employee.
	const setter = alias(users, 'setter');

	const hrSet = await db
		.select({
			allocatedDays: leaveAllocations.allocatedDays,
			usedDays: leaveAllocations.usedDays,
			year: leaveAllocations.year,
			hrSetAt: leaveAllocations.hrSetAt,
			hrSetNote: leaveAllocations.hrSetNote,
			employeeName: users.fullName,
			employeeCode: employeeProfiles.employeeCode,
			leaveTypeName: leaveTypes.name,
			setByName: setter.fullName
		})
		.from(leaveAllocations)
		.innerJoin(users, eq(leaveAllocations.userId, users.id))
		.leftJoin(employeeProfiles, eq(employeeProfiles.userId, leaveAllocations.userId))
		.innerJoin(leaveTypes, eq(leaveAllocations.leaveTypeId, leaveTypes.id))
		.leftJoin(setter, and(eq(leaveAllocations.hrSetBy, setter.id), eq(setter.hidden, false)))
		.where(and(notHidden, eq(leaveAllocations.isHrSet, true), isNotNull(leaveAllocations.hrSetAt)))
		.orderBy(desc(leaveAllocations.hrSetAt))
		.limit(50);

	return {
		year,
		leaveTypes: types.map((t) => ({
			...t,
			// Named so the UI can explain why a type won't take a balance rather than
			// just refusing the row later.
			holdsBalance: t.monthlyQuotaDays == null && Number(t.accrualPerMonth) > 0
		})),
		hrSet: hrSet.map((r) => ({
			...r,
			allocatedDays: Number(r.allocatedDays),
			usedDays: Number(r.usedDays)
		}))
	};
};

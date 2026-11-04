import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db/postgres';
import {
	leaveApplications,
	leaveAllocations,
	leaveTypes,
	users,
	employeeProfiles,
	holidayCalendars,
	holidays
} from '$lib/server/db/schema';
import { eq, and, or, desc, inArray, ne, gte, lte, sql, isNotNull } from 'drizzle-orm';
import { checkPinkLeaveEligibility, monthBounds } from '$lib/server/leave-eligibility';
import { ensureLeaveAllocations } from '$lib/server/leave-accrual';
import { loadWeekOffFor, currentRosterByUser } from '$lib/server/week-off';
import { managerFor, reviewableUserIds } from '$lib/server/approval-chain';
import { leaveReach } from '$lib/server/org-scope';
import type { SessionUser } from '$lib/server/auth';
import { getUsersWithProfilePicture } from '$lib/server/db/mongo';
import { notHidden } from '$lib/server/hidden-users';

/**
 * Every role reads the same published holiday calendar rows and the same
 * leaveApplications table — only the scope of *which* applications differs.
 * There is exactly one calendar per shift group (Super Admin publishes it,
 * see (app)/admin/policies); nothing here creates a separate view of it.
 */
async function loadCalendarEvents(user: SessionUser) {
	const [profile] = await db
		.select()
		.from(employeeProfiles)
		.where(eq(employeeProfiles.userId, user.id))
		.limit(1);

	let calendarHolidays: (typeof holidays.$inferSelect)[] = [];

	if (user.role === 'super_admin') {
		// Org-wide view: every published calendar's holidays, so Super Admin sees the full picture.
		const publishedCalendars = await db
			.select({ id: holidayCalendars.id })
			.from(holidayCalendars)
			.where(eq(holidayCalendars.status, 'published'));
		if (publishedCalendars.length > 0) {
			calendarHolidays = await db
				.select()
				.from(holidays)
				.where(
					inArray(
						holidays.calendarId,
						publishedCalendars.map((c) => c.id)
					)
				);
		}
	} else if (profile?.shiftGroupId) {
		const [calendar] = await db
			.select()
			.from(holidayCalendars)
			.where(and(eq(holidayCalendars.shiftGroupId, profile.shiftGroupId), eq(holidayCalendars.status, 'published')))
			.orderBy(desc(holidayCalendars.year))
			.limit(1);
		if (calendar) {
			calendarHolidays = await db.select().from(holidays).where(eq(holidays.calendarId, calendar.id));
		}
	}

	const applicantColumns = { id: users.id, fullName: users.fullName, teamId: users.teamId };

	let leaveEvents: Array<{
		application: typeof leaveApplications.$inferSelect;
		type: typeof leaveTypes.$inferSelect;
		applicant: { id: string; fullName: string; teamId: string | null };
	}>;

	const base = db
		.select({ application: leaveApplications, type: leaveTypes, applicant: applicantColumns })
		.from(leaveApplications)
		.innerJoin(leaveTypes, eq(leaveApplications.leaveTypeId, leaveTypes.id))
		.innerJoin(users, eq(leaveApplications.userId, users.id));

	// Whose leave shows follows the org scope (src/lib/org-scope.ts), not the
	// team alone: a manager sees reports in other teams, concerned HR and a
	// covering delegate see theirs, and a Team Lead keeps their whole team.
	// Someone else's cancelled leave is left off; one's own stays visible.
	const reach = await leaveReach(user);
	const notCancelled = or(eq(leaveApplications.userId, user.id), ne(leaveApplications.status, 'cancelled'));
	const visible = and(notCancelled, or(notHidden, eq(users.id, user.id)));
	leaveEvents = await base.where(reach.ids === null ? visible : and(inArray(leaveApplications.userId, reach.ids), visible));
	// Type and reason only where the viewer has a relationship that grants them;
	// otherwise the day reads as plain "Leave" with no reason sent at all.
	leaveEvents = leaveEvents.map((e) =>
		reach.detail(e.application.userId) ? e : { ...e, application: { ...e.application, reason: null }, type: { ...e.type, name: 'Leave', code: null } }
	);
	const showsOthers = leaveEvents.some((e) => e.application.userId !== user.id) || reach.ids === null || (reach.ids?.length ?? 0) > 1;

	return { calendarHolidays, leaveEvents, showsOthers };
}

export const load: PageServerLoad = async ({ locals }) => {
	const user = locals.user!;
	const year = new Date().getFullYear();

	// Balances follow the published policy's monthly accrual — recomputed
	// here so the page always shows the current month's figure.
	await ensureLeaveAllocations([user.id]);

	const allocationRows = await db
		.select({ allocation: leaveAllocations, type: leaveTypes })
		.from(leaveAllocations)
		.innerJoin(leaveTypes, eq(leaveAllocations.leaveTypeId, leaveTypes.id))
		.where(and(eq(leaveAllocations.userId, user.id), eq(leaveAllocations.year, year)));

	// A monthly-quota type should never have an allocation row, and a
	// gender-restricted one should never reach someone it does not apply to.
	// Filtered on read as well as on write, so rows created before those rules
	// existed stop being shown rather than waiting on a cleanup.
	const allocations = allocationRows.filter(
		(r) => r.type.monthlyQuotaDays == null && !r.type.genderEligibility
	);

	// Monthly-quota leave (pink leave) has no allocation row — its entitlement
	// refreshes each month and doesn't accumulate — so its balance is computed
	// from this month's applications instead.
	const [selfProfile] = await db
		.select()
		.from(employeeProfiles)
		.where(eq(employeeProfiles.userId, user.id))
		.limit(1);

	const pinkVerdict = checkPinkLeaveEligibility(
		selfProfile
			? {
					gender: selfProfile.gender,
					dateOfJoining: selfProfile.dateOfJoining,
					dateOfConfirmation: selfProfile.dateOfConfirmation,
					pinkLeaveEligibleOverride: selfProfile.pinkLeaveEligibleOverride
				}
			: null
	);

	let monthlyBalances: Array<{
		typeId: string;
		name: string;
		quota: number;
		used: number;
		remaining: number;
	}> = [];

	if (pinkVerdict.eligible) {
		const monthlyTypes = await db
			.select()
			.from(leaveTypes)
			.where(and(eq(leaveTypes.isActive, true), isNotNull(leaveTypes.monthlyQuotaDays)));

		if (monthlyTypes.length > 0) {
			const { start: monthStart, end: monthEnd } = monthBounds(new Date());
			const usedRows = await db
				.select({
					leaveTypeId: leaveApplications.leaveTypeId,
					total: sql<string>`coalesce(sum(${leaveApplications.days}), 0)`
				})
				.from(leaveApplications)
				.where(
					and(
						eq(leaveApplications.userId, user.id),
						inArray(
							leaveApplications.leaveTypeId,
							monthlyTypes.map((t) => t.id)
						),
						inArray(leaveApplications.status, ['pending', 'approved', 'escalated']),
						gte(leaveApplications.startDate, monthStart),
						lte(leaveApplications.startDate, monthEnd)
					)
				)
				.groupBy(leaveApplications.leaveTypeId);

			const usedByType = new Map(usedRows.map((r) => [r.leaveTypeId, Number(r.total)]));

			monthlyBalances = monthlyTypes.map((t) => {
				const quota = Number(t.monthlyQuotaDays);
				const used = usedByType.get(t.id) ?? 0;
				return {
					typeId: t.id,
					name: t.name,
					quota,
					used,
					remaining: Math.max(0, quota - used)
				};
			});
		}
	}

	const myApplications = await db
		.select({ application: leaveApplications, type: leaveTypes })
		.from(leaveApplications)
		.innerJoin(leaveTypes, eq(leaveApplications.leaveTypeId, leaveTypes.id))
		.where(eq(leaveApplications.userId, user.id))
		.orderBy(desc(leaveApplications.createdAt));

	const applicantColumns = {
		id: users.id,
		fullName: users.fullName,
		email: users.email,
		teamId: users.teamId
	};

	let approvalQueue: Array<{
		application: typeof leaveApplications.$inferSelect;
		type: typeof leaveTypes.$inferSelect;
		applicant: { id: string; fullName: string; email: string; teamId: string | null };
	}> = [];

	{
		// Leave runs manager → HR → approved, routed by the reporting line:
		// 'pending' is the manager's to sign off, 'escalated' is HR's to finish.
		//
		// Not gated on role: being named as someone's reporting manager or
		// concerned HR is what grants the review, and such a person may hold no
		// admin role. Anyone with nobody assigned to them gets two empty lists
		// and no queue, which is the same outcome the role check gave.
		const [manageable, hrReviewable] = await Promise.all([
			reviewableUserIds(user, 'manager'),
			reviewableUserIds(user, 'hr')
		]);

		if (manageable.length > 0 || hrReviewable.length > 0) {
			approvalQueue = await db
				.select({ application: leaveApplications, type: leaveTypes, applicant: applicantColumns })
				.from(leaveApplications)
				.innerJoin(leaveTypes, eq(leaveApplications.leaveTypeId, leaveTypes.id))
				.innerJoin(users, eq(leaveApplications.userId, users.id))
				.where(
					and(
						notHidden,
						or(
							and(
								eq(leaveApplications.status, 'pending'),
								manageable.length ? inArray(leaveApplications.userId, manageable) : sql`false`
							),
							and(
								eq(leaveApplications.status, 'escalated'),
								hrReviewable.length ? inArray(leaveApplications.userId, hrReviewable) : sql`false`
							)
						)
					)
				);
		}
	}

	// Recently decided applications, so a Super Admin can overturn a decision made
	// in error. Only they may reverse one, so only they are shown the list.
	let decidedQueue: typeof approvalQueue = [];
	if (user.role === 'super_admin') {
		decidedQueue = await db
			.select({ application: leaveApplications, type: leaveTypes, applicant: applicantColumns })
			.from(leaveApplications)
			.innerJoin(leaveTypes, eq(leaveApplications.leaveTypeId, leaveTypes.id))
			.innerJoin(users, eq(leaveApplications.userId, users.id))
			.where(and(notHidden, inArray(leaveApplications.status, ['approved', 'rejected'])))
			.orderBy(desc(leaveApplications.decidedAt))
			.limit(50);
	}

	const { calendarHolidays, leaveEvents, showsOthers } = await loadCalendarEvents(user);

	// Who signs off this person's own requests, for the request-progress panel.
	const manager = await managerFor(user.id);

	// For each request awaiting review: the applicant's current balance in that
	// leave type, so the reviewer sees what the decision does to it. Monthly-quota
	// types hold no balance and are left out rather than shown as 0.
	const queueIds = [...new Set(approvalQueue.map((r) => r.applicant.id))];
	const queueAllocations = queueIds.length
		? await db
				.select({ userId: leaveAllocations.userId, leaveTypeId: leaveAllocations.leaveTypeId, allocatedDays: leaveAllocations.allocatedDays, usedDays: leaveAllocations.usedDays })
				.from(leaveAllocations)
				.where(and(inArray(leaveAllocations.userId, queueIds), eq(leaveAllocations.year, year)))
		: [];
	const remainingFor = new Map(queueAllocations.map((a) => [`${a.userId}:${a.leaveTypeId}`, Number(a.allocatedDays) - Number(a.usedDays)]));
	const queuePictures = await getUsersWithProfilePicture([...queueIds, ...decidedQueue.map((r) => r.applicant.id)]);
	const approvalQueueView = approvalQueue.map((r) => ({
		...r,
		applicantHasPicture: queuePictures.has(r.applicant.id),
		balanceBefore: r.type.monthlyQuotaDays == null ? (remainingFor.get(`${r.applicant.id}:${r.type.id}`) ?? null) : null
	}));
	const decidedQueueView = decidedQueue.map((r) => ({ ...r, applicantHasPicture: queuePictures.has(r.applicant.id) }));

	// The calendar shades the viewer's own week offs, which are whatever roster
	// their manager assigned — not a hardcoded Saturday/Sunday. Rosters and
	// assignments are sent through so the resolver can run client-side as the
	// user pages between months.
	const today = new Date().toISOString().slice(0, 10);
	const { rosters, assignmentsByUser } = await loadWeekOffFor([user.id]);
	const myRoster = (await currentRosterByUser([user.id], today)).get(user.id) ?? null;

	return {
		allocations,
		monthlyBalances,
		myApplications,
		manager,
		approvalQueue: approvalQueueView,
		// The tab appears for anyone who actually has something to decide, which
		// includes a named HR holding no admin role.
		canApprove: approvalQueue.length > 0 || user.role === 'team_lead' || user.role === 'super_admin',
		decidedQueue: decidedQueueView,
		canReverseDecisions: user.role === 'super_admin',
		calendarHolidays,
		leaveEvents,
		calendarShowsOthers: showsOthers,
		weekOffRosters: rosters,
		weekOffAssignments: assignmentsByUser.get(user.id) ?? [],
		myWeekOff: myRoster
	};
};

import { db } from '$lib/server/db/client';
import {
	attendanceImports,
	bulkImports,
	holidayCalendars,
	leaveAllocations,
	leaveApplications,
	leaveTypes,
	users,
	employeeProfiles
} from '$lib/server/db/schema';
import { and, count, countDistinct, desc, eq, isNotNull, lt, sql } from 'drizzle-orm';
import { buildOrgTree } from '$lib/org-chart';
import type { AdminFacts } from '$lib/admin-issues';
import { loadStaleConfirmations } from '$lib/server/announcements';
import { notHidden } from '$lib/server/hidden-users';

const DAY = 86_400_000;

/**
 * The facts behind Admin Controls' attention list and section summaries.
 *
 * Every query is a count or a single row except the roster read, which the
 * reporting-loop check needs whole. At ~250 people that is still one small
 * query, and it is the same read the org chart page does.
 */
export async function loadAdminFacts(now = new Date()): Promise<AdminFacts> {
	const threeDaysAgo = new Date(now.getTime() - 3 * DAY);
	const twoWeeksAgo = new Date(now.getTime() - 14 * DAY);

	const [
		roster,
		[lastImport],
		[lastManual],
		[pending],
		[pendingOld],
		[staleTemp],
		pendingImports,
		calendarYears,
		[types],
		hrSet,
		staleConfirmations,
		chatWeek
	] = await Promise.all([
		db
			.select({
				id: users.id,
				fullName: users.fullName,
				role: users.role,
				reportsTo: users.reportsTo,
				teamId: users.teamId,
				reportsToChief: employeeProfiles.reportsToChief
			})
			.from(users)
			.leftJoin(employeeProfiles, eq(employeeProfiles.userId, users.id))
			.where(and(eq(users.isActive, true), notHidden)),
		db
			.select({ createdAt: attendanceImports.createdAt })
			.from(attendanceImports)
			.orderBy(desc(attendanceImports.createdAt))
			.limit(1),
		db
			.select({
				createdAt: attendanceImports.createdAt,
				rowCount: attendanceImports.rowCount,
				matched: attendanceImports.matchedCount,
				unmatched: attendanceImports.unmatchedCount
			})
			.from(attendanceImports)
			.where(isNotNull(attendanceImports.uploadedBy))
			.orderBy(desc(attendanceImports.createdAt))
			.limit(1),
		db.select({ n: count() }).from(leaveApplications).where(eq(leaveApplications.status, 'pending')),
		db
			.select({ n: count() })
			.from(leaveApplications)
			.where(and(eq(leaveApplications.status, 'pending'), lt(leaveApplications.createdAt, threeDaysAgo))),
		db
			.select({ n: count() })
			.from(users)
			.where(
				and(
					eq(users.isActive, true),
					notHidden,
					eq(users.mustChangePassword, true),
					isNotNull(users.temporaryPassword),
					lt(users.createdAt, twoWeeksAgo)
				)
			),
		db
			.select({ filename: bulkImports.filename, rowCount: bulkImports.rowCount })
			.from(bulkImports)
			.where(eq(bulkImports.status, 'pending_review'))
			.orderBy(desc(bulkImports.createdAt)),
		db
			.selectDistinct({ year: holidayCalendars.year })
			.from(holidayCalendars)
			.where(eq(holidayCalendars.status, 'published')),
		db.select({ n: count() }).from(leaveTypes).where(eq(leaveTypes.isActive, true)),
		db
			.select({ year: leaveAllocations.year, n: countDistinct(leaveAllocations.userId) })
			.from(leaveAllocations)
			.where(eq(leaveAllocations.isHrSet, true))
			.groupBy(leaveAllocations.year),
		loadStaleConfirmations(now),
		// Adoption: who wrote at least one message this week, how many, and
		// Ask HR questions still open.
		db.all<{ people: number; messages: number; desk: number }>(sql`
			select
				(select count(distinct author_id) from chat_messages where created_at > ${now.getTime() - 7 * DAY} and author_id is not null
					and author_id in (select u.id from users u where u.hidden = 0)) as people,
				(select count(*) from chat_messages where created_at > ${now.getTime() - 7 * DAY} and author_id is not null) as messages,
				(select count(*) from chat_channels where kind = 'desk' and desk_status = 'open'
					and exists (select 1 from chat_messages m where m.channel_id = chat_channels.id)) as desk
		`)
	]);
	const cw: { people?: number; messages?: number; desk?: number } = chatWeek[0] ?? {};

	const chart = buildOrgTree(roster.map((p) => ({ ...p, reportsToChief: Boolean(p.reportsToChief) })));
	const nameById = new Map(roster.map((p) => [p.id, p.fullName]));

	return {
		activePeople: roster.length,
		withoutManager: roster.filter((p) => !p.reportsTo && !p.reportsToChief && p.role !== 'super_admin').length,
		loopMemberNames: chart.cycleMemberIds.map((id) => nameById.get(id) ?? 'Unknown'),
		lastAttendanceImportAt: lastImport?.createdAt.toISOString() ?? null,
		lastManualUpload: lastManual
			? {
					at: lastManual.createdAt.toISOString(),
					rowCount: lastManual.rowCount,
					matched: lastManual.matched,
					unmatched: lastManual.unmatched
				}
			: null,
		pendingLeave: pending?.n ?? 0,
		pendingLeaveOld: pendingOld?.n ?? 0,
		staleTemporaryPasswords: staleTemp?.n ?? 0,
		pendingBulkImports: {
			count: pendingImports.length,
			latestFilename: pendingImports[0]?.filename ?? null,
			latestRows: pendingImports[0]?.rowCount ?? null
		},
		publishedCalendarYears: calendarYears.map((r) => r.year).sort(),
		activeLeaveTypes: types?.n ?? 0,
		hrSetBalancesByYear: Object.fromEntries(hrSet.map((r) => [r.year, r.n])),
		staleConfirmations,
		chat: { activePeople: cw.people ?? 0, messages: cw.messages ?? 0, openDeskQuestions: cw.desk ?? 0 }
	};
}

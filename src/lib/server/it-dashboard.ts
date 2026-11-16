import { db } from '$lib/server/db/postgres';
import { attendanceImports, employeeProfiles, loginEmails, users } from '$lib/server/db/schema';
import { and, asc, desc, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { getPasswordActivity } from '$lib/server/db/mongo';
import { notHidden } from '$lib/server/hidden-users';
import { isNoLoginEmail } from '$lib/no-login';
import { deskStats } from '$lib/server/desk-stats';

/**
 * The IT team's dashboard (Admin Controls › IT dashboard): login health,
 * password activity, the login-email queue, the biometric sync and the Ask
 * IT desk. Read-only; the fixes live where they always have (People, the
 * login queue, Attendance).
 */
export async function itDashboard() {
	const fortnightAgo = new Date(Date.now() - 14 * 86_400_000);
	const [people, staleList, queue, lastImport, activity, desk] = await Promise.all([
		db
			.select({ id: users.id, email: users.email, isActive: users.isActive, mustChange: users.mustChangePassword, temp: users.temporaryPassword, code: employeeProfiles.employeeCode })
			.from(users)
			.leftJoin(employeeProfiles, eq(employeeProfiles.userId, users.id))
			.where(notHidden),
		db
			.select({ id: users.id, fullName: users.fullName, email: users.email, since: users.createdAt })
			.from(users)
			.where(and(eq(users.isActive, true), notHidden, eq(users.mustChangePassword, true), isNotNull(users.temporaryPassword), lt(users.createdAt, fortnightAgo)))
			.orderBy(asc(users.createdAt))
			.limit(8),
		db
			.select({ status: loginEmails.status, n: sql<number>`count(*)::int` })
			.from(loginEmails)
			.where(sql`${loginEmails.status} in ('pending', 'approved', 'failed')`)
			.groupBy(loginEmails.status),
		db.select({ at: attendanceImports.createdAt, rows: attendanceImports.rowCount, unmatched: attendanceImports.unmatchedCount }).from(attendanceImports).orderBy(desc(attendanceImports.createdAt)).limit(1),
		getPasswordActivity(500).catch(() => []),
		deskStats('it')
	]);

	const logins = people.filter((p) => p.isActive && !isNoLoginEmail(p.email));
	const neverSignedIn = logins.filter((p) => p.mustChange && p.temp);
	const monthAgo = Date.now() - 30 * 86_400_000;
	const recent = activity.filter((a) => a.createdAt.getTime() > monthAgo);
	const q = Object.fromEntries(queue.map((r) => [r.status, r.n])) as Record<string, number>;

	return {
		figures: {
			activeLogins: logins.length,
			neverSignedIn: neverSignedIn.length,
			signedInShare: logins.length ? Math.round(((logins.length - neverSignedIn.length) / logins.length) * 100) : 0,
			staleTemporary: (
				await db
					.select({ n: sql<number>`count(*)::int` })
					.from(users)
					.where(and(eq(users.isActive, true), notHidden, eq(users.mustChangePassword, true), isNotNull(users.temporaryPassword), lt(users.createdAt, fortnightAgo)))
			)[0]?.n ?? 0,
			resets30d: recent.filter((a) => a.action === 'user.password_reset').length,
			changes30d: recent.filter((a) => a.action === 'password.change').length,
			emailsWaiting: (q.pending ?? 0) + (q.approved ?? 0),
			emailsFailed: q.failed ?? 0,
			withoutCode: logins.filter((p) => !p.code).length,
			blueCollar: people.filter((p) => p.isActive && isNoLoginEmail(p.email)).length
		},
		staleList: staleList.map((s) => ({ ...s, since: s.since.toISOString() })),
		lastImport: lastImport[0] ? { at: lastImport[0].at.toISOString(), rows: lastImport[0].rows, unmatched: lastImport[0].unmatched } : null,
		desk
	};
}

/** People without an employee code can't be matched to biometric punches. */
export async function withoutEmployeeCode(limit = 8) {
	return db
		.select({ id: users.id, fullName: users.fullName, email: users.email })
		.from(users)
		.leftJoin(employeeProfiles, eq(employeeProfiles.userId, users.id))
		.where(and(eq(users.isActive, true), notHidden, isNull(employeeProfiles.employeeCode), sql`${users.email} not like '%.invalid'`))
		.orderBy(asc(users.fullName))
		.limit(limit);
}

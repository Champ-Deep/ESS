import { db } from '$lib/server/db/postgres';
import {
	users,
	employeeProfiles,
	teams,
	leaveTypes,
	leaveAllocations,
	leaveApplications,
	leaveLedger,
	attendance,
	holidayCalendars,
	devicePunches,
	attendanceImports,
	attendanceImportTokens,
	bulkImports,
	bulkImportRows,
	announcementReads,
	announcements,
	compOffCredits,
	tasks
} from '$lib/server/db/schema';
import { deleteProfilePicture } from '$lib/server/db/mongo';
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { deleteClerkUser } from './clerk';
import { notHidden } from './hidden-users';

/**
 * Destructive admin operations.
 *
 * Every FK in this schema is ON DELETE NO ACTION, so deleting a row that
 * anything still references throws. Each function here therefore clears
 * inbound references first (nulling them where the referencing row must
 * survive, deleting it where it belongs to the target), then removes the
 * target — all inside one transaction so a failure leaves nothing half-done.
 */

export interface DeleteEmployeeResult {
	fullName: string;
	email: string;
	deletedApplications: number;
	deletedAttendance: number;
}

/**
 * Permanently removes an employee and everything belonging to them: profile,
 * leave applications and ledger, allocations, attendance, and profile picture.
 *
 * Records that merely *mention* them survive with the reference cleared —
 * device punches keep their audit trail, other people's leave keeps its
 * approval row, bulk-import history stays intact.
 */
export async function deleteEmployee(userId: string): Promise<DeleteEmployeeResult> {
	const [target] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
	if (!target) throw new Error('Employee not found');

	const result = await db.transaction(async (tx) => {
		// --- Clear inbound references from rows that must survive.
		await tx.update(users).set({ reportsTo: null }).where(eq(users.reportsTo, userId));
		await tx.update(teams).set({ teamLeadId: null }).where(eq(teams.teamLeadId, userId));
		await tx
			.update(leaveApplications)
			.set({ approverId: null })
			.where(eq(leaveApplications.approverId, userId));
		await tx
			.update(holidayCalendars)
			.set({ publishedBy: null })
			.where(eq(holidayCalendars.publishedBy, userId));
		await tx
			.update(devicePunches)
			.set({ matchedUserId: null })
			.where(eq(devicePunches.matchedUserId, userId));
		await tx
			.update(bulkImportRows)
			.set({ createdUserId: null })
			.where(eq(bulkImportRows.createdUserId, userId));
		await tx
			.update(bulkImportRows)
			.set({ existingUserId: null })
			.where(eq(bulkImportRows.existingUserId, userId));
		await tx.update(bulkImports).set({ uploadedBy: null }).where(eq(bulkImports.uploadedBy, userId));
		await tx
			.update(attendanceImports)
			.set({ uploadedBy: null })
			.where(eq(attendanceImports.uploadedBy, userId));
		await tx
			.update(attendanceImportTokens)
			.set({ createdBy: null })
			.where(eq(attendanceImportTokens.createdBy, userId));

		// --- Delete what belongs to them, children before parents.
		// Punches point at attendance rows, so unlink before those are removed.
		const ownAttendance = await tx
			.select({ id: attendance.id })
			.from(attendance)
			.where(eq(attendance.userId, userId));
		if (ownAttendance.length > 0) {
			await tx
				.update(devicePunches)
				.set({ attendanceId: null })
				.where(
					inArray(
						devicePunches.attendanceId,
						ownAttendance.map((a) => a.id)
					)
				);
		}

		// Ledger entries can reference this person's applications.
		const ownApplications = await tx
			.select({ id: leaveApplications.id })
			.from(leaveApplications)
			.where(eq(leaveApplications.userId, userId));
		// Comp-off credits point at the application that used them.
		await tx.delete(compOffCredits).where(eq(compOffCredits.userId, userId));
		if (ownApplications.length > 0) {
			await tx
				.update(compOffCredits)
				.set({ usedApplicationId: null })
				.where(
					inArray(
						compOffCredits.usedApplicationId,
						ownApplications.map((a) => a.id)
					)
				);
			await tx
				.update(leaveLedger)
				.set({ relatedApplicationId: null })
				.where(
					inArray(
						leaveLedger.relatedApplicationId,
						ownApplications.map((a) => a.id)
					)
				);
		}

		await tx.delete(leaveLedger).where(eq(leaveLedger.userId, userId));
		const apps = await tx
			.delete(leaveApplications)
			.where(eq(leaveApplications.userId, userId))
			.returning({ id: leaveApplications.id });
		await tx.delete(leaveAllocations).where(eq(leaveAllocations.userId, userId));
		const att = await tx
			.delete(attendance)
			.where(eq(attendance.userId, userId))
			.returning({ id: attendance.id });
		await tx.delete(announcementReads).where(eq(announcementReads.userId, userId));
		// Their posts stay up; they just no longer name an author.
		await tx.update(announcements).set({ createdBy: null }).where(eq(announcements.createdBy, userId));
		await tx.delete(employeeProfiles).where(eq(employeeProfiles.userId, userId));

		// A task they gave someone stays with that person, who becomes its creator.
		await tx
			.update(tasks)
			.set({ createdBy: sql`${tasks.assigneeId}` })
			.where(and(eq(tasks.createdBy, userId), ne(tasks.assigneeId, userId)));

		await clearRemainingReferences(tx, userId);
		await tx.delete(users).where(eq(users.id, userId));

		return { deletedApplications: apps.length, deletedAttendance: att.length };
	});

	// Their Clerk login goes too, so the address can't sign in to an empty account.
	await deleteClerkUser(target.clerkUserId);

	// Mongo isn't in the transaction; do it after the row is definitely gone.
	await deleteProfilePicture(userId);

	return {
		fullName: target.fullName,
		email: target.email,
		deletedApplications: result.deletedApplications,
		deletedAttendance: result.deletedAttendance
	};
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Every other column that points at users.id — chat memberships, reactions,
 * tasks, meetings, Zoom links, and whatever a later table adds — read from the
 * database's own foreign keys, so a new table can't make deletion fail again.
 * A row that merely names them (a message they wrote, a roster they published)
 * keeps the row with the reference cleared; a row that can't exist without
 * them (a channel membership, a push subscription) is deleted.
 */
async function clearRemainingReferences(tx: Tx, userId: string): Promise<void> {
	const refs = await tx.execute<{ tbl: string; col: string; notNull: boolean }>(sql`
		select cl.relname as tbl, a.attname as col, a.attnotnull as "notNull"
		from pg_constraint c
		join pg_class cl on cl.oid = c.conrelid
		join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
		where c.contype = 'f' and c.confrelid = 'users'::regclass and c.confdeltype in ('a', 'r')
	`);
	for (const { tbl, col, notNull } of refs.rows) {
		if (tbl === 'users' && col === 'id') continue;
		if (notNull) {
			await tx.execute(sql`delete from ${sql.identifier(tbl)} where ${sql.identifier(col)} = ${userId}`);
		} else {
			await tx.execute(sql`update ${sql.identifier(tbl)} set ${sql.identifier(col)} = null where ${sql.identifier(col)} = ${userId}`);
		}
	}
}

/**
 * Permanently removes a leave type and every allocation, application and
 * ledger entry that used it. Intended for types created in error — the
 * duplicate seeded ones — not for retiring a policy, which should be archived.
 */
export async function deleteLeaveType(leaveTypeId: string): Promise<{ name: string; affected: number }> {
	const [type] = await db.select().from(leaveTypes).where(eq(leaveTypes.id, leaveTypeId)).limit(1);
	if (!type) throw new Error('Leave type not found');

	const affected = await db.transaction(async (tx) => {
		const apps = await tx
			.select({ id: leaveApplications.id })
			.from(leaveApplications)
			.where(eq(leaveApplications.leaveTypeId, leaveTypeId));

		if (apps.length > 0) {
			await tx
				.update(leaveLedger)
				.set({ relatedApplicationId: null })
				.where(
					inArray(
						leaveLedger.relatedApplicationId,
						apps.map((a) => a.id)
					)
				);
		}

		await tx.delete(leaveLedger).where(eq(leaveLedger.leaveTypeId, leaveTypeId));
		await tx.delete(leaveApplications).where(eq(leaveApplications.leaveTypeId, leaveTypeId));
		const allocs = await tx
			.delete(leaveAllocations)
			.where(eq(leaveAllocations.leaveTypeId, leaveTypeId))
			.returning({ id: leaveAllocations.id });
		await tx.delete(leaveTypes).where(eq(leaveTypes.id, leaveTypeId));

		return apps.length + allocs.length;
	});

	return { name: type.name, affected };
}

export interface CleanupPreview {
	seededLeaveTypes: { id: string; name: string }[];
	staleAllocations: number;
	otherEmployees: { id: string; fullName: string; email: string }[];
	leaveApplications: number;
	attendanceRows: number;
	bulkImports: number;
}

/**
 * What the maintenance page would remove. Seeded leave types are identified by
 * having no `code` — every type published from a real policy document carries
 * one (EL, SL, MATERNITY…), while the seed script's types do not.
 */
export async function previewCleanup(keepUserId: string): Promise<CleanupPreview> {
	const [seeded, others, apps, att, imports, allocs] = await Promise.all([
		db
			.select({ id: leaveTypes.id, name: leaveTypes.name })
			.from(leaveTypes)
			.where(isNull(leaveTypes.code)),
		db
			.select({ id: users.id, fullName: users.fullName, email: users.email })
			.from(users)
			.where(and(ne(users.id, keepUserId), notHidden)),
		db.select({ n: sql<number>`count(*)::int` }).from(leaveApplications),
		db.select({ n: sql<number>`count(*)::int` }).from(attendance),
		db.select({ n: sql<number>`count(*)::int` }).from(bulkImports),
		db.select({ n: sql<number>`count(*)::int` }).from(leaveAllocations)
	]);

	return {
		seededLeaveTypes: seeded,
		staleAllocations: allocs[0]?.n ?? 0,
		otherEmployees: others,
		leaveApplications: apps[0]?.n ?? 0,
		attendanceRows: att[0]?.n ?? 0,
		bulkImports: imports[0]?.n ?? 0
	};
}

export interface CleanupOptions {
	seededLeaveTypes: boolean;
	leaveAndAttendanceData: boolean;
	otherEmployees: boolean;
	bulkImportHistory: boolean;
}

/**
 * Bulk maintenance reset. Each part is opt-in; `keepUserId` is never touched.
 */
export async function runCleanup(
	keepUserId: string,
	options: CleanupOptions
): Promise<Record<string, number>> {
	const counts: Record<string, number> = {};

	// Employee deletion reuses deleteEmployee so the FK handling stays in one
	// place — a second implementation would inevitably drift from the first.
	if (options.otherEmployees) {
		// The hidden developer login is not an employee and survives a reset.
		const others = await db.select({ id: users.id }).from(users).where(and(ne(users.id, keepUserId), notHidden));
		for (const u of others) await deleteEmployee(u.id);
		counts.employees = others.length;
	}

	await db.transaction(async (tx) => {
		if (options.leaveAndAttendanceData) {
			await tx.update(leaveLedger).set({ relatedApplicationId: null });
			const ledger = await tx.delete(leaveLedger).returning({ id: leaveLedger.id });
			const apps = await tx.delete(leaveApplications).returning({ id: leaveApplications.id });
			const allocs = await tx.delete(leaveAllocations).returning({ id: leaveAllocations.id });
			await tx.update(devicePunches).set({ attendanceId: null });
			const att = await tx.delete(attendance).returning({ id: attendance.id });
			counts.leaveLedger = ledger.length;
			counts.leaveApplications = apps.length;
			counts.leaveAllocations = allocs.length;
			counts.attendance = att.length;
		}

		if (options.seededLeaveTypes) {
			const seeded = await tx
				.select({ id: leaveTypes.id })
				.from(leaveTypes)
				.where(isNull(leaveTypes.code));
			const ids = seeded.map((s) => s.id);
			if (ids.length > 0) {
				// These may still be referenced if leave data wasn't also cleared.
				const apps = await tx
					.select({ id: leaveApplications.id })
					.from(leaveApplications)
					.where(inArray(leaveApplications.leaveTypeId, ids));
				if (apps.length > 0) {
					await tx
						.update(leaveLedger)
						.set({ relatedApplicationId: null })
						.where(
							inArray(
								leaveLedger.relatedApplicationId,
								apps.map((a) => a.id)
							)
						);
				}
				await tx.delete(leaveLedger).where(inArray(leaveLedger.leaveTypeId, ids));
				await tx.delete(leaveApplications).where(inArray(leaveApplications.leaveTypeId, ids));
				await tx.delete(leaveAllocations).where(inArray(leaveAllocations.leaveTypeId, ids));
				await tx.delete(leaveTypes).where(inArray(leaveTypes.id, ids));
			}
			counts.seededLeaveTypes = ids.length;
		}

		if (options.bulkImportHistory) {
			const rows = await tx.delete(bulkImportRows).returning({ id: bulkImportRows.id });
			const imports = await tx.delete(bulkImports).returning({ id: bulkImports.id });
			counts.bulkImportRows = rows.length;
			counts.bulkImports = imports.length;
		}
	});

	return counts;
}

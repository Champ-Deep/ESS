import { db } from '$lib/server/db/client';
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
import { deleteProfilePicture } from '$lib/server/db/store';
import * as schema from '$lib/server/db/schema';
import { and, eq, getTableColumns, is, isNull, ne, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { getTableConfig, SQLiteTable, type SQLiteColumn } from 'drizzle-orm/sqlite-core';
import { inArray } from '$lib/server/db/sql';
import { deleteClerkUser } from './clerk';
import { notHidden } from './hidden-users';

/**
 * Destructive admin operations.
 *
 * Every FK in this schema is ON DELETE NO ACTION, so deleting a row that
 * anything still references throws. Each function here therefore clears
 * inbound references first (nulling them where the referencing row must
 * survive, deleting it where it belongs to the target), then removes the
 * target — all in one D1 batch (atomic) so a failure leaves nothing half-done.
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

	// D1 has no interactive transactions: read what the writes need first, then
	// send every write as one batch, which D1 runs atomically.
	// Punches point at attendance rows, so unlink before those are removed.
	const ownAttendance = await db
		.select({ id: attendance.id })
		.from(attendance)
		.where(eq(attendance.userId, userId));
	// Ledger entries can reference this person's applications.
	const ownApplications = await db
		.select({ id: leaveApplications.id })
		.from(leaveApplications)
		.where(eq(leaveApplications.userId, userId));

	const writes: BatchItem<'sqlite'>[] = [
		// --- Clear inbound references from rows that must survive.
		db.update(users).set({ reportsTo: null }).where(eq(users.reportsTo, userId)),
		db.update(teams).set({ teamLeadId: null }).where(eq(teams.teamLeadId, userId)),
		db
			.update(leaveApplications)
			.set({ approverId: null })
			.where(eq(leaveApplications.approverId, userId)),
		db
			.update(holidayCalendars)
			.set({ publishedBy: null })
			.where(eq(holidayCalendars.publishedBy, userId)),
		db
			.update(devicePunches)
			.set({ matchedUserId: null })
			.where(eq(devicePunches.matchedUserId, userId)),
		db
			.update(bulkImportRows)
			.set({ createdUserId: null })
			.where(eq(bulkImportRows.createdUserId, userId)),
		db
			.update(bulkImportRows)
			.set({ existingUserId: null })
			.where(eq(bulkImportRows.existingUserId, userId)),
		db.update(bulkImports).set({ uploadedBy: null }).where(eq(bulkImports.uploadedBy, userId)),
		db
			.update(attendanceImports)
			.set({ uploadedBy: null })
			.where(eq(attendanceImports.uploadedBy, userId)),
		db
			.update(attendanceImportTokens)
			.set({ createdBy: null })
			.where(eq(attendanceImportTokens.createdBy, userId))
	];

	// --- Delete what belongs to them, children before parents.
	if (ownAttendance.length > 0) {
		writes.push(
			db
				.update(devicePunches)
				.set({ attendanceId: null })
				.where(
					inArray(
						devicePunches.attendanceId,
						ownAttendance.map((a) => a.id)
					)
				)
		);
	}

	// Comp-off credits point at the application that used them.
	writes.push(db.delete(compOffCredits).where(eq(compOffCredits.userId, userId)));
	if (ownApplications.length > 0) {
		writes.push(
			db
				.update(compOffCredits)
				.set({ usedApplicationId: null })
				.where(
					inArray(
						compOffCredits.usedApplicationId,
						ownApplications.map((a) => a.id)
					)
				),
			db
				.update(leaveLedger)
				.set({ relatedApplicationId: null })
				.where(
					inArray(
						leaveLedger.relatedApplicationId,
						ownApplications.map((a) => a.id)
					)
				)
		);
	}

	const appsAt = writes.length + 1;
	const attAt = writes.length + 3;
	writes.push(
		db.delete(leaveLedger).where(eq(leaveLedger.userId, userId)),
		db
			.delete(leaveApplications)
			.where(eq(leaveApplications.userId, userId))
			.returning({ id: leaveApplications.id }),
		db.delete(leaveAllocations).where(eq(leaveAllocations.userId, userId)),
		db
			.delete(attendance)
			.where(eq(attendance.userId, userId))
			.returning({ id: attendance.id }),
		db.delete(announcementReads).where(eq(announcementReads.userId, userId)),
		// Their posts stay up; they just no longer name an author.
		db.update(announcements).set({ createdBy: null }).where(eq(announcements.createdBy, userId)),
		db.delete(employeeProfiles).where(eq(employeeProfiles.userId, userId)),
		// A task they gave someone stays with that person, who becomes its creator.
		db
			.update(tasks)
			.set({ createdBy: sql`${tasks.assigneeId}` })
			.where(and(eq(tasks.createdBy, userId), ne(tasks.assigneeId, userId))),
		...clearRemainingReferences(userId),
		db.delete(users).where(eq(users.id, userId))
	);
	const results = await runBatch(writes);
	const result = {
		deletedApplications: (results[appsAt] as unknown[]).length,
		deletedAttendance: (results[attAt] as unknown[]).length
	};

	// Their Clerk login goes too, so the address can't sign in to an empty account.
	await deleteClerkUser(target.clerkUserId);

	// The picture isn't in the batch; do it after the row is definitely gone.
	await deleteProfilePicture(userId);

	return {
		fullName: target.fullName,
		email: target.email,
		deletedApplications: result.deletedApplications,
		deletedAttendance: result.deletedAttendance
	};
}

/** Sends `writes` as one D1 batch (atomic); a no-op for an empty list. */
async function runBatch(writes: BatchItem<'sqlite'>[]): Promise<unknown[]> {
	if (writes.length === 0) return [];
	return (await db.batch(writes as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]])) as unknown[];
}

/**
 * Every other column that points at users.id — chat memberships, reactions,
 * tasks, meetings, Zoom links, and whatever a later table adds — read from the
 * schema's own foreign keys, so a new table can't make deletion fail again.
 * (SQLite has no pg_constraint; the migrations are generated from the schema,
 * so it lists the same keys.) Keys with their own ON DELETE action (cascade,
 * set null) are left to the database, as before.
 * A row that merely names them (a message they wrote, a roster they published)
 * keeps the row with the reference cleared; a row that can't exist without
 * them (a channel membership, a push subscription) is deleted.
 */
function clearRemainingReferences(userId: string): BatchItem<'sqlite'>[] {
	const out: BatchItem<'sqlite'>[] = [];
	for (const table of Object.values(schema)) {
		if (!is(table, SQLiteTable)) continue;
		for (const fk of getTableConfig(table).foreignKeys) {
			if (fk.onDelete && fk.onDelete !== 'no action' && fk.onDelete !== 'restrict') continue;
			const ref = fk.reference();
			if (ref.foreignTable !== users) continue;
			for (const column of ref.columns) {
				if (table === users && column.name === 'id') continue;
				if (column.notNull) {
					out.push(db.delete(table).where(eq(column, userId)));
				} else {
					out.push(db.update(table).set({ [keyOf(table, column)]: null }).where(eq(column, userId)));
				}
			}
		}
	}
	return out;
}

/** The schema property name of `column` in `table` (what `.set()` expects). */
function keyOf(table: SQLiteTable, column: SQLiteColumn): string {
	const entry = Object.entries(getTableColumns(table)).find(([, c]) => c === column);
	if (!entry) throw new Error(`column ${column.name} not found`);
	return entry[0];
}

/**
 * Permanently removes a leave type and every allocation, application and
 * ledger entry that used it. Intended for types created in error — the
 * duplicate seeded ones — not for retiring a policy, which should be archived.
 */
export async function deleteLeaveType(leaveTypeId: string): Promise<{ name: string; affected: number }> {
	const [type] = await db.select().from(leaveTypes).where(eq(leaveTypes.id, leaveTypeId)).limit(1);
	if (!type) throw new Error('Leave type not found');

	// Reads first, then the writes as one atomic D1 batch (no transactions on D1).
	const apps = await db
		.select({ id: leaveApplications.id })
		.from(leaveApplications)
		.where(eq(leaveApplications.leaveTypeId, leaveTypeId));

	const writes: BatchItem<'sqlite'>[] = [];
	if (apps.length > 0) {
		writes.push(
			db
				.update(leaveLedger)
				.set({ relatedApplicationId: null })
				.where(
					inArray(
						leaveLedger.relatedApplicationId,
						apps.map((a) => a.id)
					)
				)
		);
	}
	writes.push(
		db.delete(leaveLedger).where(eq(leaveLedger.leaveTypeId, leaveTypeId)),
		db.delete(leaveApplications).where(eq(leaveApplications.leaveTypeId, leaveTypeId))
	);
	const allocsAt = writes.length;
	writes.push(
		db
			.delete(leaveAllocations)
			.where(eq(leaveAllocations.leaveTypeId, leaveTypeId))
			.returning({ id: leaveAllocations.id }),
		db.delete(leaveTypes).where(eq(leaveTypes.id, leaveTypeId))
	);
	const results = await runBatch(writes);
	const affected = apps.length + (results[allocsAt] as unknown[]).length;

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
		db.select({ n: sql<number>`count(*)` }).from(leaveApplications),
		db.select({ n: sql<number>`count(*)` }).from(attendance),
		db.select({ n: sql<number>`count(*)` }).from(bulkImports),
		db.select({ n: sql<number>`count(*)` }).from(leaveAllocations)
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

	// D1 has no interactive transactions: reads first, then every write in one
	// atomic batch. `counted` remembers which batch result fills which count.
	const writes: BatchItem<'sqlite'>[] = [];
	const counted: [key: string, index: number][] = [];
	const countRows = (key: string, query: BatchItem<'sqlite'>) => {
		counted.push([key, writes.length]);
		writes.push(query);
	};

	if (options.leaveAndAttendanceData) {
		writes.push(db.update(leaveLedger).set({ relatedApplicationId: null }));
		countRows('leaveLedger', db.delete(leaveLedger).returning({ id: leaveLedger.id }));
		countRows('leaveApplications', db.delete(leaveApplications).returning({ id: leaveApplications.id }));
		countRows('leaveAllocations', db.delete(leaveAllocations).returning({ id: leaveAllocations.id }));
		writes.push(db.update(devicePunches).set({ attendanceId: null }));
		countRows('attendance', db.delete(attendance).returning({ id: attendance.id }));
	}

	if (options.seededLeaveTypes) {
		const seeded = await db
			.select({ id: leaveTypes.id })
			.from(leaveTypes)
			.where(isNull(leaveTypes.code));
		const ids = seeded.map((s) => s.id);
		if (ids.length > 0) {
			// These may still be referenced if leave data wasn't also cleared.
			// (If it is being cleared, the writes above run first in the batch
			// and these simply match nothing.)
			const apps = await db
				.select({ id: leaveApplications.id })
				.from(leaveApplications)
				.where(inArray(leaveApplications.leaveTypeId, ids));
			if (apps.length > 0) {
				writes.push(
					db
						.update(leaveLedger)
						.set({ relatedApplicationId: null })
						.where(
							inArray(
								leaveLedger.relatedApplicationId,
								apps.map((a) => a.id)
							)
						)
				);
			}
			writes.push(
				db.delete(leaveLedger).where(inArray(leaveLedger.leaveTypeId, ids)),
				db.delete(leaveApplications).where(inArray(leaveApplications.leaveTypeId, ids)),
				db.delete(leaveAllocations).where(inArray(leaveAllocations.leaveTypeId, ids)),
				db.delete(leaveTypes).where(inArray(leaveTypes.id, ids))
			);
		}
		counts.seededLeaveTypes = ids.length;
	}

	if (options.bulkImportHistory) {
		countRows('bulkImportRows', db.delete(bulkImportRows).returning({ id: bulkImportRows.id }));
		countRows('bulkImports', db.delete(bulkImports).returning({ id: bulkImports.id }));
	}

	const results = await runBatch(writes);
	for (const [key, index] of counted) counts[key] = (results[index] as unknown[]).length;

	return counts;
}

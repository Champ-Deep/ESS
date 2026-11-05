import { db } from '$lib/server/db/client';
import {
	attendance,
	attendanceImportTokens,
	attendanceImports,
	devicePunches,
	employeeProfiles
} from '$lib/server/db/schema';
import {
	mergePunch,
	normalizeEmpCode,
	punchDedupeKey,
	type ParsedPunch,
	type PunchDay
} from '$lib/server/easytime-import';
import { and, desc, eq, max } from 'drizzle-orm';
import { chunksFor, inArray } from '$lib/server/db/sql';

export const MAX_FEED_RECORDS = 1000;

/**
 * Was a Postgres advisory lock that serialised imports. D1 has neither
 * transactions nor locks; ingestPunches now reads everything first and writes
 * in batches instead. Kept as a no-op so existing callers still compile.
 */
export async function lockAttendanceImports(_tx?: unknown): Promise<void> {}

export interface KeyedPunch extends ParsedPunch {
	dedupeKey: string;
}

export function orderAndCollapse(punches: ParsedPunch[]): { punches: KeyedPunch[]; repeats: number } {
	const sorted = [...punches].sort((a, b) => a.punchedAt.getTime() - b.punchedAt.getTime());
	const seen = new Set<string>();
	const unique: KeyedPunch[] = [];

	for (const punch of sorted) {
		const dedupeKey = punchDedupeKey(punch);
		if (seen.has(dedupeKey)) continue;
		seen.add(dedupeKey);
		unique.push({ ...punch, dedupeKey });
	}

	return { punches: unique, repeats: punches.length - unique.length };
}

export interface IngestResult {
	importId: string;
	rowCount: number;
	matchedCount: number;
	unmatchedCount: number;
	duplicateCount: number;
	unmatchedEmpCodes: string[];
}

/** Statements per D1 batch: big imports go in a few batches. */
const WRITE_BATCH = 200;

export async function ingestPunches(
	parsed: ParsedPunch[],
	options: { tokenId: string; filename: string | null }
): Promise<IngestResult> {
	const { punches, repeats } = orderAndCollapse(parsed);

	const codes = [...new Set(punches.map((p) => normalizeEmpCode(p.empCode)))];
	const profiles = codes.length
		? await db
				.select({ userId: employeeProfiles.userId, employeeCode: employeeProfiles.employeeCode })
				.from(employeeProfiles)
				.where(inArray(employeeProfiles.employeeCode, codes))
		: [];

	const userByCode = new Map(
		profiles
			.filter((p): p is { userId: string; employeeCode: string } => Boolean(p.employeeCode))
			.map((p) => [normalizeEmpCode(p.employeeCode), p.userId])
	);

	let matchedCount = 0;
	let unmatchedCount = 0;
	let duplicateCount = repeats;
	const unmatchedCodes = new Set<string>();

	// D1 has no interactive transactions: everything is read up front, worked
	// out in memory, then written in batches (each batch is atomic). A failure
	// between batches is safe to retry: stored punches dedupe and mergePunch
	// only ever moves a check-in earlier or a check-out later.
	const keys = punches.map((p) => p.dedupeKey);
	const stored = keys.length
		? await db
				.select({
					id: devicePunches.id,
					dedupeKey: devicePunches.dedupeKey,
					attendanceId: devicePunches.attendanceId
				})
				.from(devicePunches)
				.where(inArray(devicePunches.dedupeKey, keys))
		: [];
	const storedByKey = new Map(stored.map((row) => [row.dedupeKey, row]));

	const userIds = [...new Set(userByCode.values())];
	const dates = [...new Set(punches.map((p) => p.punchDate))];
	const existingDays =
		userIds.length && dates.length
			? await db
					.select({
						id: attendance.id,
						userId: attendance.userId,
						date: attendance.date,
						checkInAt: attendance.checkInAt,
						checkOutAt: attendance.checkOutAt
					})
					.from(attendance)
					.where(and(inArray(attendance.userId, userIds), inArray(attendance.date, dates)))
			: [];
	const days = new Map<string, DayRow>();
	for (const row of existingDays) {
		const key = `${row.userId}|${row.date}`;
		if (!days.has(key)) days.set(key, { id: row.id, checkInAt: row.checkInAt, checkOutAt: row.checkOutAt, isNew: false, changed: new Set() });
	}

	const importId = crypto.randomUUID();
	const punchInserts: (typeof devicePunches.$inferInsert)[] = [];
	const punchUpdates: { id: string; matchedUserId: string; attendanceId: string }[] = [];

	for (const punch of punches) {
		const previous = storedByKey.get(punch.dedupeKey);
		if (previous?.attendanceId) {
			duplicateCount += 1;
			continue;
		}

		const userId = userByCode.get(normalizeEmpCode(punch.empCode)) ?? null;
		if (!userId) {
			unmatchedCount += 1;
			unmatchedCodes.add(punch.empCode);
			if (!previous) punchInserts.push(punchRow(punch, importId, null, null));
			continue;
		}

		const attendanceId = applyPunch(days, userId, punch);
		matchedCount += 1;

		if (previous) punchUpdates.push({ id: previous.id, matchedUserId: userId, attendanceId });
		else punchInserts.push(punchRow(punch, importId, userId, attendanceId));
	}

	const dayRows = [...days.entries()];
	const newDays = dayRows
		.filter(([, d]) => d.isNew)
		.map(([key, d]) => {
			const [userId, date] = key.split('|');
			return { id: d.id, userId, date, checkInAt: d.checkInAt, checkOutAt: d.checkOutAt, source: 'biometric' as const };
		});
	const changedDays = dayRows.map(([, d]) => d).filter((d) => !d.isNew && d.changed.size > 0);

	const writes = [
		db.insert(attendanceImports).values({
			id: importId,
			tokenId: options.tokenId,
			filename: options.filename,
			rowCount: parsed.length,
			matchedCount,
			unmatchedCount,
			duplicateCount
		}),
		...chunksFor(newDays, 13).map((rows) => db.insert(attendance).values(rows)),
		...changedDays.map((d) => {
			const patch: Partial<typeof attendance.$inferInsert> = { source: 'biometric' };
			for (const field of d.changed) patch[field] = d[field];
			return db.update(attendance).set(patch).where(eq(attendance.id, d.id));
		}),
		...chunksFor(punchInserts, 23).map((rows) => db.insert(devicePunches).values(rows).onConflictDoNothing()),
		...punchUpdates.map((u) =>
			db
				.update(devicePunches)
				.set({ matchedUserId: u.matchedUserId, attendanceId: u.attendanceId })
				.where(eq(devicePunches.id, u.id))
		)
	];
	for (let i = 0; i < writes.length; i += WRITE_BATCH) {
		const slice = writes.slice(i, i + WRITE_BATCH);
		await db.batch(slice as [(typeof slice)[0], ...typeof slice]);
	}

	return {
		importId,
		rowCount: parsed.length,
		matchedCount,
		unmatchedCount,
		duplicateCount,
		unmatchedEmpCodes: [...unmatchedCodes]
	};
}

interface DayRow extends PunchDay {
	id: string;
	/** Not in the database yet: inserted rather than updated. */
	isNew: boolean;
	/** Which ends of an existing row this import moved. */
	changed: Set<'checkInAt' | 'checkOutAt'>;
}

function applyPunch(days: Map<string, DayRow>, userId: string, punch: KeyedPunch): string {
	const key = `${userId}|${punch.punchDate}`;
	const day = days.get(key);
	const merged = mergePunch(day ?? null, punch);

	if (!day) {
		const created: DayRow = {
			id: crypto.randomUUID(),
			checkInAt: merged.checkInAt,
			checkOutAt: merged.checkOutAt,
			isNew: true,
			changed: new Set()
		};
		days.set(key, created);
		return created.id;
	}
	if (merged.changed) {
		day.checkInAt = merged.checkInAt;
		day.checkOutAt = merged.checkOutAt;
		day.changed.add(merged.changed);
	}
	return day.id;
}

function punchRow(
	punch: KeyedPunch,
	importId: string,
	matchedUserId: string | null,
	attendanceId: string | null
): typeof devicePunches.$inferInsert {
	return {
		importId,
		empCode: punch.empCode,
		firstName: punch.firstName,
		lastName: punch.lastName,
		deptCode: punch.deptCode,
		deptName: punch.deptName,
		punchedAt: punch.punchedAt,
		verifyType: punch.verifyType,
		punchState: punch.punchState,
		direction: punch.direction,
		workCode: punch.workCode,
		cardNumber: punch.cardNumber,
		areaName: punch.areaName,
		terminalAlias: punch.terminalAlias,
		terminalSn: punch.terminalSn,
		temperature: punch.temperature,
		maskFlag: punch.maskFlag,
		rawLine: punch.rawLine,
		matchedUserId,
		attendanceId,
		dedupeKey: punch.dedupeKey
	};
}

export interface FeedStatus {
	ok: true;
	tokenLabel: string | null;
	lastImport: {
		at: Date;
		rowCount: number;
		matchedCount: number;
		unmatchedCount: number;
		duplicateCount: number;
	} | null;
	latestPunchAt: Date | null;
	maxRecords: number;
}

export async function loadFeedStatus(tokenId: string): Promise<FeedStatus> {
	const [[token], [lastImport], [latest]] = await Promise.all([
		db
			.select({ label: attendanceImportTokens.label })
			.from(attendanceImportTokens)
			.where(eq(attendanceImportTokens.id, tokenId))
			.limit(1),
		db
			.select({
				at: attendanceImports.createdAt,
				rowCount: attendanceImports.rowCount,
				matchedCount: attendanceImports.matchedCount,
				unmatchedCount: attendanceImports.unmatchedCount,
				duplicateCount: attendanceImports.duplicateCount
			})
			.from(attendanceImports)
			.where(eq(attendanceImports.tokenId, tokenId))
			.orderBy(desc(attendanceImports.createdAt))
			.limit(1),
		db
			.select({ at: max(devicePunches.punchedAt) })
			.from(devicePunches)
			.innerJoin(attendanceImports, eq(devicePunches.importId, attendanceImports.id))
			.where(eq(attendanceImports.tokenId, tokenId))
	]);

	return {
		ok: true,
		tokenLabel: token?.label ?? null,
		lastImport: lastImport ?? null,
		latestPunchAt: latest?.at ?? null,
		maxRecords: MAX_FEED_RECORDS
	};
}

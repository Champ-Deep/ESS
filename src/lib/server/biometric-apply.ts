import { db } from '$lib/server/db/client';
import {
	attendance,
	attendanceImports,
	devicePunches,
	employeeProfiles,
	users
} from '$lib/server/db/schema';
import { normalizeEmpCode } from '$lib/server/easytime-import';
import { notHidden } from '$lib/server/hidden-users';
import { lockAttendanceImports } from '$lib/server/easytime-ingest';
import { addDays, instantFor, type ParsedBiometricDay } from '$lib/server/biometric-sheet';
import { and, eq } from 'drizzle-orm';
import { inArray } from '$lib/server/db/sql';

/**
 * Resolving and applying a manually uploaded biometric report.
 *
 * Split from the parser so the preview and the commit run the *same* resolution:
 * what HR approves on screen is what gets written, rather than a second pass that
 * could reach a different answer.
 *
 * Everything lands in the tables the employee's own attendance page already
 * reads — `attendance` for the day's in/out and `device_punches` for the audit
 * trail — so an applied upload shows up on the employee's calendar, in their
 * worked-hours totals and in their present-day count with no further wiring.
 */

/** One employee-day joined to whoever its employee code resolved to. */
export interface ResolvedDay extends ParsedBiometricDay {
	/** Null when the code matched no profile — the row is kept, not applied. */
	userId: string | null;
	/** The matched employee's name on record, for the review screen. */
	matchedName: string | null;
	/** Employee code as matched (upper-cased, trimmed). */
	normalizedCode: string;
	/** What applying this row would do to the employee's existing record. */
	effect: 'create' | 'update' | 'no-change';
	/** The in/out already on file, when there is a row for that date. */
	existing: { checkInAt: Date | null; checkOutAt: Date | null; source: string } | null;
	/** Resolved instants, in the device's zone. */
	checkInAt: Date | null;
	checkOutAt: Date | null;
}

export interface ResolveSummary {
	days: ResolvedDay[];
	/** Distinct codes in the sheet that matched no employee profile. */
	unmatchedCodes: string[];
	matchedCount: number;
	unmatchedCount: number;
	createCount: number;
	updateCount: number;
	noChangeCount: number;
	/** Earliest and latest attendance date in the sheet. */
	dateRange: { from: string; to: string } | null;
}

/**
 * Joins parsed days to employees and works out what applying them would change.
 *
 * Read-only: nothing here writes. The same function backs the preview and the
 * commit, and the commit re-runs it inside its own request so a stale preview can
 * never be applied against data that moved underneath it.
 */
export async function resolveBiometricDays(days: ParsedBiometricDay[]): Promise<ResolveSummary> {
	const codes = [...new Set(days.map((d) => normalizeEmpCode(d.empCode)))];

	const profiles = codes.length
		? await db
				.select({
					userId: employeeProfiles.userId,
					employeeCode: employeeProfiles.employeeCode,
					fullName: users.fullName
				})
				.from(employeeProfiles)
				.innerJoin(users, eq(employeeProfiles.userId, users.id))
				.where(and(notHidden, inArray(employeeProfiles.employeeCode, codes)))
		: [];

	const byCode = new Map(
		profiles
			.filter((p): p is { userId: string; employeeCode: string; fullName: string } =>
				Boolean(p.employeeCode)
			)
			.map((p) => [normalizeEmpCode(p.employeeCode), { userId: p.userId, fullName: p.fullName }])
	);

	// Every (user, date) the sheet touches, fetched in one query rather than per
	// row — a month's report for 300 people is 9,000 rows.
	const userIds = [...new Set([...byCode.values()].map((v) => v.userId))];
	const existingRows = userIds.length
		? await db
				.select({
					id: attendance.id,
					userId: attendance.userId,
					date: attendance.date,
					checkInAt: attendance.checkInAt,
					checkOutAt: attendance.checkOutAt,
					source: attendance.source
				})
				.from(attendance)
				.where(inArray(attendance.userId, userIds))
		: [];

	const existingByKey = new Map(
		existingRows.map((r) => [`${r.userId}|${attendanceDateKey(r.date)}`, r])
	);

	const resolved: ResolvedDay[] = [];
	const unmatched = new Set<string>();
	let matchedCount = 0;
	let createCount = 0;
	let updateCount = 0;
	let noChangeCount = 0;
	let from: string | null = null;
	let to: string | null = null;

	for (const day of days) {
		const normalizedCode = normalizeEmpCode(day.empCode);
		const match = byCode.get(normalizedCode) ?? null;

		if (!from || day.date < from) from = day.date;
		if (!to || day.date > to) to = day.date;

		const checkInAt = day.inTime ? instantFor(day.date, day.inTime) : null;
		// A night shift's departure belongs to the next calendar day; recorded on
		// the start date it would compute as a negative shift.
		const checkOutAt = day.outTime
			? instantFor(day.crossesMidnight ? addDays(day.date, 1) : day.date, day.outTime)
			: null;

		const existing = match ? (existingByKey.get(`${match.userId}|${day.date}`) ?? null) : null;

		let effect: ResolvedDay['effect'] = 'create';
		if (match && existing) {
			const wouldChange =
				(checkInAt !== null && !sameInstant(existing.checkInAt, checkInAt)) ||
				(checkOutAt !== null && !sameInstant(existing.checkOutAt, checkOutAt));
			effect = wouldChange ? 'update' : 'no-change';
		}

		if (match) {
			matchedCount += 1;
			if (effect === 'create') createCount += 1;
			else if (effect === 'update') updateCount += 1;
			else noChangeCount += 1;
		} else {
			unmatched.add(day.empCode.trim());
		}

		resolved.push({
			...day,
			userId: match?.userId ?? null,
			matchedName: match?.fullName ?? null,
			normalizedCode,
			effect,
			existing: existing
				? { checkInAt: existing.checkInAt, checkOutAt: existing.checkOutAt, source: existing.source }
				: null,
			checkInAt,
			checkOutAt
		});
	}

	return {
		days: resolved,
		unmatchedCodes: [...unmatched],
		matchedCount,
		unmatchedCount: resolved.length - matchedCount,
		createCount,
		updateCount,
		noChangeCount,
		dateRange: from && to ? { from, to } : null
	};
}

/**
 * `attendance.date` is a Postgres `date`; node-postgres returns it as a Date at
 * local midnight, so the calendar day is read from local parts. toISOString()
 * here would shift the day west of UTC and misfile every row.
 */
function attendanceDateKey(value: string | Date): string {
	if (value instanceof Date) {
		const pad = (n: number) => String(n).padStart(2, '0');
		return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
	}
	return String(value).slice(0, 10);
}

const sameInstant = (a: Date | null, b: Date | null): boolean =>
	a === null || b === null ? a === b : a.getTime() === b.getTime();

export interface ApplyOptions {
	/** Who uploaded — recorded on the import row for the audit trail. */
	uploadedBy: string;
	filename: string | null;
	/**
	 * When true, a time already on file is replaced by the sheet's. Off by default:
	 * a manual upload then behaves like the device import, where a check-in only
	 * moves earlier and a check-out only later, so re-uploading an overlapping
	 * report never shortens someone's recorded day.
	 */
	overwriteExisting?: boolean;
}

export interface ApplyResult {
	importId: string;
	rowCount: number;
	matchedCount: number;
	unmatchedCount: number;
	createdCount: number;
	updatedCount: number;
	unchangedCount: number;
	unmatchedCodes: string[];
}

/**
 * Writes the resolved days to attendance, and every row to device_punches.
 *
 * Runs in one transaction: a half-applied report would leave HR unable to tell
 * which days had landed, and re-uploading is the obvious remedy for a failure.
 *
 * Unmatched rows are still recorded (with no matched user), exactly as the
 * device import does — so HR can set the employee's code and re-upload the same
 * file rather than having to find the missing day again.
 */
export async function applyBiometricDays(
	days: ParsedBiometricDay[],
	options: ApplyOptions
): Promise<ApplyResult> {
	const summary = await resolveBiometricDays(days);

	let createdCount = 0;
	let updatedCount = 0;
	let unchangedCount = 0;

	const importId = await db.transaction(async (tx) => {
		await lockAttendanceImports(tx);

		const [importRow] = await tx
			.insert(attendanceImports)
			.values({
				// No tokenId: this upload came from a person, not the device job.
				uploadedBy: options.uploadedBy,
				filename: options.filename,
				rowCount: summary.days.length,
				matchedCount: summary.matchedCount,
				unmatchedCount: summary.unmatchedCount
			})
			.returning();

		for (const day of summary.days) {
			// The parser drops rows with neither time, so this is belt-and-braces —
			// device_punches.punched_at is NOT NULL, and a row with no instant at all
			// would abort the whole transaction rather than skip one day.
			if (!day.checkInAt && !day.checkOutAt) continue;

			let attendanceId: string | null = null;

			if (day.userId) {
				const outcome = await applyDay(tx, day, options.overwriteExisting ?? false);
				attendanceId = outcome.attendanceId;
				if (outcome.action === 'created') createdCount += 1;
				else if (outcome.action === 'updated') updatedCount += 1;
				else unchangedCount += 1;
			}

			// One audit row per employee-day. The sheet gives a summarised day rather
			// than individual punches, so the in and out are recorded as one row whose
			// punched_at is the arrival — with the raw line carrying both times.
			await tx.insert(devicePunches).values({
				importId: importRow.id,
				empCode: day.empCode,
				firstName: day.employeeName,
				lastName: null,
				deptCode: null,
				deptName: null,
				// A day with only an out time still needs an instant here; the column is
				// NOT NULL and the out time is the only thing that happened.
				punchedAt: day.checkInAt ?? day.checkOutAt!,
				verifyType: 'manual-upload',
				punchState: null,
				direction: day.checkInAt && day.checkOutAt ? null : day.checkInAt ? 'in' : 'out',
				workCode: null,
				cardNumber: null,
				areaName: null,
				terminalAlias: options.filename,
				terminalSn: null,
				temperature: null,
				maskFlag: null,
				rawLine: [
					day.empCode,
					day.employeeName ?? '',
					day.date,
					day.inTime ?? '',
					day.outTime ?? '',
					day.crossesMidnight ? 'overnight' : ''
				].join('\t'),
				matchedUserId: day.userId,
				attendanceId
			});
		}

		return importRow.id;
	});

	return {
		importId,
		rowCount: summary.days.length,
		matchedCount: summary.matchedCount,
		unmatchedCount: summary.unmatchedCount,
		createdCount,
		updatedCount,
		unchangedCount,
		unmatchedCodes: summary.unmatchedCodes
	};
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Applies one employee-day to their attendance row.
 *
 * Default merge matches the device importer: a check-in only ever moves earlier
 * and a check-out only ever later, which makes re-uploading an overlapping report
 * idempotent. With overwriteExisting the sheet is taken as authoritative instead
 * — the case where HR is correcting a wrong record on purpose.
 */
async function applyDay(
	tx: Tx,
	day: ResolvedDay,
	overwriteExisting: boolean
): Promise<{ attendanceId: string; action: 'created' | 'updated' | 'unchanged' }> {
	const userId = day.userId!;

	const [existing] = await tx
		.select()
		.from(attendance)
		.where(and(eq(attendance.userId, userId), eq(attendance.date, day.date)))
		.limit(1);

	if (!existing) {
		const [created] = await tx
			.insert(attendance)
			.values({
				userId,
				date: day.date,
				checkInAt: day.checkInAt,
				checkOutAt: day.checkOutAt,
				source: 'biometric'
			})
			.returning();
		return { attendanceId: created.id, action: 'created' };
	}

	const patch: Partial<typeof attendance.$inferInsert> = {};

	if (day.checkInAt) {
		if (overwriteExisting || !existing.checkInAt || day.checkInAt < existing.checkInAt) {
			if (!sameInstant(existing.checkInAt, day.checkInAt)) patch.checkInAt = day.checkInAt;
		}
	}
	if (day.checkOutAt) {
		if (overwriteExisting || !existing.checkOutAt || day.checkOutAt > existing.checkOutAt) {
			if (!sameInstant(existing.checkOutAt, day.checkOutAt)) patch.checkOutAt = day.checkOutAt;
		}
	}

	if (Object.keys(patch).length === 0) {
		return { attendanceId: existing.id, action: 'unchanged' };
	}

	// Only stamped as biometric when something actually changed, so a no-op upload
	// never relabels a manual check-in.
	patch.source = 'biometric';

	const [updated] = await tx
		.update(attendance)
		.set(patch)
		.where(eq(attendance.id, existing.id))
		.returning();
	return { attendanceId: updated.id, action: 'updated' };
}

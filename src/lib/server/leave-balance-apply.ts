/**
 * Resolving and applying an HR leave-balance sheet.
 *
 * Split from the parser so the preview and the apply share one definition of
 * "what this file would do". The preview calls resolve() and writes nothing; the
 * apply calls resolve() again on the re-uploaded file and then writes. Nothing is
 * staged between the two, which removes the window where a stale preview is
 * applied after the balances underneath it moved.
 */

import { db } from '$lib/server/db/client';
import { leaveAllocations, leaveTypes, employeeProfiles, users } from '$lib/server/db/schema';
import { and, eq } from 'drizzle-orm';
import { inArray } from '$lib/server/db/sql';
import { normalizeEmpCode } from '$lib/server/easytime-import';
import { notHidden } from '$lib/server/hidden-users';
import type { ParsedBalance } from '$lib/server/leave-balance-sheet';

const norm = (v: string) => v.replace(/\s+/g, ' ').trim().toLowerCase();
const round2 = (n: number) => Math.round(n * 100) / 100;

export type BalanceEffect = 'create' | 'update' | 'no-change';

export interface ResolvedBalance extends ParsedBalance {
	/** Null when the employee code matches nobody on file. */
	userId: string | null;
	employeeName: string | null;
	/** Null when the leave-type token matches no published type. */
	leaveTypeId: string | null;
	leaveTypeName: string | null;
	effect: BalanceEffect;
	/**
	 * False when the row cannot be written at all — an unknown employee code or
	 * leave type, or a type that holds no standing balance. Such rows are shown in
	 * the preview (HR needs to see they were in the file) but never applied.
	 */
	applicable: boolean;
	/** The entitlement currently on file, for the preview to show the change. */
	existingDays: number | null;
	/** Days already taken. Never modified — shown so HR can see the consequence. */
	usedDays: number;
	/**
	 * True when the new entitlement is below what the employee has already taken,
	 * which would leave them with a negative remaining balance.
	 */
	belowUsed: boolean;
	notes: string[];
}

export interface ResolvedSummary {
	year: number;
	rows: ResolvedBalance[];
	matchedCount: number;
	unmatchedCodes: string[];
	unmatchedTypes: string[];
	createCount: number;
	updateCount: number;
	noChangeCount: number;
	belowUsedCount: number;
}

/**
 * Matches every parsed row to an employee and a published leave type, and works
 * out what applying it would change. Reads only.
 *
 * `year` is the allocation year the balances belong to; allocations are held per
 * calendar year, so a figure is always set against one.
 */
export async function resolveLeaveBalances(
	balances: ParsedBalance[],
	year: number
): Promise<ResolvedSummary> {
	const codes = [...new Set(balances.map((b) => normalizeEmpCode(b.empCode)))];

	// Employee codes are stored as HR typed them, so the whole roster is read and
	// matched on the normalised form rather than filtering in SQL on an exact
	// string — 'cipl001' and 'CIPL001' are the same employee.
	const profiles = codes.length
		? await db
				.select({
					userId: employeeProfiles.userId,
					employeeCode: employeeProfiles.employeeCode,
					fullName: users.fullName,
					isActive: users.isActive
				})
				.from(employeeProfiles)
				.innerJoin(users, eq(users.id, employeeProfiles.userId))
				.where(notHidden)
		: [];
	const byCode = new Map(
		profiles
			.filter((p): p is typeof p & { employeeCode: string } => Boolean(p.employeeCode))
			.map((p) => [
				normalizeEmpCode(p.employeeCode),
				{ userId: p.userId, fullName: p.fullName, isActive: p.isActive }
			])
	);

	// A type is addressable by its policy code ("EL") or its published name
	// ("Earned Leave"); HR uses both, sometimes in the same file.
	const types = await db
		.select({
			id: leaveTypes.id,
			code: leaveTypes.code,
			name: leaveTypes.name,
			isActive: leaveTypes.isActive,
			monthlyQuotaDays: leaveTypes.monthlyQuotaDays,
			fixedDays: leaveTypes.fixedDays,
			accrualPerMonth: leaveTypes.accrualPerMonth
		})
		.from(leaveTypes);
	const typeByToken = new Map<string, (typeof types)[number]>();
	for (const t of types) {
		if (t.code) typeByToken.set(norm(t.code), t);
		typeByToken.set(norm(t.name), t);
	}

	const userIds = [...new Set([...byCode.values()].map((v) => v.userId))];
	const existing = userIds.length
		? await db
				.select()
				.from(leaveAllocations)
				.where(and(inArray(leaveAllocations.userId, userIds), eq(leaveAllocations.year, year)))
		: [];
	const existingByKey = new Map(existing.map((a) => [`${a.userId}:${a.leaveTypeId}`, a]));

	const rows: ResolvedBalance[] = [];
	const unmatchedCodes = new Set<string>();
	const unmatchedTypes = new Set<string>();

	for (const b of balances) {
		const notes: string[] = [];
		const match = byCode.get(normalizeEmpCode(b.empCode)) ?? null;
		const type = typeByToken.get(norm(b.leaveTypeToken)) ?? null;

		if (!match) unmatchedCodes.add(b.empCode);
		if (!type) unmatchedTypes.add(b.leaveTypeToken);

		if (match && !match.isActive) notes.push('employee is inactive');
		if (type && !type.isActive) notes.push('leave type is not active');

		// Types that hold no standing balance. Writing an allocation row for one
		// would create a balance the rest of the system does not believe in: a
		// monthly quota is refreshed and lapsed each month by the leave rules, and
		// event-based leave is granted per event. Reported, not applied.
		let holdsNoBalance = false;
		if (type?.monthlyQuotaDays != null) {
			notes.push('monthly quota — refreshes each month and holds no balance, so it is skipped');
			holdsNoBalance = true;
		} else if (type && type.fixedDays != null && Number(type.accrualPerMonth ?? 0) === 0) {
			notes.push('event-based leave — granted per event, not held as a balance, so it is skipped');
			holdsNoBalance = true;
		}

		const applicable = Boolean(match && type) && !holdsNoBalance;

		const prior =
			match && type ? (existingByKey.get(`${match.userId}:${type.id}`) ?? null) : null;
		const existingDays = prior ? round2(Number(prior.allocatedDays)) : null;
		const usedDays = prior ? round2(Number(prior.usedDays)) : 0;
		const days = round2(b.days);

		let effect: BalanceEffect;
		if (!applicable) effect = 'no-change';
		else if (!prior) effect = 'create';
		else if (existingDays === days && prior.isHrSet) effect = 'no-change';
		else effect = 'update';

		// Setting an entitlement under what has already been taken leaves a negative
		// remaining balance. Allowed — HR sometimes has to correct a figure downward
		// — but surfaced, because it is usually a mistake.
		const belowUsed = applicable && days < usedDays;
		if (belowUsed) {
			notes.push(`below the ${usedDays} day(s) already taken`);
		}

		rows.push({
			...b,
			userId: match?.userId ?? null,
			employeeName: match?.fullName ?? null,
			leaveTypeId: type?.id ?? null,
			leaveTypeName: type?.name ?? null,
			effect,
			applicable,
			existingDays,
			usedDays,
			belowUsed,
			notes
		});
	}

	const applicable = rows.filter((r) => r.applicable);

	return {
		year,
		rows,
		matchedCount: applicable.length,
		unmatchedCodes: [...unmatchedCodes],
		unmatchedTypes: [...unmatchedTypes],
		createCount: applicable.filter((r) => r.effect === 'create').length,
		updateCount: applicable.filter((r) => r.effect === 'update').length,
		noChangeCount: applicable.filter((r) => r.effect === 'no-change').length,
		belowUsedCount: applicable.filter((r) => r.belowUsed).length
	};
}

/**
 * Writes the resolved balances.
 *
 * Every row written is marked `isHrSet`, which pins it against the monthly
 * accrual recompute — see src/lib/server/leave-accrual.ts. `usedDays` is never
 * touched: days already taken are a record of approved leave, and the uploaded
 * sheet describes the entitlement only.
 */
export async function applyLeaveBalances(
	summary: ResolvedSummary,
	actorUserId: string,
	note: string | null
): Promise<{ created: number; updated: number; skipped: number }> {
	let created = 0;
	let updated = 0;
	let skipped = 0;

	const stamp = { isHrSet: true, hrSetBy: actorUserId, hrSetAt: new Date(), hrSetNote: note };

	for (const row of summary.rows) {
		// `applicable` also excludes types that hold no standing balance, so it is
		// the gate rather than merely having both ids resolved.
		if (!row.applicable || !row.userId || !row.leaveTypeId) {
			skipped++;
			continue;
		}

		const [prior] = await db
			.select()
			.from(leaveAllocations)
			.where(
				and(
					eq(leaveAllocations.userId, row.userId),
					eq(leaveAllocations.leaveTypeId, row.leaveTypeId),
					eq(leaveAllocations.year, summary.year)
				)
			)
			.limit(1);

		// The uploaded figure is written twice on purpose: to allocatedDays, which
		// is the live balance and moves as leave accrues and is taken, and to
		// hrSetDays, which is the opening figure and does not move. The accrual
		// recompute needs the second one — it rebuilds the row as "baseline plus
		// the months since", and reading the baseline back out of a balance it has
		// already added to would compound it on every page load.
		const days = String(round2(row.days));

		if (prior) {
			await db
				.update(leaveAllocations)
				.set({ allocatedDays: days, hrSetDays: days, ...stamp })
				.where(eq(leaveAllocations.id, prior.id));
			updated++;
		} else {
			await db.insert(leaveAllocations).values({
				userId: row.userId,
				leaveTypeId: row.leaveTypeId,
				year: summary.year,
				allocatedDays: days,
				hrSetDays: days,
				usedDays: '0',
				...stamp
			});
			created++;
		}
	}

	return { created, updated, skipped };
}

import { db } from '$lib/server/db/client';
import { leaveTypes, leaveAllocations, employeeProfiles } from '$lib/server/db/schema';
import { and, eq, getTableColumns } from 'drizzle-orm';
import { chunksFor, inArray } from '$lib/server/db/sql';

/**
 * Policy-driven leave balances (see "leave polcies.pdf", published through
 * Admin → Publish Policies into leave_types).
 *
 * Balances are ACCRUED, not granted up front: every accrual-based type
 * credits its `accrualPerMonth` once per month, January (or the joining
 * month) through the current month. Types marked `post_probation` (Earned
 * Leave) start at the confirmation month instead; someone whose confirmation
 * hasn't happened yet accrues nothing on those. Event-based types
 * (maternity/paternity/bereavement — `fixedDays`, no accrual) never carry a
 * standing balance, so they get no allocation row.
 *
 * Recomputed idempotently on page loads: allocatedDays is overwritten with
 * the freshly computed figure (usedDays is never touched), so the numbers
 * follow the calendar month with no cron. Employees with no joining or
 * confirmation date on file are treated as long-settled staff and accrue
 * from January — the HR tracker carries these dates, so the gap is rare.
 *
 * Prior years' carry-forward (max 5 days by policy) cannot be derived here —
 * that history lives in HRone, which the portal cannot read. HR supplies those
 * figures through Admin → Leave Balances, and any row they set carries
 * `isHrSet`.
 *
 * An uploaded figure is an OPENING balance, not a closing one. Earned leave
 * goes on accruing on top of it, so an HR-set row is recomputed as its recorded
 * baseline (`hrSetDays`) plus the months elapsed since HR set it — not
 * recomputed from the policy alone, which would throw their figure away, and
 * not frozen, which would stop 1.5 days a month ever landing. Keeping the
 * baseline in its own column is what makes that safe to run on every page load:
 * reading it back out of `allocatedDays` would compound the same month over and
 * over. Rows uploaded before that column existed have no baseline to build on
 * and stay pinned exactly as given.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;

function monthOf(value: string | Date | null | undefined): { year: number; month: number } | null {
	if (!value) return null;
	const d = value instanceof Date ? value : new Date(String(value).slice(0, 10) + 'T00:00');
	if (Number.isNaN(d.getTime())) return null;
	return { year: d.getFullYear(), month: d.getMonth() };
}

/**
 * Months of accrual this calendar year given the accrual can only start
 * after `from` (a joining or confirmation date). Inclusive of the current
 * month; 0 when `from` is in the future.
 */
function accrualMonths(
	from: { year: number; month: number } | null,
	year: number,
	currentMonth: number
): number {
	const start = accrualStartMonth(from, year);
	if (start === null) return 0;
	return Math.max(0, currentMonth - start + 1);
}

/**
 * The first month of `year` that accrues, or null when accrual has not started
 * by then. Split out of accrualMonths because an HR-set baseline needs the
 * boundary itself, not the count: months already covered by the uploaded figure
 * must not be added to it a second time.
 */
export function accrualStartMonth(
	from: { year: number; month: number } | null,
	year: number
): number | null {
	if (!from) return 0;
	if (from.year > year) return null;
	return from.year === year ? from.month : 0;
}

/**
 * Days to add on top of a balance HR uploaded.
 *
 * The uploaded figure is the balance as at the moment it was uploaded, so
 * accrual resumes the FOLLOWING month — counting the upload month again would
 * credit a month the figure already included, and would do it afresh on every
 * page load. Months before the person was eligible to accrue (probation, a
 * mid-year joiner) are excluded the same way the normal path excludes them.
 */
export function accrualSinceBaseline(
	hrSetAt: Date | null,
	startMonth: number | null,
	year: number,
	currentMonth: number,
	perMonth: number
): number {
	if (!hrSetAt || startMonth === null) return 0;
	// A baseline set in an earlier year says nothing about this year's row, and
	// one set in a later year cannot be reasoned about at all.
	if (hrSetAt.getFullYear() !== year) return 0;
	const from = Math.max(startMonth, hrSetAt.getMonth());
	return round2(Math.max(0, currentMonth - from) * perMonth);
}

/**
 * Ensures every listed user has this year's allocations matching the
 * published policy. Batched: three reads, then every row that actually
 * changed is written in D1 batches, so roster-sized calls stay cheap.
 */
export async function ensureLeaveAllocations(userIds: string[]): Promise<void> {
	if (userIds.length === 0) return;

	const now = new Date();
	const year = now.getFullYear();
	const currentMonth = now.getMonth();

	const types = (await db.select().from(leaveTypes).where(eq(leaveTypes.isActive, true))).filter(
		(t) =>
			// Only types published from a policy document (they carry a code).
			// Seed placeholders never accrue here.
			Boolean(t.code) &&
			Number(t.accrualPerMonth) > 0 &&
			// A monthly quota refreshes and lapses; it is not a balance that builds,
			// so it must never get an allocation row. A policy that sets both — as a
			// published pink-leave policy did — is a quota first.
			t.monthlyQuotaDays == null
	);
	if (types.length === 0) return;

	const profiles = await db
		.select({
			userId: employeeProfiles.userId,
			dateOfJoining: employeeProfiles.dateOfJoining,
			dateOfConfirmation: employeeProfiles.dateOfConfirmation,
			// Decides whether a gender-restricted type accrues for this person.
			gender: employeeProfiles.gender,
			pinkLeaveEligibleOverride: employeeProfiles.pinkLeaveEligibleOverride
		})
		.from(employeeProfiles)
		.where(inArray(employeeProfiles.userId, userIds));
	const profileByUser = new Map(profiles.map((p) => [p.userId, p]));

	const existing = await db
		.select()
		.from(leaveAllocations)
		.where(and(inArray(leaveAllocations.userId, userIds), eq(leaveAllocations.year, year)));
	const existingByKey = new Map(existing.map((a) => [`${a.userId}:${a.leaveTypeId}`, a]));
	const updates: { id: string; allocatedDays: string }[] = [];
	const inserts: (typeof leaveAllocations.$inferInsert)[] = [];

	for (const userId of userIds) {
		const profile = profileByUser.get(userId);
		const joined = monthOf(profile?.dateOfJoining);
		const confirmed = monthOf(profile?.dateOfConfirmation);

		for (const type of types) {
			// A gender-restricted leave only accrues for those it applies to. HR's
			// explicit override wins over the recorded gender, and an unrecorded
			// gender grants nothing — handing the leave to everyone whose profile
			// is simply blank is how a men's roster ended up with pink leave.
			if (type.genderEligibility) {
				const override = profile?.pinkLeaveEligibleOverride;
				const matches =
					(profile?.gender ?? '').trim().toLowerCase() === type.genderEligibility.toLowerCase();
				if (override === false) continue;
				if (override !== true && !matches) continue;
			}

			let months: number;
			let startMonth: number | null;
			if (type.eligibility === 'post_probation' && profile?.dateOfConfirmation) {
				// Probation ends at confirmation; accrual starts that month.
				months = accrualMonths(confirmed, year, currentMonth);
				startMonth = accrualStartMonth(confirmed, year);
			} else if (type.eligibility === 'post_probation' && joined && joined.year === year) {
				// Joined this year with no confirmation on file yet → still on
				// probation, no post-probation accrual.
				months = 0;
				startMonth = null;
			} else {
				months = accrualMonths(joined, year, currentMonth);
				startMonth = accrualStartMonth(joined, year);
			}

			const perMonth = Number(type.accrualPerMonth);
			const accrued = round2(months * perMonth);
			const key = `${userId}:${type.id}`;
			const row = existingByKey.get(key);

			// A balance HR uploaded is the OPENING balance — carry-forward from
			// HRone, which the policy accrual has no way to derive — and earned
			// leave goes on accruing on top of it. So the row is recomputed as
			// "what HR gave us, plus the months since they gave it", never
			// recomputed from the policy alone (that would discard their figure)
			// and never left frozen (that would stop 1.5 days a month landing).
			//
			// Rows uploaded before hrSetDays existed have no recorded baseline, so
			// there is nothing to add to: those stay pinned, as they were.
			if (row?.isHrSet) {
				if (row.hrSetDays == null) continue;
				const baseline = Number(row.hrSetDays);
				const target = round2(
					baseline + accrualSinceBaseline(row.hrSetAt, startMonth, year, currentMonth, perMonth)
				);
				if (Number(row.allocatedDays) !== target) updates.push({ id: row.id, allocatedDays: String(target) });
				continue;
			}

			if (!row) {
				if (accrued > 0) {
					inserts.push({
						userId,
						leaveTypeId: type.id,
						year,
						allocatedDays: String(accrued),
						usedDays: '0'
					});
				}
			} else if (Number(row.allocatedDays) !== accrued) {
				updates.push({ id: row.id, allocatedDays: String(accrued) });
			}
		}
	}

	const writes = [
		...chunksFor(inserts, Object.keys(getTableColumns(leaveAllocations)).length).map((rows) => db.insert(leaveAllocations).values(rows)),
		...updates.map((u) => db.update(leaveAllocations).set({ allocatedDays: u.allocatedDays }).where(eq(leaveAllocations.id, u.id)))
	];
	for (let i = 0; i < writes.length; i += 200) {
		const slice = writes.slice(i, i + 200);
		await db.batch(slice as [(typeof slice)[0], ...typeof slice]);
	}
}

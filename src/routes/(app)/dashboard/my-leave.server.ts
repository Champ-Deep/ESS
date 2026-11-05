/**
 * The viewer's own side of the absence planner: what they have to spend, what
 * is already spent or booked, the holidays ahead, their next time away and
 * long-weekend ideas. Always the signed-in person's own figures, whatever
 * their role — nobody else's balance is read here.
 *
 * Figures follow the Leave page: an allocation's `usedDays` is what approved
 * leave has spent (the approve endpoint moves it), pending requests are
 * counted separately, and pink leave is a monthly quota with no balance. Run
 * after ensureLeaveAllocations so the accrual is current.
 */
import { db } from '$lib/server/db/client';
import {
	leaveAllocations,
	leaveApplications,
	leaveTypes,
	employeeProfiles,
	holidayCalendars,
	holidays
} from '$lib/server/db/schema';
import { and, eq, gte, lte } from 'drizzle-orm';
import { inArray } from '$lib/server/db/sql';
import { checkPinkLeaveEligibility, monthBounds } from '$lib/server/leave-eligibility';
import { isCompOffLeaveCode, spendableCredits } from '$lib/server/comp-off';
import { loadWeekOffFor } from '$lib/server/week-off';
import { officeToday } from '$lib/server/shifts';
import { addDays, breakIdeas, daysBetween, parseKey, type MyBalance, type MyLeave } from '$lib/leave-planning';
import { workingDaysInRange } from '$lib/week-off';
import { toneMapFor, type PlannerTone } from './planner.server';
import type { SessionUser } from '$lib/server/auth';

const round2 = (n: number) => Math.round(n * 100) / 100;
const pad = (n: number) => String(n).padStart(2, '0');
const dateKey = (v: string | Date) =>
	v instanceof Date ? `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}` : String(v).slice(0, 10);

export async function loadMyLeave(user: SessionUser, now = new Date()): Promise<MyLeave> {
	const today = officeToday(now);
	const year = Number(today.slice(0, 4));
	const yearStart = `${year}-01-01`;
	const yearEndKey = `${year}-12-31`;
	const horizon = addDays(today, 365);

	const [allTypes, allocationRows, [profile], applicationRows, credits, weekOff] = await Promise.all([
		db.select().from(leaveTypes),
		db
			.select()
			.from(leaveAllocations)
			.where(and(eq(leaveAllocations.userId, user.id), eq(leaveAllocations.year, year))),
		db.select().from(employeeProfiles).where(eq(employeeProfiles.userId, user.id)).limit(1),
		db
			.select({ application: leaveApplications, typeName: leaveTypes.name })
			.from(leaveApplications)
			.innerJoin(leaveTypes, eq(leaveApplications.leaveTypeId, leaveTypes.id))
			.where(
				and(
					eq(leaveApplications.userId, user.id),
					inArray(leaveApplications.status, ['pending', 'escalated', 'approved']),
					gte(leaveApplications.endDate, yearStart)
				)
			),
		spendableCredits(user.id, today),
		loadWeekOffFor([user.id])
	]);

	const isWeekOff = weekOff.resolverFor(user.id);
	const toneOf = toneMapFor(allTypes);
	const typeById = new Map(allTypes.map((t) => [t.id, t]));

	const apps = applicationRows.map((r) => ({
		id: r.application.id,
		typeId: r.application.leaveTypeId,
		typeName: r.typeName,
		start: dateKey(r.application.startDate),
		end: dateKey(r.application.endDate),
		days: Number(r.application.days),
		approved: r.application.status === 'approved'
	}));

	const pink = checkPinkLeaveEligibility(
		profile
			? {
					gender: profile.gender,
					dateOfJoining: profile.dateOfJoining,
					dateOfConfirmation: profile.dateOfConfirmation,
					pinkLeaveEligibleOverride: profile.pinkLeaveEligibleOverride
				}
			: null
	);

	// --- Balances (accrual types with an allocation row) ---
	// Months of accrual still to land after this one.
	const monthsLeft = 11 - (Number(today.slice(5, 7)) - 1);
	const balances: MyBalance[] = [];
	for (const a of allocationRows) {
		const t = typeById.get(a.leaveTypeId);
		// Same filter the Leave page applies on read.
		if (!t || !t.isActive || t.monthlyQuotaDays != null || t.genderEligibility || isCompOffLeaveCode(t.code)) continue;
		const mine = apps.filter((x) => x.typeId === t.id && x.start <= yearEndKey);
		const pending = mine.filter((x) => !x.approved).reduce((s, x) => s + x.days, 0);
		// Approved days still ahead, counted the way the API charged them.
		const scheduled = mine
			.filter((x) => x.approved && x.end > today)
			.reduce((s, x) => s + workingDaysInRange(x.start > today ? x.start : addDays(today, 1), x.end, isWeekOff), 0);
		const allocated = Number(a.allocatedDays);
		const used = Number(a.usedDays);
		const free = round2(allocated - used - pending);
		const accrual = Number(t.accrualPerMonth);
		const yearEnd = round2(free + accrual * monthsLeft);
		const cap = t.carryForwardCap;
		balances.push({
			typeId: t.id,
			code: t.code,
			name: t.name,
			tone: toneOf.get(t.id) ?? 'blue',
			allocated: round2(allocated),
			taken: round2(Math.max(0, used - scheduled)),
			scheduled: round2(Math.min(scheduled, used)),
			pending: round2(pending),
			free,
			accrualPerMonth: accrual,
			yearEnd,
			carryForwardCap: cap,
			// Only flagged where the policy carries some days over; a type that
			// carries none says so in its own line instead.
			lapsing: cap > 0 ? round2(Math.max(0, yearEnd - cap)) : 0,
			encashable: t.encashmentEligible
		});
	}
	balances.sort((x, y) => x.name.localeCompare(y.name));

	const sum = (k: 'allocated' | 'taken' | 'scheduled' | 'pending' | 'free') =>
		round2(balances.reduce((s, b) => s + b[k], 0));

	// --- Monthly quota (pink leave), only for those it applies to ---
	const { start: monthStart, end: monthEnd } = monthBounds(parseKey(today));
	const monthly = pink.eligible
		? allTypes
				.filter((t) => t.isActive && t.monthlyQuotaDays != null)
				.map((t) => {
					const quota = Number(t.monthlyQuotaDays);
					const used = apps
						.filter((x) => x.typeId === t.id && x.start >= monthStart && x.start <= monthEnd)
						.reduce((s, x) => s + x.days, 0);
					return { typeId: t.id, name: t.name, quota, used, remaining: Math.max(0, round2(quota - used)) };
				})
		: [];

	// --- Comp-off credits ---
	const soon = addDays(today, 30);
	const compOff = {
		available: credits.length,
		nextExpiry: credits[0] ? dateKey(credits[0].expiresOn) : null,
		expiringSoon: credits.filter((c) => dateKey(c.expiresOn) <= soon).length
	};

	// --- Holidays on the viewer's own calendar ---
	let calendar: { date: string; name: string; type: string }[] = [];
	if (profile?.shiftGroupId) {
		const rows = await db
			.select({ date: holidays.date, name: holidays.name, type: holidays.type })
			.from(holidays)
			.innerJoin(holidayCalendars, eq(holidays.calendarId, holidayCalendars.id))
			.where(
				and(
					eq(holidayCalendars.shiftGroupId, profile.shiftGroupId),
					eq(holidayCalendars.status, 'published'),
					gte(holidays.date, yearStart),
					lte(holidays.date, horizon)
				)
			);
		const byDate = new Map<string, { date: string; name: string; type: string }>();
		for (const r of rows) {
			const d = dateKey(r.date);
			if (!byDate.has(d)) byDate.set(d, { date: d, name: r.name, type: r.type });
		}
		calendar = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
	}
	const thisYear = calendar.filter((h) => h.date <= yearEndKey);

	// --- Next time away ---
	const ahead = apps.filter((x) => x.end >= today).sort((a, b) => a.start.localeCompare(b.start));
	const first = ahead[0];
	const next = first
		? {
				id: first.id,
				typeName: first.typeName,
				start: first.start,
				end: first.end,
				days: first.days,
				status: first.approved ? ('approved' as const) : ('pending' as const),
				inDays: Math.max(0, daysBetween(today, first.start))
			}
		: null;

	// --- Long-weekend ideas over the next six months ---
	const bookedDays = new Set<string>();
	for (const x of ahead) for (let d = x.start; d <= x.end; d = addDays(d, 1)) bookedDays.add(d);
	const ideas = breakIdeas({
		today,
		until: addDays(today, 183),
		holidays: calendar,
		isWeekOff,
		isBooked: (k) => bookedDays.has(k)
	});

	const types = allTypes
		.filter((t) => t.isActive && (t.genderEligibility || t.monthlyQuotaDays ? pink.eligible : true))
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((t) => ({ id: t.id, name: t.name, tone: toneOf.get(t.id) ?? ('blue' as PlannerTone), compOff: isCompOffLeaveCode(t.code) }));

	return {
		year,
		today,
		balances,
		totals: { allocated: sum('allocated'), taken: sum('taken'), scheduled: sum('scheduled'), pending: sum('pending'), free: sum('free') },
		monthly,
		compOff,
		holidays: {
			hasCalendar: calendar.length > 0,
			upcoming: calendar.filter((h) => h.date >= today).slice(0, 4),
			leftThisYear: thisYear.filter((h) => h.date >= today).length,
			totalThisYear: thisYear.length
		},
		next,
		upcomingCount: ahead.length,
		ideas,
		weekOff: { rosters: weekOff.rosters, assignments: weekOff.assignmentsByUser.get(user.id) ?? [] },
		calendar: calendar.map(({ date, name }) => ({ date, name })),
		booked: ahead.map((x) => ({ start: x.start, end: x.end, typeName: x.typeName, status: x.approved ? 'approved' : 'pending' })),
		types
	};
}


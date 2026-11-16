/**
 * Leave balances are shown month by month, never as a year total: for each
 * type, what this month credits (an accrual type's monthly accrual, a quota
 * type's monthly quota, comp-off credits earned this month) less what is
 * taken and booked this month. Pure, so the month arithmetic is tested.
 *
 * Applying and approving still check the full balance
 * (src/routes/api/leave); this is how the figure is shown.
 */

export type MonthWindow = { start: string; end: string; today: string };

export function monthOf(today: string): MonthWindow {
	const [y, m] = today.split('-').map(Number);
	const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
	const mm = String(m).padStart(2, '0');
	return { start: `${y}-${mm}-01`, end: `${y}-${mm}-${String(last).padStart(2, '0')}`, today };
}

const dayNum = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;
const half = (n: number) => Math.round(n * 2) / 2;

/**
 * How a request's days fall in this month: the part already behind today
 * (taken), the part still ahead (booked). Days are shared out by calendar
 * days, so a request spanning two months counts partly in each; rounded to
 * half days, as leave is booked.
 */
export function splitInMonth(app: { start: string; end: string; days: number }, w: MonthWindow): { past: number; ahead: number } {
	const s = Math.max(dayNum(app.start), dayNum(w.start));
	const e = Math.min(dayNum(app.end), dayNum(w.end));
	if (e < s) return { past: 0, ahead: 0 };
	const span = dayNum(app.end) - dayNum(app.start) + 1;
	const perDay = span > 0 ? app.days / span : 0;
	const t = dayNum(w.today);
	const pastDays = Math.max(0, Math.min(e, t) - s + 1);
	const aheadDays = Math.max(0, e - Math.max(s, t + 1) + 1);
	return { past: half(pastDays * perDay), ahead: half(aheadDays * perDay) };
}

export type MonthlyFigure = {
	typeId: string;
	code: string | null;
	name: string;
	/** What this month gives. */
	credited: number;
	/** Approved, already behind today. */
	taken: number;
	/** Approved, still ahead this month. */
	booked: number;
	/** Waiting on a decision. */
	pending: number;
	/** credited − taken − booked. */
	left: number;
};

export function monthlyFigure(
	type: { id: string; code: string | null; name: string },
	credited: number,
	apps: { start: string; end: string; days: number; approved: boolean }[],
	w: MonthWindow
): MonthlyFigure {
	let taken = 0;
	let booked = 0;
	let pending = 0;
	for (const a of apps) {
		const { past, ahead } = splitInMonth(a, w);
		if (a.approved) {
			taken += past;
			booked += ahead;
		} else pending += past + ahead;
	}
	const r = (n: number) => Math.round(n * 100) / 100;
	return { typeId: type.id, code: type.code, name: type.name, credited: r(credited), taken: r(taken), booked: r(booked), pending: r(pending), left: r(credited - taken - booked) };
}

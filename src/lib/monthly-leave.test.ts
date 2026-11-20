import { describe, expect, it } from 'vitest';
import { monthOf, monthlyFigure, splitInMonth } from './monthly-leave';

const w = monthOf('2026-11-16');

describe('monthly leave', () => {
	it('knows the month', () => {
		expect(w).toEqual({ start: '2026-11-01', end: '2026-11-30', today: '2026-11-16' });
		expect(monthOf('2028-02-10').end).toBe('2028-02-29');
	});

	it('splits a request into taken and still ahead', () => {
		expect(splitInMonth({ start: '2026-11-10', end: '2026-11-10', days: 1 }, w)).toEqual({ past: 1, ahead: 0 });
		expect(splitInMonth({ start: '2026-11-20', end: '2026-11-21', days: 2 }, w)).toEqual({ past: 0, ahead: 2 });
		expect(splitInMonth({ start: '2026-11-15', end: '2026-11-18', days: 4 }, w)).toEqual({ past: 2, ahead: 2 });
	});

	it('counts only the part of a request inside the month', () => {
		expect(splitInMonth({ start: '2026-10-30', end: '2026-11-02', days: 4 }, w)).toEqual({ past: 2, ahead: 0 });
		expect(splitInMonth({ start: '2026-10-01', end: '2026-10-05', days: 5 }, w)).toEqual({ past: 0, ahead: 0 });
	});

	it('gives this month’s credit less what is taken and booked', () => {
		const el = { id: 'el', code: 'EL', name: 'Earned Leave' };
		const f = monthlyFigure(
			el,
			1.5,
			[
				{ start: '2026-11-03', end: '2026-11-03', days: 1, approved: true },
				{ start: '2026-11-25', end: '2026-11-25', days: 0.5, approved: false }
			],
			w
		);
		expect(f).toMatchObject({ credited: 1.5, taken: 1, booked: 0, pending: 0.5, left: 0.5 });
	});
});

import { describe, expect, it } from 'vitest';
import { TOUR_STEPS, stepsFor, type TourAccess } from './steps';

const none: TourAccess = { canAdmin: false, canTeam: false, canPayroll: false, canCreateLogin: false };
const all: TourAccess = { canAdmin: true, canTeam: true, canPayroll: true, canCreateLogin: true };

describe('tour steps', () => {
	it('gives an employee no admin, team, payroll or add-employee steps', () => {
		const ids = stepsFor(none).map((s) => s.id);
		expect(ids).not.toContain('admin');
		expect(ids).not.toContain('team');
		expect(ids).not.toContain('payroll');
		expect(ids).not.toContain('add-employee');
		expect(ids).toContain('leave');
		expect(ids).toContain('attendance');
	});

	it('gives a super admin every step', () => {
		expect(stepsFor(all)).toHaveLength(TOUR_STEPS.length);
	});

	it('opens with the welcome and closes with the wrap-up for everyone', () => {
		for (const access of [none, all]) {
			const s = stepsFor(access);
			expect(s[0].id).toBe('welcome');
			expect(s.at(-1)?.id).toBe('done');
		}
	});

	it('has unique ids and a route for every step', () => {
		const ids = TOUR_STEPS.map((s) => s.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const s of TOUR_STEPS) expect(s.route, s.id).toMatch(/^\//);
	});

	it('keeps each step short enough to read aloud', () => {
		for (const s of TOUR_STEPS) {
			expect(s.title.length, s.id).toBeLessThanOrEqual(40);
			expect(s.body.length, s.id).toBeLessThanOrEqual(260);
		}
	});
});

import { describe, expect, it } from 'vitest';
import { chainAbove, mayOpenPortal, type PortalActor } from './act-as';

const worker = { id: 'ramadass', email: 'infratech0212@no-login.invalid', isActive: true };
const withLogin = { id: 'suresh', email: 'suresh.k@championsmail.com', isActive: true };
// ramadass → hanamanth → hema (a chain on the solid line)
const lines = new Map<string, string | null>([
	['ramadass', 'hanamanth'],
	['hanamanth', 'hema'],
	['hema', null],
	['suresh', 'hanamanth']
]);
const leaders = { chainAbove: chainAbove('ramadass', lines), teamLeadId: 'resort-lead' };
const as = (id: string, role: PortalActor['role'] = 'team_lead'): PortalActor => ({ id, role });

describe('who may open a blue-collar worker’s portal', () => {
	it('lets their manager, anyone above them and their team lead in', () => {
		expect(mayOpenPortal(as('hanamanth'), worker, leaders)).toBe(true);
		expect(mayOpenPortal(as('hema', 'employee'), worker, leaders)).toBe(true);
		expect(mayOpenPortal(as('resort-lead'), worker, leaders)).toBe(true);
	});

	it('lets HR and Super Admins in for anyone blue collar', () => {
		expect(mayOpenPortal(as('priya', 'admin'), worker, { chainAbove: [], teamLeadId: null })).toBe(true);
		expect(mayOpenPortal(as('dev', 'super_admin'), worker, { chainAbove: [], teamLeadId: null })).toBe(true);
	});

	it('keeps out other leads and teammates', () => {
		expect(mayOpenPortal(as('other-lead'), worker, leaders)).toBe(false);
		expect(mayOpenPortal(as('suresh', 'employee'), worker, leaders)).toBe(false);
	});

	it('never opens the account of someone who can sign in, even for a Super Admin', () => {
		expect(mayOpenPortal(as('hanamanth'), withLogin, { chainAbove: ['hanamanth'], teamLeadId: null })).toBe(false);
		expect(mayOpenPortal(as('dev', 'super_admin'), withLogin, { chainAbove: [], teamLeadId: null })).toBe(false);
	});

	it('refuses a deactivated worker', () => {
		expect(mayOpenPortal(as('dev', 'super_admin'), { ...worker, isActive: false }, leaders)).toBe(false);
	});
});

describe('chainAbove', () => {
	it('walks up the line and stops at a loop', () => {
		expect(chainAbove('ramadass', lines)).toEqual(['hanamanth', 'hema']);
		const loop = new Map<string, string | null>([
			['a', 'b'],
			['b', 'c'],
			['c', 'a']
		]);
		expect(chainAbove('a', loop)).toEqual(['b', 'c']);
	});
});

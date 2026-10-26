import { describe, expect, it } from 'vitest';
import { isTopReference, topFromPick, topLabel, topPick, topPositionReference, CHIEF_PICK, MAM_PICK } from './chief';
import { buildOrgTree, type OrgPerson } from './org-chart';

describe('topPositionReference', () => {
	it('recognises Chief however the sheet wrote it', () => {
		for (const raw of ['Chief', 'CHIEF', ' chief ', 'Cheif', 'The Chief', 'Chief.']) {
			expect(topPositionReference(raw)).toBe('chief');
		}
	});

	it('recognises Mam however the sheet wrote it', () => {
		for (const raw of ['Mam', 'MAM', ' mam ', "Ma'am", 'Maam', 'Madam', 'The Mam']) {
			expect(topPositionReference(raw)).toBe('mam');
		}
	});

	it('reads the people who hold the positions as the positions', () => {
		expect(topPositionReference('Subhakar Rao')).toBe('chief');
		expect(topPositionReference(' SUBHAKAR RAO ')).toBe('chief');
		expect(topPositionReference('Hema Malini')).toBe('mam');
		expect(topPositionReference('Hemamalini')).toBe('mam');
	});

	it('does not mistake people or other titles for Chief or Mam', () => {
		for (const raw of [null, '', 'Chief Operating Officer', 'Deepak Guduru', 'Chiefly Rao', 'CEO', 'Mamatha', 'Madam Curie', 'Hema', 'Subhakar Reddy']) {
			expect(isTopReference(raw)).toBe(false);
		}
	});
});

describe('top position pickers', () => {
	it('round-trips each position through its picker value', () => {
		expect(topFromPick(topPick('chief'))).toBe('chief');
		expect(topFromPick(topPick('mam'))).toBe('mam');
		expect(topFromPick(CHIEF_PICK)).toBe('chief');
		expect(topFromPick(MAM_PICK)).toBe('mam');
		expect(topFromPick('some-user-id')).toBeNull();
		expect(topFromPick('')).toBeNull();
	});

	it('labels an old row with no position as Chief', () => {
		expect(topLabel(null)).toBe('Chief');
		expect(topLabel('mam')).toBe('Mam');
	});
});

describe('org chart with Chief', () => {
	const p = (id: string, reportsTo: string | null, reportsToChief = false, topPosition = 'chief'): OrgPerson => ({
		id,
		fullName: id,
		role: 'employee',
		reportsTo,
		teamId: null,
		reportsToChief,
		topPosition
	});

	it('hangs Chief reporters and their teams under Chief, and leaves the rest as roots', () => {
		const chart = buildOrgTree([
			p('director', null, true),
			p('manager', 'director'),
			p('unlinked', null),
			p('stale', 'manager', true) // a real manager wins over the flag
		]);
		expect(chart.underChief.map((n) => n.person.id)).toEqual(['director']);
		expect(chart.underChief[0].children[0].person.id).toBe('manager');
		expect(chart.roots.map((n) => n.person.id)).toEqual(['unlinked']);
		expect(chart.underMam).toEqual([]);
	});

	it('hangs Mam reporters under Mam, beside Chief', () => {
		const chart = buildOrgTree([
			p('director', null, true),
			p('ops-head', null, true, 'mam'),
			p('ops-lead', 'ops-head'),
			p('unlinked', null)
		]);
		expect(chart.underChief.map((n) => n.person.id)).toEqual(['director']);
		expect(chart.underMam.map((n) => n.person.id)).toEqual(['ops-head']);
		expect(chart.underMam[0].children[0].person.id).toBe('ops-lead');
		expect(chart.roots.map((n) => n.person.id)).toEqual(['unlinked']);
	});
});

/**
 * Mirrors canReviewStage() for the Chief case, as approval-chain.test.ts does
 * for the rest, so the routing is pinned without a database.
 */
describe('approvals for people who report to Chief', () => {
	type Actor = { id: string; role: 'admin' | 'super_admin' | 'team_lead' | 'employee' };
	type Requester = { id: string; reportsToChief: boolean; hrId: string | null };

	function managerStage(actor: Actor, r: Requester): boolean {
		if (actor.id === r.id) return false;
		if (r.reportsToChief && r.hrId) return actor.id === r.hrId || actor.role === 'super_admin';
		return actor.role === 'admin' || actor.role === 'super_admin';
	}
	function hrStage(actor: Actor, r: Requester): boolean {
		if (actor.id === r.id) return false;
		if (r.hrId) return actor.id === r.hrId || actor.role === 'super_admin';
		return actor.role === 'admin' || actor.role === 'super_admin';
	}
	/** One approval finishes it when the HR stage lands on the same person. */
	const singleStage = (actor: Actor, r: Requester) => managerStage(actor, r) && hrStage(actor, r);

	const priya: Actor = { id: 'priya', role: 'admin' };
	const otherHr: Actor = { id: 'ravi', role: 'admin' };
	const lead: Actor = { id: 'lead', role: 'team_lead' };
	const director: Requester = { id: 'director', reportsToChief: true, hrId: 'priya' };

	it('goes straight to the concerned HR, who approves it in one step', () => {
		expect(managerStage(priya, director)).toBe(true);
		expect(singleStage(priya, director)).toBe(true);
	});

	it('is not in another admin’s or a team lead’s queue', () => {
		expect(managerStage(otherHr, director)).toBe(false);
		expect(managerStage(lead, director)).toBe(false);
	});

	it('falls to any admin, still in one step, when no concerned HR is set', () => {
		const noHr: Requester = { ...director, hrId: null };
		expect(singleStage(otherHr, noHr)).toBe(true);
	});
});

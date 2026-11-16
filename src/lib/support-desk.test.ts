import { describe, expect, it } from 'vitest';
import { deskResponderIds, deskTeamOf, deskUniqueKey } from './support-desk';
import { SUPPORT_TEAMS, effectiveCapabilities, supportTeamCapabilities } from './capabilities';

describe('desk responders', () => {
	it('sends a question to every member of the team', () => {
		expect(deskResponderIds('it', { id: 'e' }, ['it1', 'it2'], ['sa'])).toEqual(['it1', 'it2']);
	});

	it('adds the concerned HR on Ask HR, and only there', () => {
		expect(deskResponderIds('hr', { id: 'e', hrUserId: 'chr' }, ['hr1'], [])).toEqual(['chr', 'hr1']);
		expect(deskResponderIds('it', { id: 'e', hrUserId: 'chr' }, ['it1'], [])).toEqual(['it1']);
	});

	it('falls back when nobody is in the team yet', () => {
		expect(deskResponderIds('engagement', { id: 'e' }, [], ['sa1', 'sa2'])).toEqual(['sa1', 'sa2']);
		// Ask HR as before the teams: the concerned HR alone, else every HR admin.
		expect(deskResponderIds('hr', { id: 'e', hrUserId: 'chr' }, [], ['adm'])).toEqual(['chr']);
		expect(deskResponderIds('hr', { id: 'e' }, [], ['adm', 'e'])).toEqual(['adm']);
	});

	it('never makes the person asking their own responder', () => {
		expect(deskResponderIds('it', { id: 'it1' }, ['it1', 'it2'], [])).toEqual(['it2']);
	});

	it('keeps the old Ask HR key and gives the new desks their own', () => {
		expect(deskUniqueKey('hr', 'u')).toBe('desk:u');
		expect(deskUniqueKey('it', 'u')).toBe('desk:it:u');
		expect(deskTeamOf(null)).toBe('hr');
		expect(deskTeamOf('engagement')).toBe('engagement');
	});
});

describe('support team privileges', () => {
	it('each team can answer its own desk and no other', () => {
		for (const t of SUPPORT_TEAMS) {
			const caps = supportTeamCapabilities([t.key]);
			expect(caps).toContain(t.deskCap);
			for (const other of SUPPORT_TEAMS.filter((o) => o.key !== t.key)) expect(caps).not.toContain(other.deskCap);
		}
	});

	it('adds to an employee what the team brings, and stacks across teams', () => {
		const it = effectiveCapabilities('employee', supportTeamCapabilities(['it']));
		expect(it).toContain('it.dashboard');
		expect(it).not.toContain('announcements.post');
		const both = effectiveCapabilities('employee', supportTeamCapabilities(['it', 'engagement']));
		expect(both).toContain('it.dashboard');
		expect(both).toContain('announcements.post');
		// No team brings Admin Controls › People.
		for (const k of ['people.directory', 'people.create_login', 'people.reset_password']) expect(effectiveCapabilities('employee', supportTeamCapabilities(['hr', 'it', 'engagement']))).not.toContain(k);
	});

	it('only bundles privileges a team member may hold', () => {
		const employeeMax = effectiveCapabilities('employee', SUPPORT_TEAMS.flatMap((t) => t.capabilities));
		for (const t of SUPPORT_TEAMS) for (const k of t.capabilities) expect(employeeMax, `${t.key}: ${k}`).toContain(k);
	});
});

import { describe, expect, it } from 'vitest';
import { grantableFor, canOpenAdmin, defaultCapabilities, effectiveCapabilities, ROLE_PRESETS, CAPABILITY_KEYS, supportTeamCapabilities } from './capabilities';
import { visibleAdminTabs } from './admin-tabs';
import { dmAllowed, type Person } from './server/chat/access';

describe('role editor choices', () => {
	it.each(['employee', 'team_lead'] as const)('does not offer policy publishing on %s', (role) => {
		expect(grantableFor(role).map((c) => c.key)).not.toContain('policies.publish');
	});
	it('offers policy publishing on admin', () => {
		expect(grantableFor('admin').map((c) => c.key)).toContain('policies.publish');
	});
});

describe('effective privileges', () => {
	it.each(['employee', 'team_lead', 'admin'] as const)('keeps restricted surfaces out of %s defaults', (role) => {
		expect(defaultCapabilities(role)).not.toContain('policies.publish');
		expect(defaultCapabilities(role)).not.toContain('system.design_tweaks');
	});

	it.each(['employee', 'team_lead'] as const)('ignores legacy restricted grants for %s', (role) => {
		const caps = effectiveCapabilities(role, ['policies.publish', 'system.design_tweaks', 'chat.manage_rules']);
		expect(caps).not.toContain('policies.publish');
		expect(caps).not.toContain('system.design_tweaks');
		expect(caps).toContain('chat.manage_rules');
		expect(visibleAdminTabs(caps).map((t) => t.id)).not.toContain('policies');
		expect(visibleAdminTabs(caps).map((t) => t.id)).not.toContain('tweaks');
	});

	it('allows explicitly delegated policy publishing to admin, but never design tweaks', () => {
		const caps = effectiveCapabilities('admin', ['policies.publish', 'system.design_tweaks']);
		expect(caps).toContain('policies.publish');
		expect(caps).not.toContain('system.design_tweaks');
		expect(visibleAdminTabs(caps).map((t) => t.label)).toContain('Publish policies');
		expect(visibleAdminTabs(effectiveCapabilities('super_admin')).map((t) => t.label)).toContain('Design tweaks');
	});

	it('gives a Super Admin everything and nobody else the Super Admin-only powers', () => {
		expect(effectiveCapabilities('super_admin')).toEqual(CAPABILITY_KEYS);
		const all = effectiveCapabilities('admin', CAPABILITY_KEYS);
		for (const only of ['people.delete', 'people.assign_roles', 'system.roles', 'system.cleanup', 'chat.export']) {
			expect(all).not.toContain(only);
		}
	});

	it('keeps an employee out of Admin Controls until a named role adds a privilege', () => {
		expect(canOpenAdmin(defaultCapabilities('employee'))).toBe(false);
		const it = ROLE_PRESETS.find((p) => p.name === 'IT Support')!;
		const caps = effectiveCapabilities(it.baseRole, it.capabilities);
		expect(canOpenAdmin(caps)).toBe(true);
		expect(visibleAdminTabs(caps).map((t) => t.id)).toEqual(['overview', 'people', 'biometric']);
	});

	it('drops unknown privilege keys saved before the catalogue changed', () => {
		expect(effectiveCapabilities('employee', ['made.up', 'org.view'])).toEqual(['org.view']);
	});

	it('shows an HR Admin the tabs they could before named roles existed, plus who is in HR, IT and Engagement', () => {
		expect(visibleAdminTabs(defaultCapabilities('admin')).map((t) => t.id)).toEqual(['overview', 'analytics', 'people', 'alumni', 'biometric', 'balances', 'org', 'access', 'support', 'chat']);
	});

	it('gives each team its own tabs and never People', () => {
		const tabsOf = (team: string) => visibleAdminTabs(effectiveCapabilities('employee', supportTeamCapabilities([team]))).map((t) => t.id);
		expect(tabsOf('it')).toEqual(expect.arrayContaining(['it', 'biometric']));
		expect(tabsOf('engagement')).toContain('engagement');
		expect(tabsOf('hr')).toContain('alumni');
		for (const team of ['hr', 'it', 'engagement']) for (const tab of ['people', 'policies', 'access', 'support']) expect(tabsOf(team), `${team}: ${tab}`).not.toContain(tab);
		expect(tabsOf('hr')).not.toContain('org');
	});
});

describe('who an employee can message', () => {
	const p = (id: string, over: Partial<Person> = {}): Person => ({ id, fullName: id, role: 'employee', teamId: null, reportsTo: null, hrUserId: null, isActive: true, ...over });
	const anil = p('anil', { teamId: 'ops', reportsTo: 'rahul', hrUserId: 'priya' });

	it('allows their team, manager, concerned HR and HR admins', () => {
		expect(dmAllowed(anil, p('aditi', { teamId: 'ops' }), false)).toBe(true);
		expect(dmAllowed(anil, p('rahul', { role: 'team_lead' }), false)).toBe(true);
		expect(dmAllowed(anil, p('priya', { role: 'admin' }), false)).toBe(true);
		expect(dmAllowed(anil, p('sneha', { role: 'admin' }), false)).toBe(true);
	});

	it('refuses someone outside all of those, unless they may message anyone', () => {
		const sales = p('neha', { teamId: 'sales' });
		expect(dmAllowed(anil, sales, false)).toBe(false);
		expect(dmAllowed(anil, sales, true)).toBe(true);
	});

	it('never allows yourself or someone who has left', () => {
		expect(dmAllowed(anil, anil, true)).toBe(false);
		expect(dmAllowed(anil, p('gone', { teamId: 'ops', isActive: false }), true)).toBe(false);
	});
});

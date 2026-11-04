import { describe, expect, it } from 'vitest';
import { adminNav, visibleAdminTabs } from './admin-tabs';
import { defaultCapabilities, effectiveCapabilities } from './capabilities';

describe('adminNav', () => {
	it('groups super admin into six entries without losing a route', () => {
		const caps = effectiveCapabilities('super_admin');
		const nav = adminNav(caps);
		expect(nav.map((e) => e.kind === 'tab' ? e.tab.label : e.label)).toEqual(['Overview', 'HR analytics', 'People', 'Time off', 'Policies', 'System']);
		expect(nav.flatMap((e) => e.kind === 'tab' ? [e.tab.href] : e.tabs.map((t) => t.href)).sort()).toEqual(visibleAdminTabs(caps).map((t) => t.href).sort());
	});
	it('keeps admin capabilities unchanged', () => {
		const tabs = adminNav(defaultCapabilities('admin')).flatMap((e) => e.kind === 'tab' ? [e.tab] : e.tabs);
		expect(tabs.some((t) => t.id === 'policies' || t.id === 'tweaks')).toBe(false);
		expect(tabs).toHaveLength(visibleAdminTabs(defaultCapabilities('admin')).length);
	});
	it('renders the sole System child as Zoom', () => {
		expect(adminNav(['system.zoom']).map((e) => e.kind === 'tab' ? e.tab.label : e.label)).toEqual(['Overview', 'Zoom']);
	});
	it('omits empty groups', () => {
		expect(adminNav([]).map((e) => e.kind === 'tab' && e.tab.id)).toEqual(['overview']);
	});
});

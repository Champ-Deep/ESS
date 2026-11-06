import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { SessionUser } from './auth';

const { select, limit } = vi.hoisted(() => ({ select: vi.fn(), limit: vi.fn() }));
vi.mock('$lib/server/db/postgres', () => ({ db: { select } }));
import { gateAdminPage, hasCap, invalidateCapabilities, loadCapabilities, requireCap } from './capabilities';

const user = (role: SessionUser['role'], capabilities: SessionUser['capabilities'] = ['policies.publish', 'system.design_tweaks']): SessionUser => ({
	id: 'fixture', email: 'fixture@example.invalid', fullName: 'Fixture', role, teamId: null, mustChangePassword: false, capabilities
});

beforeEach(() => {
	invalidateCapabilities();
	vi.clearAllMocks();
	const query = { from: () => query, leftJoin: () => query, where: () => query, limit };
	select.mockReturnValue(query);
	limit.mockResolvedValue([{ customRoleId: 'legacy', name: 'Legacy grants', capabilities: ['policies.publish', 'system.design_tweaks'] }]);
});

describe('restricted server capabilities', () => {
	it.each(['employee', 'team_lead'] as const)('rejects supplied restricted grants for %s', (role) => {
		for (const key of ['policies.publish', 'system.design_tweaks'] as const) {
			const current = user(role);
			expect(hasCap(current, key)).toBe(false);
			expect(() => requireCap({ locals: { user: current } } as RequestEvent, key)).toThrow(expect.objectContaining({ status: 403 }));
			expect(() => gateAdminPage({ user: current }, [key])).toThrow(expect.objectContaining({ status: 303, location: '/admin' }));
		}
	});

	it('requires the explicit policy grant for admin and never allows admin design tweaks', () => {
		expect(hasCap(user('admin', []), 'policies.publish')).toBe(false);
		expect(hasCap(user('admin'), 'system.design_tweaks')).toBe(false);
		expect(gateAdminPage({ user: user('admin') }, ['policies.publish']).role).toBe('admin');
	});

	it('allows both surfaces for super_admin', () => {
		for (const key of ['policies.publish', 'system.design_tweaks'] as const) {
			expect(requireCap({ locals: { user: user('super_admin', []) } } as RequestEvent, key).role).toBe('super_admin');
		}
	});

	it('rejects unauthenticated requests', () => {
		expect(hasCap(null, 'policies.publish')).toBe(false);
		expect(() => requireCap({ locals: { user: null } } as RequestEvent, 'policies.publish')).toThrow(expect.objectContaining({ status: 401 }));
		expect(() => gateAdminPage({ user: null }, ['system.design_tweaks'])).toThrow(expect.objectContaining({ location: '/login' }));
	});

	it('does not reuse privileged cached capabilities after a base-role downgrade', async () => {
		expect((await loadCapabilities(user('super_admin'))).caps).toContain('system.design_tweaks');
		const lowered = await loadCapabilities(user('employee'));
		expect(lowered.caps).not.toContain('policies.publish');
		expect(lowered.caps).not.toContain('system.design_tweaks');
		expect(select).toHaveBeenCalledTimes(2);
		await loadCapabilities(user('employee'));
		expect(select).toHaveBeenCalledTimes(2);
	});
});

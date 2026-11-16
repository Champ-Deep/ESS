import { describe, expect, it } from 'vitest';
import { animAt, fillSlots, sceneAt } from './render';
import { MOTION_TEMPLATES, motionTemplate, totalSeconds, withDefaults } from './templates';

describe('motion templates', () => {
	it('are all short, vertical-friendly and use only their own slots', () => {
		for (const t of MOTION_TEMPLATES) {
			expect(totalSeconds(t), t.id).toBeLessThanOrEqual(12);
			const used = new Set<string>();
			for (const s of t.scenes) for (const l of s.layers) if (l.type === 'text') for (const m of l.text.matchAll(/\{([a-z_]+)/g)) used.add(m[1]);
			for (const key of used) expect(Object.keys(t.slots), `${t.id}: {${key}}`).toContain(key);
			for (const s of t.scenes) for (const l of s.layers) if ('box' in l) expect(l.box.length, t.id).toBe(4);
		}
	});

	it('fills slots, list items and keeps unknown names', () => {
		expect(fillSlots('Happy birthday, {name}!', { name: 'Asha' })).toBe('Happy birthday, Asha!');
		expect(fillSlots('{facts.1}', { facts: ['a', 'b', 'c'] })).toBe('b');
		expect(fillSlots('{who}', {})).toBe('{who}');
	});

	it('keeps defaults for blanks and lists at their length', () => {
		const t = motionTemplate('employee-spotlight')!;
		const v = withDefaults(t, { name: 'Ravi', facts: ['Plays chess'] });
		expect(v.name).toBe('Ravi');
		expect(v.role).toBe(t.defaults.role);
		expect(v.facts).toEqual(['Plays chess', 'Bakes on Sundays', 'Speaks four languages']);
	});
});

describe('timing', () => {
	const t = motionTemplate('birthday-burst')!;

	it('finds the scene and loops', () => {
		expect(sceneAt(t, 0)).toEqual({ index: 0, local: 0 });
		expect(sceneAt(t, 4).index).toBe(1);
		expect(sceneAt(t, totalSeconds(t) + 0.5).index).toBe(0);
	});

	it('hides a layer before it starts and animates it in', () => {
		const layer = { start: 1, in: { type: 'fade' as const, sec: 0.5 } };
		expect(animAt(layer, 0.5, 4).alpha).toBe(0);
		expect(animAt(layer, 1.25, 4).alpha).toBeGreaterThan(0);
		expect(animAt(layer, 1.25, 4).alpha).toBeLessThan(1);
		expect(animAt(layer, 2, 4).alpha).toBe(1);
	});

	it('wipes reveal from nothing to all', () => {
		const layer = { start: 0, in: { type: 'wipe' as const, sec: 1 } };
		expect(animAt(layer, 0, 3).reveal).toBe(0);
		expect(animAt(layer, 1.5, 3).reveal).toBe(1);
	});
});

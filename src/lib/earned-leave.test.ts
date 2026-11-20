import { describe, expect, it } from 'vitest';
import { isEarnedLeave } from './earned-leave';

describe('earned leave', () => {
	it('is recognised by code or name', () => {
		expect(isEarnedLeave({ code: 'EL', name: 'Earned Leave' })).toBe(true);
		expect(isEarnedLeave({ code: 'pl', name: 'Privilege Leave' })).toBe(true);
		expect(isEarnedLeave({ code: 'X1', name: 'Earned leave (annual)' })).toBe(true);
	});

	it('leaves out every other type', () => {
		for (const t of [{ code: 'SL', name: 'Sick Leave' }, { code: 'PINK', name: 'Pink Leave' }, { code: 'COMP_OFF', name: 'Comp Off' }, { code: 'CL', name: 'Casual Leave' }]) {
			expect(isEarnedLeave(t), t.name).toBe(false);
		}
		expect(isEarnedLeave(null)).toBe(false);
	});
});

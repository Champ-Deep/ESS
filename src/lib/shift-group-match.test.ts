import { describe, expect, it } from 'vitest';
import { matchShiftGroup } from './shift-group-match';

const day = { id: 'd', key: 'day_shift', name: 'Day Shift' };
const night = { id: 'n', key: 'night_shift', name: 'Night Shift' };
const sg = { id: 's', key: 'singapore', name: 'Singapore' };

describe('matchShiftGroup', () => {
	it('matches the sheet text by name or key, ignoring case and punctuation', () => {
		expect(matchShiftGroup('night shift', [day, night])).toBe('n');
		expect(matchShiftGroup('DAY_SHIFT', [day, night])).toBe('d');
		expect(matchShiftGroup('Singapore', [day, night, sg])).toBe('s');
	});

	it('takes a partial match only when exactly one group fits', () => {
		expect(matchShiftGroup('Night', [day, night])).toBe('n');
		expect(matchShiftGroup('Shift', [day, night])).toBeNull();
	});

	it('puts everyone in the only group when there is just one', () => {
		expect(matchShiftGroup(null, [day])).toBe('d');
		expect(matchShiftGroup('General', [day])).toBe('d');
	});

	it('leaves it unset when several groups exist and nothing matches', () => {
		expect(matchShiftGroup(null, [day, night])).toBeNull();
		expect(matchShiftGroup('General', [day, night])).toBeNull();
		expect(matchShiftGroup('Day', [])).toBeNull();
	});
});

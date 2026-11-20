import { describe, expect, it } from 'vitest';
import { celebrationsOn, reelRunsOn, renderTemplate } from './engagement';

describe('whose day it is', () => {
	it('finds a birthday by day and month', () => {
		expect(celebrationsOn('2026-11-16', { fullName: 'Asha Rao', dob: '1994-11-16' })).toEqual([{ kind: 'birthday', years: null }]);
		expect(celebrationsOn('2026-11-17', { fullName: 'Asha Rao', dob: '1994-11-16' })).toEqual([]);
	});

	it('celebrates a 29 February birthday on the 28th in other years', () => {
		expect(celebrationsOn('2026-02-28', { fullName: 'L', dob: '2000-02-29' })).toHaveLength(1);
		expect(celebrationsOn('2028-02-28', { fullName: 'L', dob: '2000-02-29' })).toHaveLength(0);
		expect(celebrationsOn('2028-02-29', { fullName: 'L', dob: '2000-02-29' })).toHaveLength(1);
	});

	it('counts work anniversaries from one year on, not the joining day itself', () => {
		expect(celebrationsOn('2026-11-16', { fullName: 'A', dateOfJoining: '2023-11-16' })).toEqual([{ kind: 'work_anniversary', years: 3 }]);
		expect(celebrationsOn('2026-11-16', { fullName: 'A', dateOfJoining: '2026-11-16' })).toEqual([]);
	});

	it('reads wedding anniversaries written as free text', () => {
		expect(celebrationsOn('2026-11-16', { fullName: 'A', weddingAnniversary: '16-Nov-2018' })).toEqual([{ kind: 'wedding_anniversary', years: 8 }]);
		expect(celebrationsOn('2026-11-16', { fullName: 'A', weddingAnniversary: '16/11' })).toEqual([{ kind: 'wedding_anniversary', years: null }]);
		expect(celebrationsOn('2026-11-16', { fullName: 'A', weddingAnniversary: 'NA' })).toEqual([]);
	});
});

describe('template words', () => {
	const asha = { fullName: 'Asha  Rao', team: 'Data Team', designation: 'Analyst' };

	it('fills the placeholders', () => {
		expect(renderTemplate('Happy birthday, {first_name}!', asha, null)).toBe('Happy birthday, Asha!');
		expect(renderTemplate('{years} {years_word} at Champions, {name} ({team})', asha, 1)).toBe('1 year at Champions, Asha Rao (Data Team)');
		expect(renderTemplate('{years} {years_word}', asha, 5)).toBe('5 years');
	});

	it('leaves unknown placeholders for the studio to spot', () => {
		expect(renderTemplate('Hi {nickname}', asha, null)).toBe('Hi {nickname}');
	});
});

describe('reel dates', () => {
	it('runs only while active and inside its dates', () => {
		expect(reelRunsOn({ active: true, startsOn: null, endsOn: null }, '2026-11-16')).toBe(true);
		expect(reelRunsOn({ active: false, startsOn: null, endsOn: null }, '2026-11-16')).toBe(false);
		expect(reelRunsOn({ active: true, startsOn: '2026-11-17', endsOn: null }, '2026-11-16')).toBe(false);
		expect(reelRunsOn({ active: true, startsOn: '2026-11-01', endsOn: '2026-11-16' }, '2026-11-16')).toBe(true);
		expect(reelRunsOn({ active: true, startsOn: null, endsOn: '2026-11-15' }, '2026-11-16')).toBe(false);
	});
});

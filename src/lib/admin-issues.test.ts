import { describe, expect, it } from 'vitest';
import { adminStrips, deriveAdminIssues, tabSeverities, type AdminFacts } from './admin-issues';
import { adminTabForPath, visibleAdminTabs } from './admin-tabs';
import { CAPABILITY_KEYS, defaultCapabilities } from './capabilities';

/** A Super Admin sees every issue; HR Admin sees what their defaults can fix. */
const SA = CAPABILITY_KEYS;
const HR = defaultCapabilities('admin');

// 28 Sep 2026, midday IST.
const NOW = new Date('2026-09-28T06:30:00Z');
const DAY = 86_400_000;

function facts(over: Partial<AdminFacts> = {}): AdminFacts {
	return {
		activePeople: 248,
		withoutManager: 0,
		loopMemberNames: [],
		lastAttendanceImportAt: new Date(NOW.getTime() - 2 * 3_600_000).toISOString(),
		lastManualUpload: null,
		pendingLeave: 0,
		pendingLeaveOld: 0,
		staleTemporaryPasswords: 0,
		pendingBulkImports: { count: 0, latestFilename: null, latestRows: null },
		publishedCalendarYears: [2026],
		activeLeaveTypes: 7,
		hrSetBalancesByYear: {},
		staleConfirmations: [],
		chat: { activePeople: 0, messages: 0, openDeskQuestions: 0 },
		...over
	};
}

describe('deriveAdminIssues', () => {
	it('reports nothing for a healthy portal', () => {
		expect(deriveAdminIssues(facts(), SA, NOW)).toEqual([]);
	});

	it('grades a silent attendance feed by how long it has been quiet', () => {
		const at = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
		expect(deriveAdminIssues(facts({ lastAttendanceImportAt: at(1) }), SA, NOW)).toEqual([]);
		expect(deriveAdminIssues(facts({ lastAttendanceImportAt: at(2) }), SA, NOW)[0].severity).toBe('warn');
		const [stale] = deriveAdminIssues(facts({ lastAttendanceImportAt: at(3) }), SA, NOW);
		expect(stale.severity).toBe('bad');
		expect(stale.title).toBe('No attendance has arrived for 3 days');
		expect(stale.href).toBe('/admin/biometric');
	});

	it('hides Super Admin-only problems from HR admins', () => {
		const f = facts({
			publishedCalendarYears: [],
			activeLeaveTypes: 0,
			pendingBulkImports: { count: 1, latestFilename: 'joiners.xlsx', latestRows: 42 }
		});
		expect(deriveAdminIssues(f, SA, NOW).map((i) => i.tab)).toEqual(['policies', 'policies', 'people']);
		expect(deriveAdminIssues(f, HR, NOW)).toEqual([]);
	});

	it('asks for next year’s calendar only from October', () => {
		const sept = deriveAdminIssues(facts(), SA, NOW);
		const october = new Date('2026-10-02T06:30:00Z');
		const oct = deriveAdminIssues(facts({ lastAttendanceImportAt: october.toISOString() }), SA, october);
		expect(sept).toEqual([]);
		expect(oct.map((i) => i.title)).toEqual(['The 2027 holiday calendar is not published']);
	});

	it('changes an issue id when its size changes, so a dismissal does not stick forever', () => {
		const a = deriveAdminIssues(facts({ withoutManager: 23 }), SA, NOW)[0];
		const b = deriveAdminIssues(facts({ withoutManager: 24 }), SA, NOW)[0];
		expect(a.id).not.toBe(b.id);
	});

	it('puts the worst problems first', () => {
		const issues = deriveAdminIssues(
			facts({ withoutManager: 3, staleTemporaryPasswords: 2, loopMemberNames: ['A', 'B'] }),
			SA,
			NOW
		);
		expect(issues.map((i) => i.severity)).toEqual(['bad', 'warn', 'info']);
	});
});

describe('tabSeverities', () => {
	it('keeps the worst severity per tab and ignores links outside Admin Controls', () => {
		const issues = deriveAdminIssues(
			facts({ withoutManager: 3, loopMemberNames: ['A'], pendingLeaveOld: 2, pendingLeave: 5 }),
			SA,
			NOW
		);
		expect(tabSeverities(issues)).toEqual({ org: 'bad' });
	});
});

describe('adminStrips', () => {
	it('states the match rate of the last manual upload', () => {
		const strips = adminStrips(
			facts({ lastManualUpload: { at: NOW.toISOString(), rowCount: 200, matched: 192, unmatched: 8 } }),
			NOW
		);
		expect(strips.biometric?.[1].value).toBe('96%');
		expect(strips.biometric?.[1].tone).toBe('warn');
	});
});

describe('adminStrips leave policy hint', () => {
	const noTypes = facts({ activeLeaveTypes: 0 });
	const hint = (caps: string[]) => adminStrips(noTypes, NOW, caps).overview?.find((i) => i.label === 'Leave types published')?.detail;
	it('shows the publish hint only to someone who can publish', () => {
		expect(hint(['policies.publish'])).toBe('Publish the leave policy');
		expect(hint(['people.directory'])).toBeUndefined();
	});
});

describe('admin tabs', () => {
	it('matches nested paths to their tab and only the bare path to Overview', () => {
		expect(adminTabForPath('/admin')?.id).toBe('overview');
		expect(adminTabForPath('/admin/')?.id).toBe('overview');
		expect(adminTabForPath('/admin/biometric')?.id).toBe('biometric');
		expect(adminTabForPath('/admin/people')?.id).toBe('people');
		expect(adminTabForPath('/admin/unknown')).toBeUndefined();
	});

	it('leaves Super Admin tools out for HR admins', () => {
		const ids = visibleAdminTabs(HR).map((t) => t.id);
		expect(ids).not.toContain('policies');
		expect(ids).not.toContain('cleanup');
		expect(ids).not.toContain('tweaks');
		expect(ids).toContain('biometric');
	});
});

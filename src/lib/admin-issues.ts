import type { AdminTabId } from './admin-tabs';

/**
 * What Admin Controls says needs attention, worked out from facts about the
 * live data.
 *
 * Kept apart from the queries (src/lib/server/admin-health.ts) so the rules —
 * which condition is a problem, how bad, and which tab fixes it — can be
 * tested without a database. Every fact is plain JSON so it crosses the
 * server/client boundary unchanged.
 */

export type AdminFacts = {
	activePeople: number;
	/** Active people with no reporting manager, Super Admins excluded. */
	withoutManager: number;
	/** Active people with no shift group (so no holiday calendar), Super Admins excluded. */
	withoutShift?: number;
	/** People on the alumni list who have left and can still sign in. */
	leaversWithLogin?: number;
	/** Names of people whose chain of managers loops back on itself. */
	loopMemberNames: string[];
	/** ISO timestamp of the latest attendance import, device feed or manual. */
	lastAttendanceImportAt: string | null;
	lastManualUpload: { at: string; rowCount: number; matched: number; unmatched: number } | null;
	pendingLeave: number;
	/** Pending leave requests raised more than three days ago. */
	pendingLeaveOld: number;
	/** People still on the temporary password issued over two weeks ago. */
	staleTemporaryPasswords: number;
	pendingBulkImports: { count: number; latestFilename: string | null; latestRows: number | null };
	/** Years that have at least one published holiday calendar. */
	publishedCalendarYears: number[];
	activeLeaveTypes: number;
	/** People with an HR-set balance, by leave year. */
	hrSetBalancesByYear: Record<number, number>;
	/** Live posts asking for confirmation, over three days old, under 80% confirmed. */
	staleConfirmations: { id: string; title: string; confirmed: number; audience: number }[];
	/** Champ Chat in the last 7 days. */
	chat: { activePeople: number; messages: number; openDeskQuestions: number };
};

export type Severity = 'bad' | 'warn' | 'info';

export type AdminIssue = {
	/**
	 * Stable per condition *and* its current size, so a dismissed issue comes
	 * back once the numbers move instead of staying hidden for good.
	 */
	id: string;
	severity: Severity;
	title: string;
	detail: string;
	/** 'leave' and 'chat' link outside Admin Controls, so they carry no tab dot. */
	tab: AdminTabId | 'leave' | 'chat';
	href: string;
	cta: string;
	superAdminOnly?: boolean;
};

export type StripItem = {
	value: string;
	label: string;
	detail?: string;
	tone?: 'ok' | 'warn' | 'bad' | 'muted';
};

const DAY = 86_400_000;

function plural(n: number, one: string, many = one + 's'): string {
	return `${n} ${n === 1 ? one : many}`;
}

/** Whole days between an ISO timestamp and now, never negative. */
export function daysSince(iso: string | null, now: Date): number | null {
	if (!iso) return null;
	return Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / DAY));
}

function shortDate(iso: string): string {
	return new Date(iso).toLocaleDateString('en-IN', {
		day: 'numeric',
		month: 'short',
		timeZone: 'Asia/Kolkata'
	});
}

/** IST calendar year and month (0-based), since that is the company's calendar. */
function istYearMonth(now: Date): { year: number; month: number } {
	const ist = new Date(now.getTime() + 5.5 * 3_600_000);
	return { year: ist.getUTCFullYear(), month: ist.getUTCMonth() };
}

/**
 * `caps` are the viewer's privileges (src/lib/capabilities.ts): a problem only
 * shows to someone who can fix it.
 */
export function deriveAdminIssues(facts: AdminFacts, caps: readonly string[], now: Date): AdminIssue[] {
	const can = (key: string) => caps.includes(key);
	const issues: AdminIssue[] = [];
	const { year, month } = istYearMonth(now);

	const importDays = daysSince(facts.lastAttendanceImportAt, now);
	if (importDays === null) {
		issues.push({
			id: 'attendance-none',
			severity: 'info',
			title: 'No attendance has been imported yet',
			detail: 'Nothing has arrived from the biometric devices. Upload a device report to start.',
			tab: 'biometric',
			href: '/admin/biometric',
			cta: 'Upload report'
		});
	} else if (importDays >= 2) {
		issues.push({
			id: `attendance-stale-${facts.lastAttendanceImportAt}`,
			severity: importDays >= 3 ? 'bad' : 'warn',
			title: `No attendance has arrived for ${plural(importDays, 'day')}`,
			detail: `The last import was on ${shortDate(facts.lastAttendanceImportAt!)}. The device feed may have stopped; upload its report for the missing days.`,
			tab: 'biometric',
			href: '/admin/biometric',
			cta: 'Upload report'
		});
	}

	if (facts.loopMemberNames.length > 0) {
		const names = facts.loopMemberNames.slice(0, 3).join(', ');
		const more = facts.loopMemberNames.length > 3 ? ` and ${facts.loopMemberNames.length - 3} more` : '';
		issues.push({
			id: `org-loop-${facts.loopMemberNames.length}`,
			severity: 'bad',
			title: `${plural(facts.loopMemberNames.length, 'person is', 'people are')} in a reporting loop`,
			detail: `${names}${more}. Their chain of managers never reaches the top, so it has to be broken by hand.`,
			tab: 'org',
			href: '/admin/org-chart',
			cta: 'Open org chart'
		});
	}

	if (facts.withoutManager > 0) {
		issues.push({
			id: `org-unmanaged-${facts.withoutManager}`,
			severity: 'warn',
			title: `${plural(facts.withoutManager, 'person has', 'people have')} no manager`,
			detail: 'Leave approvals and the org chart both depend on a reporting manager. Super Admins are not counted.',
			tab: 'org',
			href: '/admin/org-chart',
			cta: 'Review'
		});
	}

	if ((facts.withoutShift ?? 0) > 0) {
		const n = facts.withoutShift ?? 0;
		issues.push({
			id: `people-no-shift-${n}`,
			severity: 'warn',
			title: `${plural(n, 'person has', 'people have')} no shift group`,
			detail: 'They see no holiday calendar, and their holidays are not counted in attendance or payroll. Set it in each person’s settings.',
			tab: 'people',
			href: '/admin/people',
			cta: 'Open people'
		});
	}

	if (facts.pendingLeaveOld > 0) {
		issues.push({
			id: `leave-old-${facts.pendingLeaveOld}`,
			severity: 'warn',
			title: `${plural(facts.pendingLeaveOld, 'leave request has', 'leave requests have')} waited over 3 days`,
			detail: `${plural(facts.pendingLeave, 'request is', 'requests are')} pending in total.`,
			tab: 'leave',
			href: '/leave',
			cta: 'Open approvals'
		});
	}

	if (can('people.alumni') && (facts.leaversWithLogin ?? 0) > 0) {
		const n = facts.leaversWithLogin ?? 0;
		issues.push({
			id: `alumni-open-${n}`,
			severity: 'warn',
			title: `${plural(n, 'person who has left still has', 'people who have left still have')} a login`,
			detail: 'They are on the alumni list but can still sign in. Close their logins from Alumni.',
			tab: 'alumni',
			href: '/admin/alumni',
			cta: 'Review'
		});
	}

	if (can('people.bulk_import') && facts.pendingBulkImports.count > 0) {
		const { count, latestFilename, latestRows } = facts.pendingBulkImports;
		issues.push({
			id: `bulk-pending-${count}-${latestFilename}`,
			severity: 'info',
			title: `${plural(count, 'bulk import is', 'bulk imports are')} waiting for review`,
			detail: latestFilename
				? `Latest: ${latestFilename}${latestRows != null ? `, ${plural(latestRows, 'row')}` : ''}. No logins are created until it is applied.`
				: 'No logins are created until it is applied.',
			tab: 'people',
			href: '/admin/people?view=bulk',
			cta: 'Review import',
			superAdminOnly: true
		});
	}

	for (const post of facts.staleConfirmations) {
		const pct = post.audience > 0 ? Math.round((post.confirmed / post.audience) * 100) : 0;
		issues.push({
			id: `ack-low-${post.id}-${post.confirmed}`,
			severity: 'warn',
			title: `Only ${pct}% have confirmed “${post.title}”`,
			detail: `${post.audience - post.confirmed} of ${post.audience} people still haven't confirmed after 3 days. You can email them a reminder.`,
			tab: 'chat',
			href: '/chat?c=announcements',
			cta: 'See who'
		});
	}

	if (facts.staleTemporaryPasswords > 0) {
		issues.push({
			id: `temp-pw-${facts.staleTemporaryPasswords}`,
			severity: 'info',
			title: `${plural(facts.staleTemporaryPasswords, 'person has', 'people have')} never signed in`,
			detail: 'They are still on the temporary password issued over two weeks ago. Their credentials may not have reached them.',
			tab: 'people',
			href: '/admin/people',
			cta: 'Open roster'
		});
	}

	if (can('policies.publish')) {
		if (facts.activeLeaveTypes === 0) {
			issues.push({
				id: 'policy-no-leave-types',
				severity: 'bad',
				title: 'No leave policy is published',
				detail: 'Nobody has a leave balance until the leave types are published from the policy document.',
				tab: 'policies',
				href: '/admin/policies',
				cta: 'Publish policy',
				superAdminOnly: true
			});
		}
		if (!facts.publishedCalendarYears.includes(year)) {
			issues.push({
				id: `calendar-missing-${year}`,
				severity: 'bad',
				title: `No holiday calendar is published for ${year}`,
				detail: 'Employees see no holidays this year, and leave that spans one is counted in full.',
				tab: 'policies',
				href: '/admin/policies',
				cta: 'Publish calendar',
				superAdminOnly: true
			});
		} else if (month >= 9 && !facts.publishedCalendarYears.includes(year + 1)) {
			issues.push({
				id: `calendar-missing-${year + 1}`,
				severity: 'warn',
				title: `The ${year + 1} holiday calendar is not published`,
				detail: `Employees cannot plan leave past 31 December until it is.`,
				tab: 'policies',
				href: '/admin/policies',
				cta: 'Publish calendar',
				superAdminOnly: true
			});
		}
	}

	if (month === 11 && !facts.hrSetBalancesByYear[year + 1]) {
		issues.push({
			id: `balances-carry-${year + 1}`,
			severity: 'info',
			title: `No carry-forward balances are uploaded for ${year + 1}`,
			detail: 'Upload the HRone year-end sheet so opening balances are right on 1 January.',
			tab: 'balances',
			href: '/admin/leave-balances',
			cta: 'Upload balances'
		});
	}

	const rank: Record<Severity, number> = { bad: 0, warn: 1, info: 2 };
	return issues.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/** The worst open severity per tab, for the dot on each tab. */
export function tabSeverities(issues: AdminIssue[]): Partial<Record<AdminTabId, Severity>> {
	const out: Partial<Record<AdminTabId, Severity>> = {};
	const rank: Record<Severity, number> = { bad: 0, warn: 1, info: 2 };
	for (const issue of issues) {
		if (issue.tab === 'leave' || issue.tab === 'chat') continue;
		const current = out[issue.tab];
		if (!current || rank[issue.severity] < rank[current]) out[issue.tab] = issue.severity;
	}
	return out;
}

/**
 * The numbers each section opens with. Only sections whose own page does not
 * already lead with figures get one.
 */
export function adminStrips(facts: AdminFacts, now: Date, caps: readonly string[] = []): Partial<Record<AdminTabId, StripItem[]>> {
	const { year, month } = istYearMonth(now);
	const importDays = daysSince(facts.lastAttendanceImportAt, now);
	const importTone = importDays === null ? 'muted' : importDays >= 3 ? 'bad' : importDays >= 2 ? 'warn' : 'ok';

	const importItem: StripItem = {
		value: importDays === null ? '—' : importDays === 0 ? 'Today' : plural(importDays, 'day'),
		label: importDays === null || importDays === 0 ? 'Last attendance import' : 'Since the last attendance import',
		detail:
			importDays === null
				? 'Nothing imported yet'
				: importDays >= 2
					? 'Expected daily from the devices'
					: `On ${shortDate(facts.lastAttendanceImportAt!)}`,
		tone: importTone
	};

	const manual = facts.lastManualUpload;
	const matchRate = manual && manual.rowCount > 0 ? Math.round((manual.matched / manual.rowCount) * 100) : null;

	const thisYearCalendar = facts.publishedCalendarYears.includes(year);
	const nextYearCalendar = facts.publishedCalendarYears.includes(year + 1);

	return {
		overview: [
			{ value: String(facts.activePeople), label: 'Active people' },
			{
				value: facts.activePeople ? `${Math.round((facts.chat.activePeople / facts.activePeople) * 100)}%` : '—',
				label: 'Used Champ Chat this week',
				detail: `${facts.chat.messages} messages · ${facts.chat.openDeskQuestions} open Ask HR ${facts.chat.openDeskQuestions === 1 ? 'question' : 'questions'}`,
				tone: facts.chat.openDeskQuestions > 0 ? 'warn' : 'muted'
			},
			importItem,
			{
				value: String(facts.pendingLeave),
				label: 'Leave requests pending',
				detail: facts.pendingLeaveOld > 0 ? `${facts.pendingLeaveOld} older than 3 days` : 'None waiting long',
				tone: facts.pendingLeaveOld > 0 ? 'warn' : 'ok'
			},
			{
				value: String(facts.activeLeaveTypes),
				label: 'Leave types published',
				tone: facts.activeLeaveTypes === 0 ? 'bad' : undefined,
				detail: facts.activeLeaveTypes === 0 && caps.includes('policies.publish') ? 'Publish the leave policy' : undefined
			}
		],
		biometric: [
			importItem,
			{
				value: matchRate === null ? '—' : `${matchRate}%`,
				label: 'Rows matched, last manual upload',
				detail: manual ? `${plural(manual.unmatched, 'unmatched code')} · ${shortDate(manual.at)}` : 'No manual uploads yet',
				tone: manual && manual.unmatched > 0 ? 'warn' : manual ? 'ok' : 'muted'
			}
		],
		balances: [
			{ value: String(year), label: 'Current leave year', detail: 'Earned leave accrues monthly', tone: 'muted' },
			{
				value: String(facts.hrSetBalancesByYear[year] ?? 0),
				label: `People with an HR-set balance in ${year}`,
				detail: 'Accrual continues on top',
				tone: 'muted'
			},
			{
				value: String(facts.hrSetBalancesByYear[year + 1] ?? 0),
				label: `Carry-forward uploads for ${year + 1}`,
				detail: month >= 10 ? 'Due before 1 January' : undefined,
				tone: month >= 10 && !facts.hrSetBalancesByYear[year + 1] ? 'warn' : 'muted'
			}
		],
		policies: [
			{
				value: thisYearCalendar ? 'Live' : 'Missing',
				label: `${year} holiday calendar`,
				tone: thisYearCalendar ? 'ok' : 'bad'
			},
			{
				value: nextYearCalendar ? 'Live' : 'Not yet',
				label: `${year + 1} holiday calendar`,
				tone: nextYearCalendar ? 'ok' : month >= 9 ? 'warn' : 'muted'
			},
			{
				value: String(facts.activeLeaveTypes),
				label: 'Leave types published',
				tone: facts.activeLeaveTypes === 0 ? 'bad' : 'muted'
			}
		]
	};
}

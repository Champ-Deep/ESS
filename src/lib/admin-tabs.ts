import type { CapabilityKey } from './capabilities';

/**
 * Every Admin Controls section, in the order the tab bar shows them.
 *
 * This list is the one place a section is declared: the tab bar, the Ctrl+K
 * jump list and the privilege gate all read it, so a new admin page is one
 * entry here rather than a new sidebar row plus a card plus a redirect check.
 *
 * A tab shows for anyone holding any of its `caps` (src/lib/capabilities.ts),
 * which is how a named role such as IT Support sees exactly its own tabs.
 *
 * `group` separates the tab bar into how often each section is used: weekly
 * work, setup, and the rare Super Admin tools. It is ordering, not a rule.
 */

export type AdminTabId =
	| 'overview'
	| 'analytics'
	| 'people'
	| 'alumni'
	| 'engagement'
	| 'it'
	| 'biometric'
	| 'balances'
	| 'policies'
	| 'org'
	| 'access'
	| 'support'
	| 'chat'
	| 'zoom'
	| 'cleanup'
	| 'tweaks';

export type AdminTab = {
	id: AdminTabId;
	href: string;
	label: string;
	/** The serif line the page opens with. */
	heading: string;
	/** One line under the page title, in place of each page's own header. */
	blurb: string;
	/** Which mockup category the tab sits in: People, Attendance, Leave, Policies, Access, System. */
	category: 'People' | 'Attendance' | 'Leave' | 'Policies' | 'Access' | 'System';
	group: 0 | 1 | 2 | 3;
	/** Any one of these opens the tab. Empty = anyone who can open Admin Controls. */
	caps: CapabilityKey[];
};

export const ADMIN_TABS: AdminTab[] = [
	{
		id: 'overview',
		href: '/admin',
		label: 'Overview',
		heading: 'A clear view of your operations.',
		category: 'People',
		blurb: 'What needs your attention across the portal, worked out from live data.',
		group: 0,
		caps: []
	},
	{
		id: 'analytics',
		href: '/admin/analytics',
		label: 'HR analytics',
		heading: 'Your workforce, at a glance.',
		category: 'People',
		blurb: 'Headcount, hiring and exits, diversity, absence, engagement, meetings and tasks — from live data.',
		group: 0,
		caps: ['people.analytics']
	},
	{
		id: 'people',
		href: '/admin/people',
		label: 'People',
		heading: 'Manage every employee with care.',
		category: 'People',
		blurb: 'Logins, bulk imports, week-off rosters and password activity.',
		group: 1,
		caps: ['people.directory', 'people.create_login', 'people.send_logins', 'people.bulk_import', 'people.reset_password', 'people.password_activity']
	},
	{
		id: 'alumni',
		href: '/admin/alumni',
		label: 'Alumni',
		heading: 'Everyone who has been part of the story.',
		category: 'People',
		blurb: 'Upload the left-employee tracker, keep every former employee on record, and close the logins of people who have left.',
		group: 1,
		caps: ['people.alumni']
	},
	{
		id: 'engagement',
		href: '/admin/engagement',
		label: 'Engagement studio',
		heading: 'Moments worth celebrating.',
		category: 'People',
		blurb: 'Birthday and anniversary templates the portal shows on the day, short reels on everyone’s Home page, and how people engage.',
		group: 1,
		caps: ['engagement.studio']
	},
	{
		id: 'it',
		href: '/admin/it',
		label: 'IT dashboard',
		heading: 'Every login, healthy.',
		category: 'System',
		blurb: 'Who has never signed in, stale temporary passwords, resets, the login-email queue, the biometric sync and the Ask IT desk.',
		group: 1,
		caps: ['it.dashboard']
	},
	{
		id: 'biometric',
		href: '/admin/biometric',
		label: 'Attendance',
		heading: 'Turn attendance data into clarity.',
		category: 'Attendance',
		blurb: 'Load the device report for days the scheduled feed never sent.',
		group: 1,
		caps: ['attendance.biometric_upload']
	},
	{
		id: 'balances',
		href: '/admin/leave-balances',
		label: 'Leave balances',
		heading: 'Balances you can account for.',
		category: 'Leave',
		blurb: 'Set opening balances from a spreadsheet, such as the HRone carry-forward.',
		group: 1,
		caps: ['leave.set_balances']
	},
	{
		id: 'policies',
		href: '/admin/policies',
		label: 'Policies',
		heading: 'Publish with confidence.',
		category: 'Policies',
		blurb: 'Publish the holiday calendar and leave policy from the source document.',
		group: 2,
		caps: ['policies.publish']
	},
	{
		id: 'org',
		href: '/admin/org-chart',
		label: 'Org chart',
		heading: 'See how your people connect.',
		category: 'People',
		blurb: 'Who reports to whom, from the live roster.',
		group: 2,
		caps: ['org.view']
	},
	{
		id: 'access',
		href: '/admin/access-control',
		label: 'Roles & access',
		heading: 'The right access for every role.',
		category: 'Access',
		blurb: 'Named roles such as IT Support, what each one may do, and who holds them.',
		group: 2,
		caps: ['access.view', 'system.roles']
	},
	{
		id: 'support',
		href: '/admin/support-teams',
		label: 'HR, IT & Engagement',
		heading: 'The right people on every question.',
		category: 'Access',
		blurb: 'Who is in HR, Employee Engagement and IT: they get that team’s controls and answer its desk.',
		group: 2,
		caps: ['access.view', 'system.roles']
	},
	{
		id: 'chat',
		href: '/admin/chat-rules',
		label: 'Chat rules',
		heading: 'Set clear boundaries for conversation.',
		category: 'Access',
		blurb: 'Who employees can message directly, and who can start group chats.',
		group: 2,
		caps: ['chat.manage_rules']
	},
	{
		id: 'zoom',
		href: '/admin/zoom',
		label: 'Zoom',
		heading: 'Bring meetings into your workday.',
		category: 'System',
		blurb: 'Connect Zoom so meeting minutes arrive in Champ Hub, and link Zoom names to logins.',
		group: 2,
		caps: ['system.zoom']
	},
	{
		id: 'cleanup',
		href: '/admin/cleanup',
		label: 'Data cleanup',
		heading: 'Review carefully. Keep what matters.',
		category: 'System',
		blurb: 'Remove seeded and test data. Everything here is permanent.',
		group: 3,
		caps: ['system.cleanup']
	},
	{
		id: 'tweaks',
		href: '/admin/tweaks',
		label: 'Appearance',
		heading: 'Make the workspace feel right.',
		category: 'System',
		blurb: 'Preview design variants in your browser only. Employees are unaffected.',
		group: 3,
		caps: ['system.design_tweaks']
	}
];

/** The tabs a person with these privileges can open. */
export function visibleAdminTabs(caps: readonly string[]): AdminTab[] {
	return ADMIN_TABS.filter((t) => t.caps.length === 0 || t.caps.some((c) => caps.includes(c)));
}

/**
 * The tab a path belongs to. Overview only matches exactly, since every other
 * tab's href also starts with /admin.
 */
export function adminTabForPath(pathname: string): AdminTab | undefined {
	const path = pathname.replace(/\/+$/, '') || '/';
	if (path === '/admin') return ADMIN_TABS[0];
	return ADMIN_TABS.find((t) => t.id !== 'overview' && (path === t.href || path.startsWith(t.href + '/')));
}

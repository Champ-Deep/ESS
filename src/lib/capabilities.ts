/**
 * Privileges — what a login may do, beyond its base role.
 *
 * Every login keeps one base role (Employee, Team Lead, HR Admin, Super Admin).
 * The base role still decides the things that are about *position* rather than
 * permission: who approves whose leave, who counts as HR for the second stage.
 *
 * On top of that, a Super Admin can create named roles ("IT Support",
 * "Operations", …) that bundle privileges from this catalogue, and give one to
 * any login. A person's effective privileges are their base role's defaults
 * plus their named role's list; a Super Admin has everything.
 *
 * The defaults below reproduce exactly what each base role could do before
 * named roles existed, so introducing them changes nobody's access by itself.
 */

import type { Role } from './server/auth';

export type CapabilityGroup = 'People' | 'Attendance & leave' | 'Payroll' | 'Policies' | 'Communication' | 'Tasks & meetings' | 'Champ' | 'System';

export type Capability = {
	key: string;
	label: string;
	group: CapabilityGroup;
	description: string;
	/** False for the few powers only a Super Admin may hold. */
	grantable: boolean;
};

export const CAPABILITIES = [
	// --- People
	{ key: 'people.directory', label: 'See everyone in People', group: 'People', description: 'Open the People tab and see the whole roster, not just their own team.', grantable: true },
	{ key: 'people.create_login', label: 'Create logins', group: 'People', description: 'Create a login for one person, with a temporary password.', grantable: true },
	{ key: 'people.bulk_import', label: 'Bulk import logins', group: 'People', description: 'Upload the HR spreadsheet and create logins in bulk.', grantable: true },
	{ key: 'people.edit_settings', label: 'Change reporting lines and shifts', group: 'People', description: 'Set reports to, concerned HR, shift group, office timings and week off.', grantable: true },
	{ key: 'people.send_logins', label: 'Approve login emails', group: 'People', description: 'Approve, hold or cancel the emails that send new logins their username and temporary password, and set how often they go out.', grantable: true },
	{ key: 'people.reset_password', label: 'Reset passwords', group: 'People', description: 'Issue a new temporary password for anyone.', grantable: true },
	{ key: 'people.password_activity', label: 'See password activity', group: 'People', description: 'Who changed or reset whose password, and when.', grantable: true },
	{ key: 'people.analytics', label: 'See HR analytics', group: 'People', description: 'Open HR analytics: headcount, hires and exits, diversity, age, absence, attrition, engagement, meetings and tasks across the roster.', grantable: true },
	{ key: 'people.alumni', label: 'Alumni tracker', group: 'People', description: 'Upload the left-employee tracker, see every former employee, and close the logins of people who have left.', grantable: true },
	{ key: 'people.employee_code', label: 'Set employee codes', group: 'People', description: 'Change the employee code that links biometric punches.', grantable: true },
	{ key: 'people.assign_roles', label: 'Give people roles', group: 'People', description: 'Change base roles and give named roles. Super Admin only.', grantable: false },
	{ key: 'people.delete', label: 'Delete people', group: 'People', description: 'Permanently delete a login and its records. Super Admin only.', grantable: false },
	// --- Attendance & leave
	{ key: 'attendance.biometric_upload', label: 'Upload biometric reports', group: 'Attendance & leave', description: "Load the device's report for days the scheduled feed missed.", grantable: true },
	{ key: 'attendance.device_sync', label: 'Run the device sync', group: 'Attendance & leave', description: 'Trigger a ProHance attendance sync by hand and see its status.', grantable: true },
	{ key: 'leave.set_balances', label: 'Set leave balances', group: 'Attendance & leave', description: 'Upload opening balances such as the HRone carry-forward.', grantable: true },
	{ key: 'leave.week_off_rosters', label: 'Author week-off rosters', group: 'Attendance & leave', description: 'Create, publish and delete week-off rosters.', grantable: true },
	// --- Payroll
	{ key: 'payroll.view', label: 'See payroll', group: 'Payroll', description: 'Open Payroll: the month-wise attendance tracker and the salary report, and download them as CSV or Excel.', grantable: true },
	{ key: 'payroll.manage', label: 'Edit payroll', group: 'Payroll', description: 'Stop or hold a salary, set last working days, add HR comments and correct opening leave balances for a payroll month.', grantable: true },
	// --- Policies
	{ key: 'policies.publish', label: 'Publish policies and holidays', group: 'Policies', description: 'Publish the holiday calendar and leave policy, and change leave types.', grantable: true },
	{ key: 'org.view', label: 'See the org chart', group: 'Policies', description: 'The reporting hierarchy for the whole company.', grantable: true },
	{ key: 'access.view', label: 'See roles and access', group: 'Policies', description: 'Read who holds which role and privilege.', grantable: true },
	// --- Communication
	{ key: 'announcements.post', label: 'Post announcements', group: 'Communication', description: 'Post in #announcements and see who has read each post.', grantable: true },
	{ key: 'chat.dm_anyone', label: 'Message anyone', group: 'Communication', description: 'Start a direct message with anyone. Without it, employees message their team, manager and HR.', grantable: true },
	{ key: 'chat.create_groups', label: 'Start group chats', group: 'Communication', description: 'Start a group chat. Needed only when Chat rules limit groups to people who hold this.', grantable: true },
	{ key: 'chat.manage_rules', label: 'Set the chat rules', group: 'Communication', description: 'Decide who employees can message and who can start group chats.', grantable: true },
	{ key: 'chat.create_channels', label: 'Create channels anywhere', group: 'Communication', description: 'Create channels for any group of people. Team Leads can always create them for their own team.', grantable: true },
	{ key: 'chat.mention_all', label: 'Use @channel and @here', group: 'Communication', description: 'Notify a whole channel at once, in any channel.', grantable: true },
	{ key: 'chat.hr_desk', label: 'Answer Ask HR', group: 'Communication', description: 'See and answer questions people raise with HR, and mark them resolved.', grantable: true },
	{ key: 'chat.it_desk', label: 'Answer Ask IT', group: 'Communication', description: 'See and answer questions people raise with IT, and mark them resolved.', grantable: true },
	{ key: 'chat.engagement_desk', label: 'Answer Ask Engagement', group: 'Communication', description: 'See and answer questions people raise with Employee Engagement, and mark them resolved.', grantable: true },
	{ key: 'chat.moderate', label: 'Moderate chat', group: 'Communication', description: 'Review reported messages and hide them for everyone.', grantable: true },
	{ key: 'engagement.studio', label: 'Engagement studio', group: 'Communication', description: 'Set the birthday and anniversary templates and videos the portal shows on the day, and publish short reels on everyone’s Home page.', grantable: true },
	{ key: 'chat.export', label: 'Export a conversation', group: 'Communication', description: 'Export one conversation for a formal complaint. Recorded. Super Admin only.', grantable: false },
	// --- Tasks & meetings
	{ key: 'tasks.view_all', label: "See every team's tasks", group: 'Tasks & meetings', description: 'Open any team board in Champ Hub, not just their own reports.', grantable: true },
	{ key: 'tasks.assign_anyone', label: 'Give tasks without approval', group: 'Tasks & meetings', description: "Tasks they create start straight away. Without it, a task waits for the assignee's lead to approve it unless they are that lead.", grantable: true },
	{ key: 'system.zoom', label: 'Connect Zoom', group: 'Tasks & meetings', description: 'Set up the Zoom connection and link Zoom users to logins. Super Admin only.', grantable: false },
	// --- Champ
	{ key: 'champ.reports', label: 'Roster reports in Champ', group: 'Champ', description: 'Counts, lists and reports across the whole roster.', grantable: true },
	{ key: 'champ.audit', label: 'Audit trail in Champ', group: 'Champ', description: 'Search who changed what, and when.', grantable: true },
	// --- System
	{ key: 'it.dashboard', label: 'IT dashboard', group: 'System', description: 'See login health: who has never signed in, stale temporary passwords, resets, the login-email queue, the Ask IT desk and the biometric sync.', grantable: true },
	{ key: 'system.cleanup', label: 'Data cleanup', group: 'System', description: 'Delete seeded and test data. Super Admin only.', grantable: false },
	{ key: 'system.design_tweaks', label: 'Design tweaks', group: 'System', description: 'Preview design variants in your browser.', grantable: true },
	{ key: 'system.roles', label: 'Manage roles', group: 'System', description: 'Create, change and delete named roles. Super Admin only.', grantable: false }
] as const satisfies readonly Capability[];

export type CapabilityKey = (typeof CAPABILITIES)[number]['key'];

export const CAPABILITY_KEYS = CAPABILITIES.map((c) => c.key) as CapabilityKey[];

export const GRANTABLE_KEYS = CAPABILITIES.filter((c) => c.grantable).map((c) => c.key) as CapabilityKey[];

/** What each base role has before any named role is added. */
const DEFAULTS: Record<Role, CapabilityKey[]> = {
	employee: [],
	team_lead: ['chat.dm_anyone', 'chat.create_groups'],
	admin: [
		'people.directory',
		'people.create_login',
		'people.send_logins',
		'people.edit_settings',
		'people.reset_password',
		'people.employee_code',
		'people.analytics',
		'people.alumni',
		'attendance.biometric_upload',
		'leave.set_balances',
		'org.view',
		'access.view',
		'announcements.post',
		'chat.dm_anyone',
		'chat.create_groups',
		'chat.manage_rules',
		'chat.create_channels',
		'chat.mention_all',
		'chat.hr_desk',
		'chat.moderate',
		'champ.reports',
		'champ.audit',
		'tasks.view_all'
	],
	super_admin: CAPABILITY_KEYS
};

export function defaultCapabilities(role: Role): CapabilityKey[] {
	return DEFAULTS[role] ?? [];
}

/**
 * Base role defaults plus a named role's privileges. Unknown keys (a privilege
 * removed from the catalogue since the role was saved) are dropped, and a
 * named role can never add a Super Admin-only power.
 */
export function effectiveCapabilities(role: Role, extra: readonly string[] = []): CapabilityKey[] {
	if (role === 'super_admin') return CAPABILITY_KEYS;
	const set = new Set<CapabilityKey>(defaultCapabilities(role));
	for (const key of extra) if ((GRANTABLE_KEYS as string[]).includes(key)) set.add(key as CapabilityKey);
	return CAPABILITY_KEYS.filter((k) => set.has(k));
}

/** The privileges that open an Admin Controls tab; any one lets you in. */
export const ADMIN_AREA_KEYS: CapabilityKey[] = [
	'people.directory',
	'people.create_login',
	'people.send_logins',
	'people.bulk_import',
	'people.reset_password',
	'people.password_activity',
	'people.analytics',
	'people.alumni',
	'attendance.biometric_upload',
	'attendance.device_sync',
	'leave.set_balances',
	'policies.publish',
	'org.view',
	'access.view',
	'chat.manage_rules',
	'system.zoom',
	'system.cleanup',
	'system.design_tweaks',
	'system.roles',
	'engagement.studio',
	'it.dashboard'
];

export function canOpenAdmin(caps: readonly string[]): boolean {
	return ADMIN_AREA_KEYS.some((k) => caps.includes(k));
}

/**
 * The three support teams — HR, Employee Engagement and IT. A Super Admin puts
 * any number of people in each (Admin Controls › Roles & access); membership
 * adds the team's privileges on top of the person's base and named role, and
 * makes them a responder on that team's desk ("Ask HR", "Ask IT", "Ask
 * Engagement"), where everyone else raises questions for it.
 *
 * The bundles are fixed here so every member of a team can do the same; give
 * one person more with a named role.
 */
export type SupportTeamKey = 'hr' | 'engagement' | 'it';

export type SupportTeam = {
	key: SupportTeamKey;
	name: string;
	/** What the desk is called for the person asking. */
	deskName: string;
	/** The privilege that lets someone answer and resolve this desk. */
	deskCap: CapabilityKey;
	description: string;
	/** What a member asks this desk about, shown to the person picking a desk. */
	askAbout: string;
	capabilities: CapabilityKey[];
};

/**
 * Admin Controls › People is not part of any team's work: these stay with
 * HR Admins and Super Admins (and any named role given them), never a team.
 */
export const PEOPLE_TAB_KEYS: CapabilityKey[] = [
	'people.directory',
	'people.create_login',
	'people.send_logins',
	'people.bulk_import',
	'people.reset_password',
	'people.password_activity'
];
const withoutPeople = (keys: CapabilityKey[]) => keys.filter((k) => !PEOPLE_TAB_KEYS.includes(k));

export const SUPPORT_TEAMS: SupportTeam[] = [
	{
		key: 'hr',
		name: 'HR',
		deskName: 'Ask HR',
		deskCap: 'chat.hr_desk',
		description: 'Runs people, leave, attendance and policies, and answers Ask HR.',
		askAbout: 'Leave, attendance, payslips, policies, documents',
		// Not the Policies, Org chart, Roles & access or HR, IT & Engagement tabs:
		// those stay with Super Admins.
		capabilities: withoutPeople([...DEFAULTS.admin.filter((k) => !['chat.hr_desk', 'org.view', 'access.view'].includes(k)), 'chat.hr_desk', 'leave.week_off_rosters'])
	},
	{
		key: 'engagement',
		name: 'Employee Engagement',
		deskName: 'Ask Engagement',
		deskCap: 'chat.engagement_desk',
		description: 'Runs events, announcements and channels, follows engagement in HR analytics, and answers Ask Engagement.',
		askAbout: 'Events, celebrations, clubs, suggestions, feedback',
		capabilities: [
			'people.analytics',
			'org.view',
			'announcements.post',
			'chat.dm_anyone',
			'chat.create_groups',
			'chat.create_channels',
			'chat.mention_all',
			'chat.engagement_desk',
			'engagement.studio'
		]
	},
	{
		key: 'it',
		name: 'IT',
		deskName: 'Ask IT',
		deskCap: 'chat.it_desk',
		description: 'Watches login health and the biometric devices, and answers Ask IT.',
		askAbout: 'Logins, passwords, laptops, email, access, the biometric device',
		capabilities: [
			'people.employee_code',
			'attendance.biometric_upload',
			'attendance.device_sync',
			'chat.dm_anyone',
			'chat.create_groups',
			'chat.it_desk',
			'it.dashboard'
		]
	}
];

export const SUPPORT_TEAM_KEYS = SUPPORT_TEAMS.map((t) => t.key);

export function supportTeam(key: string | null | undefined): SupportTeam {
	return SUPPORT_TEAMS.find((t) => t.key === key) ?? SUPPORT_TEAMS[0];
}

/** Every privilege a set of team memberships brings. */
export function supportTeamCapabilities(keys: readonly string[]): CapabilityKey[] {
	return [...new Set(SUPPORT_TEAMS.filter((t) => keys.includes(t.key)).flatMap((t) => t.capabilities))];
}

/** Ready-made starting points for the roles people ask for most. */
export const ROLE_PRESETS: { name: string; description: string; baseRole: Exclude<Role, 'super_admin'>; capabilities: CapabilityKey[] }[] = [
	{
		name: 'Finance',
		description: 'Runs payroll: the attendance tracker, the salary report and its downloads.',
		baseRole: 'employee',
		capabilities: ['payroll.view', 'payroll.manage', 'people.directory']
	},
	{
		name: 'IT Support',
		description: 'Looks after logins, passwords and the biometric devices.',
		baseRole: 'employee',
		capabilities: [
			'people.directory',
			'people.create_login',
			'people.reset_password',
			'people.password_activity',
			'people.employee_code',
			'attendance.biometric_upload',
			'attendance.device_sync',
			'chat.dm_anyone'
		]
	},
	{
		name: 'Operations',
		description: 'Runs day-to-day operations across teams: rosters, attendance and channels.',
		baseRole: 'employee',
		capabilities: [
			'people.directory',
			'org.view',
			'attendance.biometric_upload',
			'leave.week_off_rosters',
			'chat.dm_anyone',
			'chat.create_channels',
			'chat.mention_all'
		]
	}
];

export const BASE_ROLE_LABEL: Record<Role, string> = {
	employee: 'Employee',
	team_lead: 'Team Lead',
	admin: 'HR Admin',
	super_admin: 'Super Admin'
};

/**
 * The guided tour: one walk through the portal, page by page, pointing at
 * the parts people use. ProductTour (src/lib/components/tour) plays it.
 *
 * Targets are `[data-tour="…"]` anchors placed on the elements themselves
 * (PageHeader carries page / page-tabs / page-actions for every page). A
 * step whose target isn't on screen is shown in the middle instead, or
 * skipped when it is `optional`, so a missing anchor never stalls the tour.
 */

/** What this login can open, from the app layout's data. */
export interface TourAccess {
	canAdmin: boolean;
	canTeam: boolean;
	canPayroll: boolean;
	/** May create logins (shows Add employee). */
	canCreateLogin: boolean;
}

export type TourNeed = keyof TourAccess;

export interface TourStep {
	id: string;
	/** Short section name shown above the title ("Leave", "Admin"). */
	chapter: string;
	title: string;
	body: string;
	/** Page to be on first (a pathname, optionally with a query). */
	route?: string;
	/** `data-tour` value of the element to point at; none = centred card. */
	target?: string;
	/** Where the card sits relative to the target; default picks the roomiest side. */
	placement?: 'top' | 'bottom' | 'left' | 'right';
	/** Skip quietly when the target isn't there (an empty state, a narrow screen). */
	optional?: boolean;
	/** Only for people who can open this. */
	needs?: TourNeed;
	/** Bring the floating dock out while this step shows. */
	revealDock?: boolean;
}

export const TOUR_STEPS: TourStep[] = [
	{
		id: 'welcome',
		chapter: 'Welcome',
		title: 'Welcome to Champ HR',
		body: 'A two-minute walk through the portal: your day, leave, attendance, Champ Hub, your team and the HR tools. Use the arrow keys or the buttons below, and Esc to leave at any time.',
		route: '/dashboard'
	},
	{
		id: 'dock',
		chapter: 'Getting around',
		title: 'Every section, one click away',
		body: 'The dock holds every part of the portal. It tucks away to give pages room: move your pointer to the left edge to bring it back, or pin it open from your avatar menu.',
		route: '/dashboard',
		target: 'dock',
		placement: 'right',
		revealDock: true,
		optional: true
	},

	// ---------------------------------------------------------------- Today
	{
		id: 'today-figures',
		chapter: 'Today',
		title: 'Your numbers at a glance',
		body: 'Leave balance, attendance this month and requests still pending. Approvers also see what is waiting for them. Click any figure to open the detail.',
		route: '/dashboard',
		target: 'today-figures',
		optional: true
	},
	{
		id: 'apply-leave',
		chapter: 'Today',
		title: 'Apply for leave in seconds',
		body: 'Pick the dates and the leave type. The portal checks your balance and sends the request to your reporting manager and HR, and you can follow its progress from Leave.',
		route: '/dashboard',
		target: 'apply-leave'
	},
	{
		id: 'planner',
		chapter: 'Today',
		title: 'Who is away, at a glance',
		body: 'The absence planner shows the month for everyone you work with: approved and pending leave, week offs and holidays. Drag across your own row to plan time off.',
		route: '/dashboard',
		target: 'planner'
	},
	{
		id: 'today-cards',
		chapter: 'Today',
		title: 'Your day, in four cards',
		body: 'Upcoming meetings, events and holidays; your attendance heatmap; new joiners and their onboarding; and Champ, the assistant that answers from your own HR records.',
		route: '/dashboard',
		target: 'today-cards',
		optional: true
	},
	{
		id: 'home-reel',
		chapter: 'Today',
		title: 'Live on Home',
		body: 'On every page, bottom left: birthdays, work anniversaries and short reels from the Engagement team play here, muted. Tap to watch with sound; shrink it to a bubble if you prefer.',
		route: '/dashboard',
		target: 'home-reel',
		placement: 'right',
		optional: true
	},
	{
		id: 'search',
		chapter: 'Getting around',
		title: 'Search, or ask Champ',
		body: 'Find a person, a chat, a task or a meeting from anywhere, or put a question to Champ.',
		route: '/dashboard',
		target: 'search',
		optional: true
	},
	{
		id: 'add-employee',
		chapter: 'Getting around',
		title: 'Add a new joiner',
		body: 'Create a login from any page. The new person gets their sign-in details once you send them, and people with no work email can be added as blue-collar staff.',
		route: '/dashboard',
		target: 'add-employee',
		needs: 'canCreateLogin',
		optional: true
	},
	{
		id: 'bell',
		chapter: 'Getting around',
		title: 'Announcements',
		body: 'Company announcements arrive here. A dot means something unread; urgent ones show in red and can ask you to acknowledge them.',
		route: '/dashboard',
		target: 'bell',
		optional: true
	},

	// ---------------------------------------------------------------- Leave
	{
		id: 'leave',
		chapter: 'Leave',
		title: 'Leave, start to finish',
		body: 'My leave shows every balance and request with its progress. The calendar shows who is off, and managers approve or reject from Approvals with the balance and dates in front of them.',
		route: '/leave',
		target: 'page-tabs'
	},

	// ----------------------------------------------------------- Attendance
	{
		id: 'attendance',
		chapter: 'Attendance',
		title: 'Attendance, made clear',
		body: 'Check-ins come straight from the biometric devices. Each day of the pay cycle shows present, absent, leave, week off or holiday; pick a day to see its punches.',
		route: '/attendance',
		target: 'attendance-calendar'
	},
	{
		id: 'attendance-side',
		chapter: 'Attendance',
		title: 'Missed a punch? Raise a correction',
		body: 'Today’s check-in and check-out, comp-off credits for extra days worked, and corrections for missed punches. Each correction goes to your manager for approval.',
		route: '/attendance',
		target: 'attendance-side',
		placement: 'left',
		optional: true
	},

	// ------------------------------------------------------------ Champ Hub
	{
		id: 'hub',
		chapter: 'Champ Hub',
		title: 'Where the work happens',
		body: 'Today gathers what needs you. Chats has direct messages, channels and announcements; Tasks are team boards; Meetings schedule calls and turn the minutes into tasks.',
		route: '/hub',
		target: 'page-tabs'
	},

	// ------------------------------------------------------------- Policies
	{
		id: 'policies',
		chapter: 'Policies',
		title: 'Answers for your workday',
		body: 'The holiday calendar for your shift, the leave rules that apply to you and the workplace policies, always the version HR last published.',
		route: '/policies',
		target: 'page-tabs'
	},

	// ----------------------------------------------------------------- Team
	{
		id: 'team',
		chapter: 'Team',
		title: 'Know your people',
		body: 'Everyone in your team with their reporting line, shift, week off, leave left and whether they are in today. Open someone to see the detail, or switch to Week-off schedules to plan the week.',
		route: '/team',
		target: 'team-directory',
		needs: 'canTeam'
	},

	// -------------------------------------------------------------- Payroll
	{
		id: 'payroll',
		chapter: 'Payroll',
		title: 'Payroll inputs for each cycle',
		body: 'For each cycle (26th to 25th): who turned up, loss-of-pay days, stopped salaries and HR comments. The A/B check compares HR’s own sheet with the portal’s figures before you preview and download.',
		route: '/payroll',
		target: 'page-tabs',
		needs: 'canPayroll'
	},

	// ---------------------------------------------------------------- Admin
	{
		id: 'admin',
		chapter: 'Admin Controls',
		title: 'Everything HR runs, in one place',
		body: 'Analytics, people, attendance, leave balances, policies, the org chart, roles and access. Press Ctrl K on any admin page to jump straight to a section or task.',
		route: '/admin',
		target: 'page-tabs',
		needs: 'canAdmin'
	},
	{
		id: 'admin-attention',
		chapter: 'Admin Controls',
		title: 'What needs attention',
		body: 'Problems the portal spots for you, such as people with no manager or a holiday calendar that is not published yet. Each one opens the place to fix it.',
		route: '/admin',
		target: 'admin-attention',
		needs: 'canAdmin',
		optional: true
	},
	{
		id: 'admin-people',
		chapter: 'Admin Controls',
		title: 'People and logins',
		body: 'The full directory, week-off rosters and bulk import from the HR spreadsheet. Login delivery tracks who has received their sign-in details and who still has to sign in.',
		route: '/admin/people',
		target: 'people-tabs',
		needs: 'canAdmin'
	},
	{
		id: 'admin-policies',
		chapter: 'Admin Controls',
		title: 'Publish holidays and leave rules',
		body: 'Upload a holiday list or a leave policy and the portal drafts the calendar or the leave types for you to check. Nothing reaches employees until you publish it.',
		route: '/admin/policies',
		target: 'policy-kinds',
		needs: 'canAdmin'
	},
	{
		id: 'admin-org',
		chapter: 'Admin Controls',
		title: 'The org chart, kept honest',
		body: 'Reporting lines drawn live from the directory, with checks for anyone missing a manager. Leave approvals follow the same lines.',
		route: '/admin/org-chart',
		target: 'org-chart',
		needs: 'canAdmin',
		optional: true
	},
	{
		id: 'admin-access',
		chapter: 'Admin Controls',
		title: 'Roles and access',
		body: 'Decide who can see and do what: built-in and custom roles, a permissions matrix and teams.',
		route: '/admin/access-control',
		target: 'page-tabs',
		needs: 'canAdmin'
	},

	// -------------------------------------------------------------- You
	{
		id: 'profile',
		chapter: 'Your profile',
		title: 'Your details, in one place',
		body: 'Personal, employment, bank and ID, family and education details. Sensitive numbers stay masked.',
		route: '/profile',
		target: 'profile-tabs',
		optional: true
	},
	{
		id: 'account',
		chapter: 'Your profile',
		title: 'Make it yours',
		body: 'Your avatar menu holds light and dark mode, text size and the dock, as well as your password, log out and this tour.',
		route: '/profile',
		target: 'account',
		optional: true
	},
	{
		id: 'help',
		chapter: 'Help',
		title: 'Help is one click away',
		body: 'Help & support, at the foot of the dock, lists your HR contacts and how to reach them.',
		route: '/hr-contacts',
		target: 'page'
	},
	{
		id: 'done',
		chapter: 'All set',
		title: 'You’re all set',
		body: 'That’s the portal. You can take this tour again at any time from your avatar menu.',
		route: '/dashboard'
	}
];

/** The steps this login should see, in order. */
export function stepsFor(access: TourAccess, steps: TourStep[] = TOUR_STEPS): TourStep[] {
	return steps.filter((s) => !s.needs || access[s.needs]);
}

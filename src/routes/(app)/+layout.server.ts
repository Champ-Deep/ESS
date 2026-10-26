import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { getProfilePicture, getUsersWithProfilePicture } from '$lib/server/db/mongo';
import { db } from '$lib/server/db/postgres';
import { users } from '$lib/server/db/schema';
import { and, eq, ne, or, asc, sql } from 'drizzle-orm';
import { loadAdminFacts } from '$lib/server/admin-health';
import { deriveAdminIssues } from '$lib/admin-issues';
import { canOpenAdmin } from '$lib/capabilities';
import { loadBadge } from '$lib/server/announcements';
import { sidebarFor } from '$lib/server/chat/channels';
import { teamPageAccess } from '$lib/server/team-access';
import { notHidden } from '$lib/server/hidden-users';

export const load: LayoutServerLoad = async ({ locals }) => {
	if (!locals.user) {
		throw redirect(303, '/login');
	}
	if (locals.user.mustChangePassword) {
		throw redirect(303, '/change-password');
	}

	const role = locals.user.role;
	const caps = locals.user.capabilities ?? [];
	const isAdmin = canOpenAdmin(caps);

	// The nav rail shows the signed-in user's avatar on every page, so this
	// lives in the layout rather than being re-fetched per route.
	const [picture, adminFacts, announcementBadge, chatSidebar, teamAccess] = await Promise.all([
		getProfilePicture(locals.user.id),
		// The Admin Controls entry carries a count of open problems, so an admin
		// sees one is waiting without opening the section. Only admins pay for
		// the queries; this load does not re-run on client-side navigation.
		isAdmin ? loadAdminFacts() : Promise.resolve(null),
		// Re-read after every action on the Announcements page (invalidateAll),
		// so the badge clears as people read.
		loadBadge(locals.user.id),
		// The Champ Chat badge for the first paint; the live stream keeps it
		// current after that.
		sidebarFor(locals.user).catch(() => ({ badge: 0 })),
		// Whether the Team page is theirs — the same rule the page applies.
		teamPageAccess(locals.user).catch(() => ({ allowed: role !== 'employee', reach: null }))
	]);

	// The top bar's team faces: whoever shares the person's team, or their
	// direct reports when they have no team. Names and pictures only, as the
	// Team page already shows them. Employees see none.
	let teamPeek: { people: { id: string; fullName: string; hasPicture: boolean }[]; total: number } | null = null;
	if (role !== 'employee') {
		const where = and(
			eq(users.isActive, true),
			notHidden,
			ne(users.id, locals.user.id),
			or(locals.user.teamId ? eq(users.teamId, locals.user.teamId) : sql`false`, eq(users.reportsTo, locals.user.id))
		);
		const [rows, [{ n }]] = await Promise.all([
			db.select({ id: users.id, fullName: users.fullName }).from(users).where(where).orderBy(asc(users.fullName)).limit(4),
			db.select({ n: sql<number>`count(*)::int` }).from(users).where(where)
		]);
		const pics = await getUsersWithProfilePicture(rows.map((r) => r.id));
		teamPeek = { people: rows.map((r) => ({ ...r, hasPicture: pics.has(r.id) })), total: n };
	}

	const adminIssueCount = adminFacts
		? deriveAdminIssues(adminFacts, caps, new Date()).filter(
				(i) => i.severity !== 'info'
			).length
		: 0;

	return {
		user: locals.user,
		// Set while someone has this blue-collar worker's portal open.
		actingFor: locals.actingFor ?? null,
		hasProfilePicture: Boolean(picture),
		profilePictureVersion: picture?.updatedAt?.getTime() ?? null,
		adminIssueCount,
		canAdmin: isAdmin,
		canPayroll: caps.includes('payroll.view'),
		canTeam: teamAccess.allowed,
		announcementBadge,
		chatBadge: { count: chatSidebar.badge, urgent: announcementBadge.urgent },
		canUseChamp: true,
		teamPeek,
		// Add employee opens the create-login form wherever this person
		// creates logins; the form's action checks the privilege again.
		addEmployeeHref: caps.includes('people.create_login') ? (isAdmin ? '/admin/people?create=1' : '/team?create=1') : null
	};
};

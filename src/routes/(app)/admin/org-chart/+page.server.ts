import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db/postgres';
import { employeeProfiles, teams, users } from '$lib/server/db/schema';
import { and, eq } from 'drizzle-orm';
import { notHidden } from '$lib/server/hidden-users';
import { buildOrgTree, type OrgPerson } from '$lib/org-chart';
import { gateAdminPage } from '$lib/server/capabilities';

/**
 * The reporting hierarchy, read-only.
 *
 * Role is enforced by (app)/admin/+layout.server.ts.
 *
 * Only active people are charted: a deactivated leaver still carries their old
 * reports_to, and drawing them would show a line manager for someone who has
 * left.
 */
export const load: PageServerLoad = async ({ locals }) => {
	gateAdminPage(locals, ['org.view']);
	const rows = await db
		.select({
			id: users.id,
			fullName: users.fullName,
			role: users.role,
			reportsTo: users.reportsTo,
			teamId: users.teamId,
			employeeCode: employeeProfiles.employeeCode,
			reportsToChief: employeeProfiles.reportsToChief,
			topPosition: employeeProfiles.topPosition,
			teamName: teams.name
		})
		.from(users)
		.leftJoin(employeeProfiles, eq(employeeProfiles.userId, users.id))
		.leftJoin(teams, eq(teams.id, users.teamId))
		.where(and(eq(users.isActive, true), notHidden));

	const teamNameById = new Map(rows.map((r) => [r.id, r.teamName]));

	const people: OrgPerson[] = rows.map((r) => ({
		id: r.id,
		fullName: r.fullName,
		role: r.role,
		reportsTo: r.reportsTo,
		teamId: r.teamId,
		employeeCode: r.employeeCode,
		reportsToChief: !r.reportsTo && Boolean(r.reportsToChief),
		topPosition: r.topPosition
	}));

	const chart = buildOrgTree(people);

	// How much of the roster actually has a manager on file. This is the number
	// the reports_to backfill is meant to move, so it is worth stating plainly
	// rather than leaving people to infer it from a flat chart.
	// Reporting to Chief or Mam is a real line, not a gap in the data.
	const withManager = people.filter((p) => p.reportsTo || p.reportsToChief).length;

	return {
		chart,
		teamNames: Object.fromEntries(teamNameById),
		stats: {
			total: people.length,
			withManager,
			withoutManager: people.length - withManager,
			rootCount: chart.roots.length,
			chiefCount: chart.underChief.length,
			mamCount: chart.underMam.length,
			orphanCount: chart.orphans.length
		}
	};
};

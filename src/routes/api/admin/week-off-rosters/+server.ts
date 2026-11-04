import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireRole } from '$lib/server/rbac';
import { db } from '$lib/server/db/postgres';
import { weekOffRosters, teams } from '$lib/server/db/schema';
import { logActivity } from '$lib/server/db/mongo';
import { eq } from 'drizzle-orm';
import { validateRosterInput } from '$lib/week-off';
import { loadAssignableRosters } from '$lib/server/week-off';
import { requireCap } from '$lib/server/capabilities';

/** Rosters this actor may see — everything for a Super Admin, published + own-team for a lead. */
export const GET: RequestHandler = async (event) => {
	const actor = requireRole(event, ['super_admin', 'admin', 'team_lead']);
	const rosters = await loadAssignableRosters(actor);
	return json({ rosters });
};

/**
 * Creates a saved roster. Super Admin only — a team lead applies rosters but
 * does not author them, so there is one place the patterns are defined.
 */
export const POST: RequestHandler = async (event) => {
	const actor = requireCap(event, 'leave.week_off_rosters');
	const body = await event.request.json();

	const invalid = validateRosterInput(body);
	if (invalid) throw error(400, invalid);

	const teamId = typeof body.teamId === 'string' && body.teamId ? body.teamId : null;
	if (teamId) {
		const [team] = await db.select({ id: teams.id }).from(teams).where(eq(teams.id, teamId)).limit(1);
		if (!team) throw error(404, 'Team not found');
	}

	const isFixed = body.pattern === 'fixed';
	const rotationWeeks: number[][] | null = isFixed ? null : body.rotationWeeks;

	const [created] = await db
		.insert(weekOffRosters)
		.values({
			name: String(body.name).trim(),
			description: typeof body.description === 'string' ? body.description.trim() || null : null,
			pattern: body.pattern,
			weekdays: isFixed ? [...new Set(body.weekdays as number[])].sort() : null,
			rotationWeeks,
			cycleWeeks: rotationWeeks?.length ?? null,
			rotationAnchorDate: isFixed ? null : body.rotationAnchorDate,
			teamId,
			// Publishing is a separate, deliberate step — see the [id]/publish route.
			status: 'draft',
			createdBy: actor.id
		})
		.returning();

	await logActivity({
		actorUserId: actor.id,
		action: 'week_off_roster.create',
		targetType: 'week_off_roster',
		targetId: created.id,
		details: { name: created.name, pattern: created.pattern, teamId }
	});

	return json({ roster: created }, { status: 201 });
};

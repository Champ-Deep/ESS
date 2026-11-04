import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/postgres';
import { weekOffRosters } from '$lib/server/db/schema';
import { logActivity } from '$lib/server/db/mongo';
import { eq } from 'drizzle-orm';
import { requireCap } from '$lib/server/capabilities';

/**
 * Publishing is what makes a saved roster usable by team managers — a draft is
 * only visible to the Super Admin who is still authoring it. Same lifecycle as
 * a holiday calendar, so "published" means the same thing across the portal.
 *
 * POST publishes; DELETE returns it to draft (existing assignments are left
 * alone — unpublishing stops new assignments, it does not rewrite calendars).
 */
export const POST: RequestHandler = async (event) => {
	const actor = requireCap(event, 'leave.week_off_rosters');
	const id = event.params.id;

	const [existing] = await db.select().from(weekOffRosters).where(eq(weekOffRosters.id, id)).limit(1);
	if (!existing) throw error(404, 'Roster not found');

	const [updated] = await db
		.update(weekOffRosters)
		.set({
			status: 'published',
			publishedBy: actor.id,
			publishedAt: new Date(),
			updatedAt: new Date()
		})
		.where(eq(weekOffRosters.id, id))
		.returning();

	await logActivity({
		actorUserId: actor.id,
		action: 'week_off_roster.publish',
		targetType: 'week_off_roster',
		targetId: id,
		details: { name: updated.name, teamId: updated.teamId }
	});

	return json({ roster: updated });
};

export const DELETE: RequestHandler = async (event) => {
	const actor = requireCap(event, 'leave.week_off_rosters');
	const id = event.params.id;

	const [updated] = await db
		.update(weekOffRosters)
		.set({ status: 'draft', publishedAt: null, publishedBy: null, updatedAt: new Date() })
		.where(eq(weekOffRosters.id, id))
		.returning();
	if (!updated) throw error(404, 'Roster not found');

	await logActivity({
		actorUserId: actor.id,
		action: 'week_off_roster.unpublish',
		targetType: 'week_off_roster',
		targetId: id,
		details: { name: updated.name }
	});

	return json({ roster: updated });
};

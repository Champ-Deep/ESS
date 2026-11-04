import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/postgres';
import { employeeProfiles } from '$lib/server/db/schema';
import { logActivity } from '$lib/server/db/mongo';
import { eq } from 'drizzle-orm';
import { requireCap } from '$lib/server/capabilities';

/**
 * HR override for pink-leave eligibility.
 *
 *   true  → granted regardless of recorded gender/tenure
 *   false → withheld regardless
 *   null  → clear the override and fall back to the automatic rule
 *           (female + confirmed, or 6 months' service)
 *
 * The override exists because gender and joining dates are missing for most
 * employees, so the automatic rule alone would quietly exclude people who
 * qualify. Every change is logged — this decides who can take leave.
 */
export const PUT: RequestHandler = async (event) => {
	const actor = requireCap(event, 'people.edit_settings');
	const userId = event.params.id;
	const { eligible } = await event.request.json();

	if (eligible !== true && eligible !== false && eligible !== null) {
		throw error(400, 'eligible must be true, false, or null');
	}

	const [profile] = await db
		.select()
		.from(employeeProfiles)
		.where(eq(employeeProfiles.userId, userId))
		.limit(1);
	if (!profile) throw error(404, 'Employee profile not found');

	const [updated] = await db
		.update(employeeProfiles)
		.set({ pinkLeaveEligibleOverride: eligible, updatedAt: new Date() })
		.where(eq(employeeProfiles.userId, userId))
		.returning();

	await logActivity({
		actorUserId: actor.id,
		action: 'employee_profile.set_pink_leave_override',
		targetType: 'user',
		targetId: userId,
		details: { eligible, previous: profile.pinkLeaveEligibleOverride }
	});

	return json({ profile: updated });
};

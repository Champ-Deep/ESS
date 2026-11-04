import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/postgres';
import { users } from '$lib/server/db/schema';
import { logActivity } from '$lib/server/db/mongo';
import { deleteEmployee } from '$lib/server/admin-cleanup';
import { and, eq } from 'drizzle-orm';
import { hiddenFrom, notHidden } from '$lib/server/hidden-users';
import { requireCap } from '$lib/server/capabilities';

/**
 * Permanently deletes an employee and their own records (profile, leave,
 * attendance, picture). Records that merely reference them survive with the
 * link cleared, so audit trails aren't destroyed.
 *
 * Super Admin only, and never yourself — losing the account you're signed in
 * as would lock you out with no way back.
 */
export const DELETE: RequestHandler = async (event) => {
	const actor = requireCap(event, 'people.delete');
	const userId = event.params.id;

	if (userId === actor.id) {
		throw error(400, 'You cannot delete your own account');
	}

	const [target] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
	if (!target || hiddenFrom(actor.id, target)) throw error(404, 'Employee not found');

	// Refuse to remove the last super admin — the portal would have no one who
	// can administer it.
	if (target.role === 'super_admin') {
		const admins = await db.select({ id: users.id }).from(users).where(and(eq(users.role, 'super_admin'), notHidden));
		if (admins.length <= 1) {
			throw error(400, 'Cannot delete the only Super Admin account');
		}
	}

	const result = await deleteEmployee(userId);

	await logActivity({
		actorUserId: actor.id,
		action: 'user.delete',
		targetType: 'user',
		targetId: userId,
		details: {
			email: result.email,
			fullName: result.fullName,
			deletedApplications: result.deletedApplications,
			deletedAttendance: result.deletedAttendance
		}
	});

	return json({ deleted: result });
};

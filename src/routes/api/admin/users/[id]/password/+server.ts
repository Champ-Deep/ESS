import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/postgres';
import { users } from '$lib/server/db/schema';
import { requireUser, canActOnUser } from '$lib/server/rbac';
import { hasCap } from '$lib/server/capabilities';
import { hashPassword } from '$lib/server/auth';
import { eq } from 'drizzle-orm';
import { hiddenFrom } from '$lib/server/hidden-users';
import { logActivity } from '$lib/server/db/store';
import { mirrorPasswordToClerk } from '$lib/server/clerk';
import { userCanReach } from '$lib/server/org-scope';
import { isNoLoginEmail } from '$lib/no-login';

// Admin-issued password reset for another user (no knowledge of their current password
// required). Authorization mirrors canActOnUser: Super Admin/Admin may reset anyone,
// a Team Lead may reset only members of their own team, and self-reset is always allowed
// here too (though self-service /api/auth/change-password is the normal path for that).
export const PUT: RequestHandler = async (event) => {
	const actor = requireUser(event);
	// A named role such as IT Support can hold the reset privilege without an
	// admin base role. It reaches Employees and Team Leads only: resetting an
	// admin's password would let it sign in as that admin.
	const viaPrivilege = actor.role !== 'super_admin' && actor.role !== 'admin' && hasCap(actor, 'people.reset_password');
	if (!viaPrivilege && actor.role === 'employee') {
		throw error(403, 'Insufficient privileges');
	}
	const targetUserId = event.params.id;
	const { newPassword } = await event.request.json();

	if (typeof newPassword !== 'string' || newPassword.length < 8) {
		throw error(400, 'newPassword is required and must be at least 8 characters');
	}

	if (!/^[0-9a-f-]{36}$/i.test(targetUserId)) throw error(404, 'User not found');
	const [target] = await db.select().from(users).where(eq(users.id, targetUserId)).limit(1);
	if (!target || hiddenFrom(actor.id, target)) {
		throw error(404, 'User not found');
	}
	// No login to reset (src/lib/no-login.ts): give them a real email first.
	if (isNoLoginEmail(target.email)) {
		throw error(400, `${target.fullName} has no login, so there is no password to reset`);
	}

	if (viaPrivilege) {
		if (target.role === 'admin' || target.role === 'super_admin') {
			throw error(403, 'Only an HR Admin or Super Admin can reset an admin account password');
		}
	} else if (
		!canActOnUser(
			actor,
			target.id,
			target.teamId,
			actor.role === 'team_lead' && (await userCanReach(actor, target.id, 'person.reset_password')) ? new Set([target.id]) : undefined
		)
	) {
		throw error(403, 'Insufficient privileges to reset this user\'s password');
	}

	// A Team Lead may only reset passwords for Employees on their team, never peers or
	// escalate to admin/super_admin accounts even if teamId happens to line up.
	if (!viaPrivilege && actor.role === 'team_lead' && target.role !== 'employee' && target.id !== actor.id) {
		throw error(403, 'Team Leads may only reset passwords for employees on their team');
	}

	const passwordHash = await hashPassword(newPassword);

	const [updated] = await db
		.update(users)
		.set({
			passwordHash,
			mustChangePassword: true,
			// Readable on the roster until the target sets their own password. The
			// actor chose this value and already knows it; holding it means a second
			// admin, or the same one a day later, can still pass it on.
			temporaryPassword: newPassword,
			updatedAt: new Date()
		})
		.where(eq(users.id, targetUserId))
		.returning();

	// The reset also ends every Clerk session the person has open.
	await mirrorPasswordToClerk(updated.id, newPassword, { signOutOtherSessions: true });

	await logActivity({
		actorUserId: actor.id,
		action: 'user.password_reset',
		targetType: 'user',
		targetId: updated.id
	});

	return json({
		user: { id: updated.id, email: updated.email, fullName: updated.fullName, role: updated.role }
	});
};

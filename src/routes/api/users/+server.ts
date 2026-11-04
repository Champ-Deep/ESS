import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/postgres';
import { users, teams } from '$lib/server/db/schema';
import { requireRole, canCreateRole } from '$lib/server/rbac';
import { and, eq } from 'drizzle-orm';
import { notHidden } from '$lib/server/hidden-users';
import { logActivity } from '$lib/server/db/mongo';
import { addNewLoginToClerk, newLoginCredentials } from '$lib/server/clerk';

export const POST: RequestHandler = async (event) => {
	const actor = requireRole(event, ['super_admin', 'admin', 'team_lead']);
	const { email, fullName, role, teamId } = await event.request.json();

	if (!email || !fullName || !role) {
		throw error(400, 'email, fullName, and role are required');
	}

	if (!canCreateRole(actor, role)) {
		throw error(403, `${actor.role} accounts may not create ${role} accounts`);
	}

	if (actor.role === 'team_lead' && teamId && teamId !== actor.teamId) {
		throw error(403, 'Team Leads may only create accounts within their own team');
	}

	const resolvedTeamId = actor.role === 'team_lead' ? actor.teamId : (teamId ?? null);

	if (actor.role === 'team_lead') {
		const [team] = await db.select().from(teams).where(eq(teams.id, actor.teamId ?? '')).limit(1);
		if (!team?.canCreateEmployeeLogins) {
			throw error(403, 'This Team Lead does not have permission to create employee logins');
		}
	}

	// A temporary password, or none while Clerk is the sign-in (the person signs
	// in with an emailed code and chooses their own, see password-state.ts).
	const { temporaryPassword: tempPassword, passwordHash } = await newLoginCredentials();
	// The hidden developer login is nobody's manager.
	const [creator] = await db.select({ hidden: users.hidden }).from(users).where(eq(users.id, actor.id)).limit(1);

	const [created] = await db
		.insert(users)
		.values({
			email: email.toLowerCase(),
			passwordHash,
			role,
			fullName,
			teamId: resolvedTeamId,
			reportsTo: creator?.hidden ? null : actor.id,
			isActive: true,
			mustChangePassword: true,
			// Readable on the Team roster until this person sets their own password,
			// so the login survives a caller that drops this response.
			temporaryPassword: tempPassword
		})
		.returning();
	await addNewLoginToClerk(created.id, tempPassword);

	await logActivity({
		actorUserId: actor.id,
		action: 'user.create',
		targetType: 'user',
		targetId: created.id,
		details: { role, teamId: resolvedTeamId }
	});

	return json({ user: { id: created.id, email: created.email, fullName: created.fullName, role: created.role }, tempPassword }, { status: 201 });
};

export const GET: RequestHandler = async (event) => {
	const actor = requireRole(event, ['super_admin', 'admin', 'team_lead']);

	const rows =
		actor.role === 'super_admin' || actor.role === 'admin'
			? await db.select().from(users).where(notHidden)
			: await db.select().from(users).where(and(eq(users.teamId, actor.teamId ?? ''), notHidden));

	return json({
		users: rows.map((u) => ({
			id: u.id,
			email: u.email,
			fullName: u.fullName,
			role: u.role,
			teamId: u.teamId,
			isActive: u.isActive
		}))
	});
};

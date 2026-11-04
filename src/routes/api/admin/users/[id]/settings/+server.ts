import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser, canActOnUser } from '$lib/server/rbac';
import { db } from '$lib/server/db/postgres';
import { users, teams, employeeProfiles, shiftGroups, weekOffRosters, customRoles } from '$lib/server/db/schema';
import { logActivity } from '$lib/server/db/mongo';
import { eq, and, ne } from 'drizzle-orm';
import type { Role } from '$lib/server/auth';
import { assignRoster, clearRoster } from '$lib/server/week-off';
import { hasCap, invalidateCapabilities } from '$lib/server/capabilities';
import { syncMembershipFor } from '$lib/server/chat/sync';
import { invalidateOrgScope, userCanReach } from '$lib/server/org-scope';
import { invalidateOrg } from '$lib/server/tasks/service';
import { hiddenFrom, notHidden } from '$lib/server/hidden-users';
import { asTopPosition } from '$lib/chief';

const ROLES: Role[] = ['super_admin', 'admin', 'team_lead', 'employee'];

/**
 * Saves every org setting for one employee in a single call: role, reporting
 * manager, assigned HR, shift group, office timings and week-off roster.
 *
 * One endpoint rather than six because the roster panel edits them together —
 * six separate PUTs would half-apply if one failed, leaving the person in a
 * state nobody chose. Only the fields present in the body are touched, so the
 * panel can send just what changed.
 *
 * Who may call it, and over whom:
 *
 *   Super Admin  anyone, every field.
 *   Admin        anyone, every field but role.
 *   Team Lead    Employees on their own team (and themselves), every field but
 *                role — the same reach the password-reset endpoint gives them.
 *
 * Role stays Super Admin's alone. It decides who can approve, who can create
 * accounts and who can administer the portal, so it is the one setting a Team
 * Lead running their own team has no business granting — least of all to
 * themselves. Everything else here is scheduling and reporting detail that the
 * person closest to the team is best placed to keep right.
 */
export const PUT: RequestHandler = async (event) => {
	const actor = requireUser(event);
	// A named role (say, Operations) may carry the settings privilege without
	// an admin base role. It reaches Employees and Team Leads, not admins.
	const viaPrivilege =
		actor.role !== 'super_admin' && actor.role !== 'admin' && hasCap(actor, 'people.edit_settings');
	if (!viaPrivilege && actor.role === 'employee') {
		throw error(403, 'Insufficient privileges');
	}
	const userId = event.params.id;
	const body = await event.request.json();

	const [target] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
	if (!target || hiddenFrom(actor.id, target)) throw error(404, 'Employee not found');

	if (viaPrivilege) {
		if (target.role === 'admin' || target.role === 'super_admin') {
			throw error(403, "Only an HR Admin or Super Admin can change an admin's settings");
		}
	} else if (
		!canActOnUser(
			actor,
			target.id,
			target.teamId,
			actor.role === 'team_lead' && (await userCanReach(actor, target.id, 'person.edit_settings')) ? new Set([target.id]) : undefined
		)
	) {
		throw error(403, "Insufficient privileges to change this employee's settings");
	}
	// A Team Lead runs their own team, not their peers: same-team is not enough
	// on its own, or one lead could re-shift another, or an admin who happens to
	// sit on their team. Mirrors the password-reset rule exactly.
	if (!viaPrivilege && actor.role === 'team_lead' && target.role !== 'employee' && target.id !== actor.id) {
		throw error(403, 'Team Leads may only change settings for employees on their team');
	}

	const [profile] = await db
		.select()
		.from(employeeProfiles)
		.where(eq(employeeProfiles.userId, userId))
		.limit(1);
	if (!profile) throw error(404, 'Employee profile not found');

	const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key);
	const changes: Record<string, unknown> = {};

	// --- Role -----------------------------------------------------------------
	let teamCreated: string | null = null;
	if (has('role') && body.role !== target.role) {
		if (actor.role !== 'super_admin') {
			throw error(403, "Only a Super Admin may change someone's role");
		}
		if (!ROLES.includes(body.role)) {
			throw error(400, `role must be one of: ${ROLES.join(', ')}`);
		}
		if (userId === actor.id) {
			throw error(400, 'You cannot change your own role');
		}
		// The portal must always retain someone who can administer it.
		if (target.role === 'super_admin' && body.role !== 'super_admin') {
			const remaining = await db
				.select({ id: users.id })
				.from(users)
				.where(and(eq(users.role, 'super_admin'), ne(users.id, userId), notHidden));
			if (remaining.length === 0) {
				throw error(400, 'Cannot change the role of the only Super Admin account');
			}
		}
		changes.role = { from: target.role, to: body.role };
	}

	// --- Named role -----------------------------------------------------------
	// Giving someone a named role (IT Support, Operations) also moves their base
	// role to the one that named role starts from, so "IT Support" means the
	// same thing for everyone who holds it. Super Admin only.
	if (has('customRoleId') && (body.customRoleId || null) !== target.customRoleId) {
		if (!hasCap(actor, 'people.assign_roles')) {
			throw error(403, 'Only a Super Admin may give someone a named role');
		}
		if (userId === actor.id) throw error(400, 'You cannot change your own role');
		const customId: string | null = body.customRoleId || null;
		if (customId) {
			if (target.role === 'super_admin' && !changes.role) {
				throw error(400, 'A Super Admin already has every privilege. Change their base role first.');
			}
			const [named] = await db.select().from(customRoles).where(eq(customRoles.id, customId)).limit(1);
			if (!named) throw error(404, 'That named role no longer exists');
			const currentRole = (changes.role as { to: Role } | undefined)?.to ?? target.role;
			if (named.baseRole !== currentRole) {
				changes.role = { from: target.role, to: named.baseRole };
			}
		}
		changes.customRoleId = { from: target.customRoleId, to: customId };
	}

	// --- Reporting manager ----------------------------------------------------
	// A cycle would make the approval chain unresolvable — managerFor() walks up
	// the line, so a loop would never terminate. But refusing the assignment is
	// the wrong answer: re-organisations legitimately invert a reporting line
	// ("Bhavana reports to Prasanna; now Prasanna reports to Deepak, who reports
	// to Bhavana"), and blocking that leaves the admin stuck with no way to
	// express what actually happened.
	//
	// So the assignment always wins. Anyone on the path who would close the loop
	// has their own line cleared, which is exactly what a promotion means: the
	// old chain no longer holds, and the freed person is re-pointed by the same
	// panel afterwards. Reported in the response so it is never silent.
	let loopBroken: { userId: string; fullName: string; previousManagerId: string }[] = [];
	if (has('reportsTo') && body.reportsTo !== target.reportsTo) {
		const managerId: string | null = body.reportsTo || null;
		if (managerId) {
			if (managerId === userId) {
				throw error(400, 'Someone cannot report to themselves');
			}
			const [manager] = await db
				.select({ id: users.id, teamId: users.teamId })
				.from(users)
				.where(and(eq(users.id, managerId), notHidden))
				.limit(1);
			if (!manager) throw error(404, 'Reporting manager not found');

			// A Team Lead may rearrange the line inside their own team; pointing it
			// at someone outside would hand their report's leave approvals to a
			// person the lead has no authority over, and quietly move them out from
			// under their own oversight.
			if (actor.role === 'team_lead' && manager.teamId !== actor.teamId) {
				throw error(403, 'A Team Lead can only set a reporting manager from their own team');
			}

			// Walk up from the new manager. If we arrive back at this employee, the
			// step that points back at them is the one to cut.
			const path: { id: string; fullName: string; reportsTo: string | null }[] = [];
			let cursor: string | null = managerId;
			const seen = new Set<string>();
			while (cursor && !seen.has(cursor)) {
				seen.add(cursor);
				const [row] = await db
					.select({ id: users.id, fullName: users.fullName, reportsTo: users.reportsTo })
					.from(users)
					.where(eq(users.id, cursor))
					.limit(1);
				if (!row) break;
				path.push(row);
				if (row.reportsTo === userId) {
					// This person's line closes the loop; clear it.
					loopBroken.push({
						userId: row.id,
						fullName: row.fullName,
						previousManagerId: userId
					});
					break;
				}
				cursor = row.reportsTo;
			}
		}
		changes.reportsTo = { from: target.reportsTo, to: managerId };
	}

	// --- Reports to Chief or Mam ----------------------------------------------
	// Chief and Mam are the heads of the company and have no login, so
	// reporting to either is a flag on the profile (reportsToChief, with
	// topPosition naming which), not a users.reportsTo link. The two are
	// exclusive: choosing Chief or Mam clears the manager, and choosing a
	// manager clears them. Admins only — it moves the person's approvals to HR,
	// which is not a Team Lead's call.
	let chiefTo: boolean | undefined;
	if (body.reportsToChief && body.reportsTo) {
		throw error(400, 'Pick either a reporting manager or Chief/Mam, not both');
	}
	if (has('reportsToChief') && Boolean(body.reportsToChief) !== profile.reportsToChief) {
		if (actor.role === 'team_lead') {
			throw error(403, 'Only an admin can set someone to report to Chief or Mam');
		}
		chiefTo = Boolean(body.reportsToChief);
	}
	if (chiefTo === true) {
		loopBroken = [];
		if (target.reportsTo) changes.reportsTo = { from: target.reportsTo, to: null };
		else delete changes.reportsTo;
	}
	const managerAfter = changes.reportsTo ? (changes.reportsTo as { to: string | null }).to : target.reportsTo;
	if (managerAfter && profile.reportsToChief) chiefTo = false;
	if (chiefTo !== undefined) changes.reportsToChief = { from: profile.reportsToChief, to: chiefTo };
	// Which of the two: only meaningful while they report to one, and moving
	// between Chief and Mam is the same admin-only call.
	if (has('topPosition') && (chiefTo ?? profile.reportsToChief)) {
		const topTo = asTopPosition(body.topPosition);
		if (topTo !== asTopPosition(profile.topPosition)) {
			if (actor.role === 'team_lead') {
				throw error(403, 'Only an admin can set someone to report to Chief or Mam');
			}
			changes.topPosition = { from: profile.topPosition, to: topTo };
		}
	}

	// --- Assigned HR ----------------------------------------------------------
	if (has('hrUserId') && body.hrUserId !== profile.hrUserId) {
		const hrId: string | null = body.hrUserId || null;
		if (hrId) {
			if (hrId === userId) throw error(400, 'Someone cannot be their own HR contact');
			const [hr] = await db.select({ id: users.id }).from(users).where(and(eq(users.id, hrId), notHidden)).limit(1);
			if (!hr) throw error(404, 'HR contact not found');
		}
		changes.hrUserId = { from: profile.hrUserId, to: hrId };
	}

	// --- Shift group ----------------------------------------------------------
	if (has('shiftGroupId') && body.shiftGroupId !== profile.shiftGroupId) {
		const groupId: string | null = body.shiftGroupId || null;
		if (groupId) {
			const [group] = await db
				.select({ id: shiftGroups.id })
				.from(shiftGroups)
				.where(eq(shiftGroups.id, groupId))
				.limit(1);
			if (!group) throw error(404, 'Shift group not found');
		}
		changes.shiftGroupId = { from: profile.shiftGroupId, to: groupId };
	}

	// --- Office timings -------------------------------------------------------
	// Free text ("9:00 AM - 6:00 PM"); it bounds how far a check-out may sit from
	// its check-in when pairing an overnight shift.
	if (has('officeTimings') && body.officeTimings !== profile.officeTimings) {
		const timings =
			typeof body.officeTimings === 'string' && body.officeTimings.trim()
				? body.officeTimings.trim().slice(0, 120)
				: null;
		changes.officeTimings = { from: profile.officeTimings, to: timings };
	}

	if (has('shiftType') && body.shiftType !== profile.shiftType) {
		const shiftType =
			typeof body.shiftType === 'string' && body.shiftType.trim()
				? body.shiftType.trim().slice(0, 60)
				: null;
		changes.shiftType = { from: profile.shiftType, to: shiftType };
	}

	// --- Week-off roster ------------------------------------------------------
	let rosterApplied: string | null | undefined;
	if (has('weekOffRosterId')) {
		const rosterId: string | null = body.weekOffRosterId || null;
		if (rosterId) {
			const [roster] = await db
				.select({ id: weekOffRosters.id })
				.from(weekOffRosters)
				.where(eq(weekOffRosters.id, rosterId))
				.limit(1);
			if (!roster) throw error(404, 'Week-off roster not found');
		}
		rosterApplied = rosterId;
	}

	// --- Apply ----------------------------------------------------------------
	const userPatch: Record<string, unknown> = {};
	if (changes.role) userPatch.role = (changes.role as { to: Role }).to;
	if (changes.customRoleId) userPatch.customRoleId = (changes.customRoleId as { to: string | null }).to;
	// Promoting to Super Admin drops any named role: it would add nothing.
	if (changes.role && (changes.role as { to: Role }).to === 'super_admin') userPatch.customRoleId = null;
	if (changes.reportsTo) userPatch.reportsTo = (changes.reportsTo as { to: string | null }).to;
	if (Object.keys(userPatch).length > 0 || loopBroken.length > 0) {
		// Cutting the old line and setting the new one are one change: leaving
		// either half applied would either strand a loop or drop a reporting line
		// for no reason.
		await db.transaction(async (tx) => {
			for (const broken of loopBroken) {
				await tx
					.update(users)
					.set({ reportsTo: null, updatedAt: new Date() })
					.where(eq(users.id, broken.userId));
			}
			if (Object.keys(userPatch).length > 0) {
				userPatch.updatedAt = new Date();
				await tx.update(users).set(userPatch).where(eq(users.id, userId));
			}
		});
	}

	const profilePatch: Record<string, unknown> = {};
	for (const key of ['hrUserId', 'shiftGroupId', 'officeTimings', 'shiftType', 'reportsToChief', 'topPosition'] as const) {
		if (changes[key]) profilePatch[key] = (changes[key] as { to: unknown }).to;
	}
	if (Object.keys(profilePatch).length > 0) {
		profilePatch.updatedAt = new Date();
		await db.update(employeeProfiles).set(profilePatch).where(eq(employeeProfiles.userId, userId));
	}

	if (rosterApplied !== undefined) {
		const today = new Date().toISOString().slice(0, 10);
		if (rosterApplied) {
			await assignRoster({
				userId,
				rosterId: rosterApplied,
				effectiveFrom: today,
				assignedBy: actor.id
			});
		} else {
			await clearRoster(userId, today);
		}
		changes.weekOffRosterId = { to: rosterApplied };
	}

	// A new Team Lead with no team has nothing to lead — the approval queues key
	// off team membership, so one is created rather than leaving them inert.
	if (changes.role && (changes.role as { to: Role }).to === 'team_lead' && !target.teamId) {
		const [team] = await db
			.insert(teams)
			.values({ name: `${target.fullName}'s Team`, teamLeadId: userId })
			.returning();
		await db.update(users).set({ teamId: team.id }).where(eq(users.id, userId));
		teamCreated = team.id;
	}

	if (Object.keys(changes).length === 0) {
		return json({ changed: false, changes: {} });
	}

	invalidateCapabilities(userId);
	// Shift group moves them between shift channels in Champ Chat.
	void syncMembershipFor(userId).catch((err) => console.error('[chat] sync failed:', err));

	await logActivity({
		actorUserId: actor.id,
		action: 'user.settings_update',
		targetType: 'user',
		targetId: userId,
		details: { email: target.email, changes, teamCreated, loopBroken }
	});

	// loopBroken names whose reporting line was cleared to make room for this
	// one, so the panel can say so rather than leaving it to be discovered.
	// Reporting line, team, HR or role may have moved: let scopes and the
	// task/meeting org snapshot see it now rather than in 30 seconds.
	invalidateOrgScope();
	invalidateOrg();
	return json({ changed: true, changes, teamCreated, loopBroken });
};

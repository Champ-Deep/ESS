import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db/client';
import { customRoles, teams, users } from '$lib/server/db/schema';
import { and, asc, eq } from 'drizzle-orm';
import { notHidden } from '$lib/server/hidden-users';
import { alias } from 'drizzle-orm/sqlite-core';
import { gateAdminPage, hasCap } from '$lib/server/capabilities';
import { assignNamedRole, deleteNamedRole, saveNamedRole } from '$lib/server/roles';
import type { Role } from '$lib/server/auth';

/**
 * Roles & access — the built-in roles, the named roles a Super Admin makes
 * (IT Support, Operations…), who holds each, and each team's privilege flags.
 *
 * Reading needs "See roles and access"; changing anything needs the Super
 * Admin-only role privileges, re-checked in src/lib/server/roles.ts.
 */
export const load: PageServerLoad = async ({ locals }) => {
	const viewer = gateAdminPage(locals, ['access.view', 'system.roles']);
	const lead = alias(users, 'lead');

	const [teamRows, people, named] = await Promise.all([
		db
			.select({
				id: teams.id,
				name: teams.name,
				teamLeadName: lead.fullName,
				canApproveLeave: teams.canApproveLeave,
				maxLeaveDaysAutoApprove: teams.maxLeaveDaysAutoApprove,
				canEditTeamShiftWindow: teams.canEditTeamShiftWindow,
				canViewTeamPayrollCost: teams.canViewTeamPayrollCost,
				canCreateEmployeeLogins: teams.canCreateEmployeeLogins,
				canResolveGrievances: teams.canResolveGrievances
			})
			.from(teams)
			.leftJoin(lead, and(eq(lead.id, teams.teamLeadId), eq(lead.hidden, false)))
			.orderBy(asc(teams.name)),
		db
			.select({ id: users.id, fullName: users.fullName, email: users.email, role: users.role, customRoleId: users.customRoleId })
			.from(users)
			.where(and(eq(users.isActive, true), notHidden))
			.orderBy(asc(users.fullName)),
		db.select().from(customRoles).orderBy(asc(customRoles.name))
	]);

	const byRole: Record<string, number> = {};
	for (const p of people) if (!p.customRoleId) byRole[p.role] = (byRole[p.role] ?? 0) + 1;

	return {
		canManage: hasCap(viewer, 'system.roles'),
		viewerId: viewer.id,
		teamRows,
		byRole,
		namedRoles: named.map((r) => ({
			id: r.id,
			name: r.name,
			description: r.description,
			baseRole: r.baseRole as Role,
			capabilities: r.capabilities,
			members: people.filter((p) => p.customRoleId === r.id).map((p) => ({ id: p.id, fullName: p.fullName, email: p.email }))
		})),
		people: people.map((p) => ({ id: p.id, fullName: p.fullName, role: p.role, customRoleId: p.customRoleId }))
	};
};

export const actions: Actions = {
	saveRole: async ({ request, locals }) => {
		const form = await request.formData();
		const result = await saveNamedRole(locals.user!, {
			id: String(form.get('id') ?? '') || null,
			name: String(form.get('name') ?? ''),
			description: String(form.get('description') ?? ''),
			baseRole: String(form.get('baseRole') ?? 'employee') as Role,
			capabilities: form.getAll('capabilities').map(String)
		});
		if (!result.ok) return fail(400, { error: result.message });
		return { saved: result.id, message: 'Role saved. Changes reach people within 30 seconds.' };
	},

	deleteRole: async ({ request, locals }) => {
		const id = String((await request.formData()).get('id') ?? '');
		const result = await deleteNamedRole(locals.user!, id);
		if (!result.ok) return fail(400, { error: result.message });
		return {
			message:
				result.released === 0
					? 'Role deleted.'
					: `Role deleted. ${result.released} ${result.released === 1 ? 'person keeps' : 'people keep'} their base role.`
		};
	},

	assign: async ({ request, locals }) => {
		const form = await request.formData();
		const result = await assignNamedRole(
			locals.user!,
			String(form.get('userId') ?? ''),
			String(form.get('roleId') ?? '') || null
		);
		if (!result.ok) return fail(400, { error: result.message });
		return { message: result.name ? `Now holds ${result.name}.` : 'Named role removed.' };
	}
};

import { db } from '$lib/server/db/postgres';
import { customRoles, users } from '$lib/server/db/schema';
import { and, eq, ne, sql } from 'drizzle-orm';
import { logActivity } from '$lib/server/db/mongo';
import { GRANTABLE_KEYS } from '$lib/capabilities';
import type { Role, SessionUser } from '$lib/server/auth';
import { hasCap, invalidateCapabilities } from '$lib/server/capabilities';
import { hiddenFrom, notHidden } from '$lib/server/hidden-users';

/**
 * Named roles: creating, changing and deleting them, and giving them to
 * people. Used by Admin Controls › Roles & access and by Champ's cards, so the
 * rules live once. Everything here is Super Admin only.
 */

export type RoleInput = {
	id?: string | null;
	name: string;
	description?: string;
	baseRole: Role;
	capabilities: string[];
};

type Result<T = object> = ({ ok: true } & T) | { ok: false; message: string };

const UUID = /^[0-9a-f-]{36}$/i;
const BASES: Role[] = ['employee', 'team_lead', 'admin'];

export async function saveNamedRole(actor: SessionUser, input: RoleInput): Promise<Result<{ id: string }>> {
	if (!hasCap(actor, 'system.roles')) return { ok: false, message: 'Only a Super Admin can manage roles' };
	const name = input.name.trim().replace(/\s+/g, ' ');
	if (!name) return { ok: false, message: 'Give the role a name' };
	if (name.length > 60) return { ok: false, message: 'Keep the name under 60 characters' };
	if (/^(employee|team lead|hr admin|admin|super admin)$/i.test(name)) {
		return { ok: false, message: 'That name is already a built-in role. Pick another.' };
	}
	if (!BASES.includes(input.baseRole)) return { ok: false, message: 'Pick what the role starts from' };
	const caps = [...new Set(input.capabilities)].filter((c) => (GRANTABLE_KEYS as string[]).includes(c));

	const [clash] = await db
		.select({ id: customRoles.id })
		.from(customRoles)
		.where(
			and(
				sql`lower(${customRoles.name}) = ${name.toLowerCase()}`,
				input.id && UUID.test(input.id) ? ne(customRoles.id, input.id) : undefined
			)
		)
		.limit(1);
	if (clash) return { ok: false, message: `A role called "${name}" already exists` };

	let id = input.id ?? null;
	if (id) {
		if (!UUID.test(id)) return { ok: false, message: 'That role no longer exists' };
		const [before] = await db.select().from(customRoles).where(eq(customRoles.id, id)).limit(1);
		if (!before) return { ok: false, message: 'That role no longer exists' };
		await db
			.update(customRoles)
			.set({ name, description: input.description?.trim() ?? '', baseRole: input.baseRole, capabilities: caps, updatedAt: new Date() })
			.where(eq(customRoles.id, id));
		// Everyone holding it follows a change of starting point.
		if (before.baseRole !== input.baseRole) {
			await db
				.update(users)
				.set({ role: input.baseRole, updatedAt: new Date() })
				.where(and(eq(users.customRoleId, id), ne(users.role, 'super_admin')));
		}
		await logActivity({
			actorUserId: actor.id,
			action: 'role.update',
			targetType: 'custom_role',
			targetId: id,
			details: { name, baseRole: input.baseRole, capabilities: caps, before: { name: before.name, baseRole: before.baseRole, capabilities: before.capabilities } }
		});
	} else {
		const [row] = await db
			.insert(customRoles)
			.values({ name, description: input.description?.trim() ?? '', baseRole: input.baseRole, capabilities: caps, createdBy: actor.id })
			.returning({ id: customRoles.id });
		id = row.id;
		await logActivity({
			actorUserId: actor.id,
			action: 'role.create',
			targetType: 'custom_role',
			targetId: id,
			details: { name, baseRole: input.baseRole, capabilities: caps }
		});
	}
	invalidateCapabilities();
	return { ok: true, id };
}

export async function deleteNamedRole(actor: SessionUser, id: string): Promise<Result<{ released: number }>> {
	if (!hasCap(actor, 'system.roles')) return { ok: false, message: 'Only a Super Admin can manage roles' };
	if (!UUID.test(id)) return { ok: false, message: 'That role no longer exists' };
	const [role] = await db.select().from(customRoles).where(eq(customRoles.id, id)).limit(1);
	if (!role) return { ok: false, message: 'That role no longer exists' };
	// People holding it keep their base role and lose only the extra privileges.
	const released = await db
		.update(users)
		.set({ customRoleId: null, updatedAt: new Date() })
		.where(eq(users.customRoleId, id))
		.returning({ id: users.id });
	await db.delete(customRoles).where(eq(customRoles.id, id));
	await logActivity({
		actorUserId: actor.id,
		action: 'role.delete',
		targetType: 'custom_role',
		targetId: id,
		details: { name: role.name, released: released.length }
	});
	invalidateCapabilities();
	return { ok: true, released: released.length };
}

/**
 * Gives `userId` a named role (or takes it away with null). Their base role
 * moves to the role's starting point. Never on yourself, never on the last
 * Super Admin.
 */
export async function assignNamedRole(
	actor: SessionUser,
	userId: string,
	roleId: string | null
): Promise<Result<{ name: string | null }>> {
	if (!hasCap(actor, 'people.assign_roles')) return { ok: false, message: 'Only a Super Admin can give people roles' };
	if (!UUID.test(userId)) return { ok: false, message: 'That person no longer exists' };
	if (userId === actor.id) return { ok: false, message: 'You cannot change your own role' };
	const [target] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
	if (!target || hiddenFrom(actor.id, target)) return { ok: false, message: 'That person no longer exists' };

	let named: typeof customRoles.$inferSelect | undefined;
	if (roleId) {
		if (!UUID.test(roleId)) return { ok: false, message: 'That role no longer exists' };
		[named] = await db.select().from(customRoles).where(eq(customRoles.id, roleId)).limit(1);
		if (!named) return { ok: false, message: 'That role no longer exists' };
		if (target.role === 'super_admin') {
			const others = await db
				.select({ id: users.id })
				.from(users)
				.where(and(eq(users.role, 'super_admin'), ne(users.id, userId), eq(users.isActive, true), notHidden));
			if (others.length === 0) return { ok: false, message: 'They are the only Super Admin, so their role cannot change' };
		}
	}

	await db
		.update(users)
		.set({
			customRoleId: named?.id ?? null,
			...(named ? { role: named.baseRole } : {}),
			updatedAt: new Date()
		})
		.where(eq(users.id, userId));
	await logActivity({
		actorUserId: actor.id,
		action: 'user.named_role',
		targetType: 'user',
		targetId: userId,
		details: {
			email: target.email,
			from: { role: target.role, customRoleId: target.customRoleId },
			to: named ? { role: named.baseRole, customRoleId: named.id, name: named.name } : { role: target.role, customRoleId: null }
		}
	});
	invalidateCapabilities(userId);
	return { ok: true, name: named?.name ?? null };
}

import { randomBytes } from 'node:crypto';
import { db } from '$lib/server/db/postgres';
import { customRoles, employeeProfiles, holidayCalendars, shiftGroups, teams, users } from '$lib/server/db/schema';
import { and, eq } from 'drizzle-orm';
import { type Role, type SessionUser } from '$lib/server/auth';
import { addNewLoginToClerk, newLoginCredentials } from '$lib/server/clerk';
import { logActivity } from '$lib/server/db/mongo';
import { queueLoginEmails } from '$lib/server/login-emails';
import { hasCap, invalidateCapabilities } from '$lib/server/capabilities';
import { topFromPick, topLabel } from '$lib/chief';
import { notHidden } from '$lib/server/hidden-users';
import { isNoLoginEmail, noLoginEmail } from '$lib/no-login';
import { NO_LOGIN } from '$lib/server/password-state';

/**
 * Creating one login. Shared by the People form and Champ's "create a login"
 * card, so both apply exactly the same rules.
 *
 * The access a new login gets is chosen as one value:
 *   "base:<role>"  a base role — Employee, Team Lead, HR Admin, Super Admin
 *   "named:<id>"   a named role a Super Admin created (IT Support, …), which
 *                  also fixes the base role to the one it starts from
 */

/** The base roles `actor` may create. */
export function creatableBaseRoles(actor: SessionUser): Role[] {
	if (actor.role === 'super_admin') return ['super_admin', 'admin', 'team_lead', 'employee'];
	if (actor.role === 'admin') return ['team_lead', 'employee'];
	if (actor.role === 'team_lead') return ['employee'];
	// A named role with the create privilege (IT Support) makes Employees only:
	// anything more would let it hand out powers it does not hold.
	return hasCap(actor, 'people.create_login') ? ['employee'] : [];
}

export function canCreateLogins(actor: SessionUser): boolean {
	return actor.role === 'team_lead' || hasCap(actor, 'people.create_login');
}

export type NewLogin = {
	email: string;
	fullName: string;
	access: string;
	shiftGroupId: string;
	teamId?: string | null;
	/** A user id, CHIEF_PICK or MAM_PICK, or empty for none. */
	reportsTo?: string | null;
	hrUserId?: string | null;
	/**
	 * No work email, and the person is blue collar: on the roster with no login,
	 * looked after by their reporting manager (src/lib/no-login.ts). Only read
	 * when `email` is empty.
	 */
	blueCollar?: boolean;
	/** Optional; matters most for blue-collar staff, whose attendance is biometric. */
	employeeCode?: string | null;
};

export type CreateResult =
	| { success: false; message: string }
	| {
			success: true;
			userId: string;
			email: string;
			/** Null when Clerk is the sign-in: the person chooses their own. */
			tempPassword: string | null;
			/** Always false now: the welcome email waits for an admin's approval. */
			emailSent: boolean;
			emailError: string | null;
			/** Queued for approval in Admin Controls › People. */
			emailQueued: boolean;
			/** Created as a blue-collar worker with no login. */
			blueCollar?: boolean;
			fullName?: string;
			managerName?: string | null;
	  };

const UUID = /^[0-9a-f-]{36}$/i;

export function generateTemporaryPassword(): string {
	return randomBytes(9).toString('base64url');
}

export async function createLogin(actor: SessionUser, input: NewLogin, opts: { source?: 'single' | 'champ' } = {}): Promise<CreateResult> {
	const fail = (message: string) => ({ success: false as const, message });
	const email = input.email.trim().toLowerCase();
	const fullName = input.fullName.trim();

	if (!canCreateLogins(actor)) return fail('You do not have the privilege to create logins');
	if (!fullName) return fail('Name is required');
	// No work email: only a blue-collar worker, who gets no login at all.
	const blueCollar = !email && Boolean(input.blueCollar);
	if (!email && !blueCollar) return fail('Enter their work email, or say they are blue collar (no email, no login)');
	if (email && (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || isNoLoginEmail(email))) {
		return fail('That email address does not look right');
	}
	if (!input.shiftGroupId) return fail('Shift group is required');

	// --- Access
	let role: Role = 'employee';
	let customRoleId: string | null = null;
	let accessLabel = 'Employee';
	// A blue-collar worker never signs in, so any access beyond Employee is moot.
	const access = blueCollar ? 'base:employee' : input.access || 'base:employee';
	if (access.startsWith('named:')) {
		if (!hasCap(actor, 'people.assign_roles')) return fail('Only a Super Admin can give a named role');
		const id = access.slice(6);
		const [named] = UUID.test(id) ? await db.select().from(customRoles).where(eq(customRoles.id, id)).limit(1) : [];
		if (!named) return fail('That named role no longer exists');
		role = named.baseRole;
		customRoleId = named.id;
		accessLabel = named.name;
	} else {
		role = access.slice(5) as Role;
		if (!creatableBaseRoles(actor).includes(role)) {
			return fail(`You may not create ${role.replace('_', ' ')} logins`);
		}
		accessLabel = role;
	}

	// --- Team
	let teamId: string | null = null;
	if (actor.role === 'team_lead') {
		const [team] = await db.select().from(teams).where(eq(teams.id, actor.teamId ?? '')).limit(1);
		if (!team?.canCreateEmployeeLogins) {
			return fail('This Team Lead does not have permission to create employee logins');
		}
		teamId = actor.teamId;
	} else if (input.teamId) {
		if (!UUID.test(input.teamId)) return fail('Pick a team from the list');
		const [team] = await db.select({ id: teams.id }).from(teams).where(eq(teams.id, input.teamId)).limit(1);
		if (!team) return fail('That team no longer exists');
		teamId = team.id;
	}

	// --- Reporting line. A Team Lead's new joiner reports to them, as before.
	let reportsTo: string | null = actor.role === 'team_lead' ? actor.id : null;
	const topPosition = actor.role === 'team_lead' ? null : topFromPick(input.reportsTo);
	const reportsToChief = topPosition !== null;
	let managerName: string | null = actor.role === 'team_lead' ? actor.fullName : null;
	if (actor.role !== 'team_lead' && input.reportsTo) {
		if (!reportsToChief) {
			if (!UUID.test(input.reportsTo)) return fail('Pick a reporting manager from the list');
			const [m] = await db
				.select({ id: users.id, email: users.email, fullName: users.fullName })
				.from(users)
				.where(and(eq(users.id, input.reportsTo), notHidden))
				.limit(1);
			if (!m) return fail('That reporting manager no longer exists');
			if (blueCollar && isNoLoginEmail(m.email)) {
				return fail(`${m.fullName} has no login either, so they can't look after a blue-collar worker`);
			}
			reportsTo = m.id;
			managerName = m.fullName;
		}
	}
	// Their manager is who opens their portal for them, so they need a person
	// who can sign in: not Chief or Mam, and not nobody.
	if (blueCollar && !reportsTo) return fail('Pick who they report to: their manager opens their portal for them');

	let employeeCode: string | null = null;
	if (input.employeeCode?.trim()) {
		employeeCode = input.employeeCode.trim().toUpperCase();
		const [taken] = await db
			.select({ userId: employeeProfiles.userId })
			.from(employeeProfiles)
			.where(eq(employeeProfiles.employeeCode, employeeCode))
			.limit(1);
		if (taken) return fail(`Employee code ${employeeCode} already belongs to someone`);
	}

	let hrUserId: string | null = null;
	if (input.hrUserId) {
		if (!UUID.test(input.hrUserId)) return fail('Pick a concerned HR from the list');
		const [hr] = await db.select({ id: users.id }).from(users).where(and(eq(users.id, input.hrUserId), notHidden)).limit(1);
		if (!hr) return fail('That HR person no longer exists');
		hrUserId = hr.id;
	}

	const [eligibleGroup] = await db
		.select({ id: shiftGroups.id })
		.from(shiftGroups)
		.innerJoin(holidayCalendars, eq(holidayCalendars.shiftGroupId, shiftGroups.id))
		.where(and(eq(shiftGroups.id, input.shiftGroupId), eq(holidayCalendars.status, 'published')))
		.limit(1);
	if (!eligibleGroup) return fail('Selected shift group has no published holiday calendar');

	if (!blueCollar) {
		const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
		if (existing) return fail('A login with that email already exists');
	}
	const loginEmail = blueCollar ? await freeNoLoginEmail(employeeCode, fullName) : email;

	// With Clerk as the sign-in there is no temporary password: the person signs
	// in with an emailed code and chooses their own (password-state.ts). A
	// blue-collar worker has neither.
	const { temporaryPassword: tempPassword, passwordHash } = blueCollar
		? { temporaryPassword: null, passwordHash: NO_LOGIN }
		: await newLoginCredentials();

	const [created] = await db
		.insert(users)
		.values({
			email: loginEmail,
			passwordHash,
			role,
			customRoleId,
			fullName,
			teamId,
			reportsTo,
			isActive: true,
			mustChangePassword: !blueCollar,
			// Readable on the roster until this person sets their own password,
			// so a mail that never arrives doesn't strand the account.
			temporaryPassword: tempPassword
		})
		.returning();
	if (!blueCollar) await addNewLoginToClerk(created.id, tempPassword);

	await db.insert(employeeProfiles).values({
		userId: created.id,
		shiftGroupId: input.shiftGroupId,
		hrUserId,
		reportsToChief,
		topPosition: topPosition ?? 'chief',
		directReportingAuthority: topPosition ? topLabel(topPosition) : managerName,
		employeeCode
	});
	invalidateCapabilities(created.id);

	// The welcome email waits for an admin to approve it (src/lib/server/
	// login-emails.ts). The password stays in the response: whoever adds a
	// single joiner is often sitting with them.
	if (!blueCollar) await queueLoginEmails([created.id], { source: opts.source ?? 'single', requestedBy: actor.id });

	await logActivity({
		actorUserId: actor.id,
		action: 'user.create',
		targetType: 'user',
		targetId: created.id,
		details: {
			role,
			namedRole: customRoleId ? accessLabel : null,
			teamId,
			shiftGroupId: input.shiftGroupId,
			blueCollar,
			welcomeEmail: blueCollar ? 'none: blue collar, no login' : 'queued for approval'
		}
	});

	return {
		success: true,
		userId: created.id,
		tempPassword,
		email: loginEmail,
		emailSent: false,
		emailError: null,
		emailQueued: !blueCollar,
		blueCollar,
		fullName,
		managerName
	};
}

/** A placeholder address nobody holds yet: the code or name, then .2, .3, ... */
async function freeNoLoginEmail(employeeCode: string | null, fullName: string): Promise<string> {
	const base = noLoginEmail(employeeCode, fullName);
	const [local, domain] = base.split('@');
	for (let n = 1; ; n++) {
		const candidate = n === 1 ? base : `${local}.${n}@${domain}`;
		const [taken] = await db.select({ id: users.id }).from(users).where(eq(users.email, candidate)).limit(1);
		if (!taken) return candidate;
	}
}

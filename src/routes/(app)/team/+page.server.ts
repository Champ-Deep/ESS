import { redirect } from '@sveltejs/kit';
import { isTopReference, topPositionReference, TOP_REFERENCE_SPELLINGS } from '$lib/chief';
import { isNoLoginEmail } from '$lib/no-login';
import { NO_LOGIN } from '$lib/server/password-state';
import { openablePortals } from '$lib/server/act-as';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db/postgres';
import {
	users,
	teams,
	attendance,
	leaveApplications,
	leaveAllocations,
	shiftGroups,
	holidayCalendars,
	employeeProfiles,
	bulkImports,
	bulkImportRows,
	prohanceDays,
	customRoles
} from '$lib/server/db/schema';
import { eq, and, or, inArray, lte, gte, desc, isNotNull, sql } from 'drizzle-orm';
import { hashPassword } from '$lib/server/auth';
import { notHidden } from '$lib/server/hidden-users';
import { addNewLoginToClerk, clerkAuthActive, ensureClerkAccount, mirrorPasswordToClerk, newLoginCredentials } from '$lib/server/clerk';
import { randomBytes } from 'node:crypto';
import { logActivity, getPasswordActivity, getUsersWithProfilePicture } from '$lib/server/db/mongo';
import { canActOnUser } from '$lib/server/rbac';
import { scopeIds } from '$lib/server/org-scope';
import { teamPageAccess } from '$lib/server/team-access';
import { reviewableUserIds } from '$lib/server/approval-chain';
import { hasCap, hasAnyCap, requireCap } from '$lib/server/capabilities';
import { createLogin, creatableBaseRoles } from '$lib/server/logins';
import { syncMembershipFor } from '$lib/server/chat/sync';
import { type Role, type SessionUser } from '$lib/server/auth';
import {
	parseHrTeamSheet,
	suggestReportsToIndex,
	suggestExistingUserMatch,
	looksLikeEmail
} from '$lib/server/bulk-import';
import { profileValuesFromImport } from '$lib/server/import-profile-fields';
import { matchName } from '$lib/server/name-match';
import { ensureLeaveAllocations } from '$lib/server/leave-accrual';
import { currentRosterByUser, loadAssignableRosters } from '$lib/server/week-off';
import { describeRoster, rotationSummary } from '$lib/week-off';
import { isMailerConfigured } from '$lib/server/mailer';
import { pendingCount as pendingLoginEmailCount, queueLoginEmails } from '$lib/server/login-emails';
import { error } from '@sveltejs/kit';

/**
 * Every account created from the master tracker gets its own random temporary
 * password, mailed to that person and to nobody else.
 *
 * A single shared literal used to be hashed for the whole batch, which was
 * survivable only while nothing left the building: once credentials go out by
 * email, one shared password means every new hire is handed a working key to
 * every other new hire's account. `mustChangePassword` still forces a reset on
 * first sign-in, so this value is only ever valid for one login.
 */
function generateTemporaryPassword(): string {
	return randomBytes(9).toString('base64url');
}

/**
 * Fills blank profile columns for someone the import skipped as already
 * existing.
 *
 * An import run before a field was mapped stages that field as null, and
 * re-uploading the same sheet does not repair it: the row matches on email, is
 * marked skipped_existing, and the apply step moves on. The column then stays
 * empty forever — which is how a full roster ended up with no recorded gender,
 * and so no pink-leave eligibility.
 *
 * Only writes where the profile currently has nothing. A value HR corrected in
 * the portal outranks whatever an older spreadsheet says.
 */
async function backfillProfile(
	userId: string,
	row: { employeeCode: string | null; designation: string | null; teamAndFloor: string | null; profileData: unknown }
): Promise<string[]> {
	const [profile] = await db
		.select()
		.from(employeeProfiles)
		.where(eq(employeeProfiles.userId, userId))
		.limit(1);
	if (!profile) return [];

	const incoming: Record<string, unknown> = {
		...profileValuesFromImport(row.profileData as Record<string, unknown> | null),
		...(row.employeeCode ? { employeeCode: row.employeeCode.trim().toUpperCase() } : {}),
		...(row.designation ? { designation: row.designation } : {}),
		...(row.teamAndFloor ? { teamAndFloor: row.teamAndFloor } : {})
	};

	const patch: Record<string, unknown> = {};
	const filled: string[] = [];
	for (const [key, value] of Object.entries(incoming)) {
		if (value === null || value === undefined || value === '') continue;
		const current = (profile as Record<string, unknown>)[key];
		if (current === null || current === undefined || current === '') {
			patch[key] = value;
			filled.push(key);
		}
	}

	if (filled.length === 0) return [];
	patch.updatedAt = new Date();
	await db.update(employeeProfiles).set(patch).where(eq(employeeProfiles.userId, userId));
	return filled;
}

/**
 * Who may read an account's pending temporary password on the roster.
 *
 * Deliberately the same test the admin reset endpoint applies, including its
 * extra rule that a Team Lead may only act on Employees: seeing the credential
 * and being able to replace it should never come apart, or the roster leaks
 * something the viewer has no authority over.
 */
function canViewTemporaryPassword(
	viewer: SessionUser,
	target: { id: string; role: Role; teamId: string | null },
	lineReach?: ReadonlySet<string>
): boolean {
	// A named role holding the reset privilege (IT Support) sees the pending
	// password of the accounts it may reset: Employees and Team Leads.
	if (viewer.role !== 'super_admin' && viewer.role !== 'admin' && hasCap(viewer, 'people.reset_password')) {
		return target.role === 'employee' || target.role === 'team_lead';
	}
	return canEditPersonSettings(viewer, target, lineReach);
}

/**
 * Who may open the settings panel on a given row.
 *
 * The same test the settings endpoint applies, so the roster never offers a
 * panel whose Save would come back 403. A Team Lead reaches the Employees on
 * their own team and themselves — enough to keep their team's shifts, week offs
 * and reporting lines right, and no further. Role is not editable here for
 * anyone but a Super Admin; that is enforced separately, on the field.
 */
function canEditPersonSettings(
	viewer: SessionUser,
	target: { id: string; role: Role; teamId: string | null },
	lineReach?: ReadonlySet<string>
): boolean {
	// Same reach as the settings endpoint's privilege path.
	if (viewer.role !== 'super_admin' && viewer.role !== 'admin' && hasCap(viewer, 'people.edit_settings')) {
		return target.role === 'employee' || target.role === 'team_lead';
	}
	if (!canActOnUser(viewer, target.id, target.teamId, lineReach)) return false;
	if (viewer.role === 'team_lead' && target.role !== 'employee' && target.id !== viewer.id) {
		return false;
	}
	return true;
}

const PASSWORD_ACTION_LABELS: Record<string, string> = {
	'password.change': 'Changed own password',
	'user.password_reset': "Reset another user's password",
	'user.bulk_create': 'Created via bulk import',
	'user.bulk_reissue': 'Re-issued a bulk-import login'
};

export const load: PageServerLoad = async ({ locals }) => {
	const user = locals.user!;
	// Who the page is for (src/lib/server/team-access.ts): Team Leads and up,
	// People privileges, and Employee-role managers, concerned HR or delegates.
	// The roster is additive: the team as before, plus everyone the org scope
	// reaches (reports in other teams, skip-levels, people they are concerned HR
	// for, a covering delegate's people). Nobody loses access.
	const access = await teamPageAccess(user);
	if (!access.allowed) throw redirect(303, '/dashboard');
	const reach = access.reach;
	// Org-wide reach (people.directory, or a privilege opening everyone's job
	// details) lists everyone.
	const seesEveryone = reach === null;
	const roster = seesEveryone
		? await db.select().from(users).where(notHidden)
		: await db
				.select()
				.from(users)
				.where(
					and(
						notHidden,
						// The whole-team half is only what Team Leads already had; an
						// Employee-role manager gets their reports, not their teammates.
						user.role === 'employee'
							? inArray(users.id, reach ?? [user.id])
							: or(eq(users.teamId, user.teamId ?? ''), inArray(users.id, reach ?? [user.id]))
					)
				);

	const today = new Date().toISOString().slice(0, 10);
	const todaysAttendance = await db.select().from(attendance).where(eq(attendance.date, today));
	const attendanceByUser = new Map(todaysAttendance.map((a) => [a.userId, a]));

	// ProHance stands in for people with no attendance record today: a first
	// login with no logout reads as present right now, a logout as left. Same
	// fallback the attendance calendar uses — a real record always wins.
	const todaysProhance = await db
		.select({
			userId: prohanceDays.matchedUserId,
			firstLogin: prohanceDays.firstLogin,
			lastLogout: prohanceDays.lastLogout
		})
		.from(prohanceDays)
		.where(and(eq(prohanceDays.sessionDate, today), isNotNull(prohanceDays.matchedUserId)));
	const prohanceByUser = new Map(
		todaysProhance
			.filter((p): p is typeof p & { userId: string } => Boolean(p.userId))
			.map((p) => [p.userId, p])
	);

	const manageable = await reviewableUserIds(user, 'manager');
	// A Team Lead's edit reach beyond their own team: their direct reports
	// elsewhere (org scope). The settings and password endpoints use the same.
	const lineReach = user.role === 'team_lead' ? new Set((await scopeIds(user, 'person.edit_settings')) ?? []) : undefined;
	const pendingApprovalRows = await db
		.select({ application: leaveApplications, applicant: users })
		.from(leaveApplications)
		.innerJoin(users, eq(leaveApplications.userId, users.id))
		.where(
			// What this person can decide now, per the approval chain.
			and(notHidden, eq(leaveApplications.status, 'pending'), manageable.length ? inArray(leaveApplications.userId, manageable) : sql`false`)
		);

	const year = new Date().getFullYear();
	const rosterIds = roster.map((r) => r.id);
	// Roster balances follow the published policy's accrual, same as the
	// employee-facing pages.
	await ensureLeaveAllocations(rosterIds);
	const allocations =
		rosterIds.length > 0
			? await db
					.select()
					.from(leaveAllocations)
					.where(and(inArray(leaveAllocations.userId, rosterIds), eq(leaveAllocations.year, year)))
			: [];
	const balanceByUser = new Map<string, number>();
	for (const a of allocations) {
		const remaining = Number(a.allocatedDays) - Number(a.usedDays);
		balanceByUser.set(a.userId, (balanceByUser.get(a.userId) ?? 0) + remaining);
	}

	const onLeaveToday =
		rosterIds.length > 0
			? await db
					.select({ userId: leaveApplications.userId })
					.from(leaveApplications)
					.where(
						and(
							inArray(leaveApplications.userId, rosterIds),
							eq(leaveApplications.status, 'approved'),
							lte(leaveApplications.startDate, today),
							gte(leaveApplications.endDate, today)
						)
					)
			: [];

	const creatableRoles = creatableBaseRoles(user);
	// Named roles (IT Support, Operations…) a Super Admin can give at creation.
	const namedRoles = hasCap(user, 'people.assign_roles')
		? await db
				.select({ id: customRoles.id, name: customRoles.name, baseRole: customRoles.baseRole, description: customRoles.description })
				.from(customRoles)
				.orderBy(customRoles.name)
		: [];

	// Only shift groups with a currently-published holiday calendar are offered when
	// creating a login, so every new employee resolves to a real calendar immediately.
	const groupsWithPublishedCalendar = await db
		.selectDistinct({ id: shiftGroups.id, name: shiftGroups.name })
		.from(shiftGroups)
		.innerJoin(holidayCalendars, eq(holidayCalendars.shiftGroupId, shiftGroups.id))
		.where(eq(holidayCalendars.status, 'published'));

	// Every shift group, not just those with a published calendar. Assignment on
	// an existing employee has to be possible before the calendar exists —
	// otherwise a group can never be populated in the first place.
	const allShiftGroups = await db
		.select({ id: shiftGroups.id, name: shiftGroups.name })
		.from(shiftGroups)
		.orderBy(shiftGroups.name);

	// Employee code is the portal-wide identity key — every roster row carries it.
	// Shift group rides along: it drives holiday-calendar resolution, so HR needs
	// to see at a glance who is still unassigned.
	const rosterIdsForCode = roster.map((r) => r.id);
	const codeRows =
		rosterIdsForCode.length > 0
			? await db
					.select({
						userId: employeeProfiles.userId,
						employeeCode: employeeProfiles.employeeCode,
						shiftGroupId: employeeProfiles.shiftGroupId,
						hrUserId: employeeProfiles.hrUserId,
						reportsToChief: employeeProfiles.reportsToChief,
						topPosition: employeeProfiles.topPosition,
						officeTimings: employeeProfiles.officeTimings,
						shiftType: employeeProfiles.shiftType
					})
					.from(employeeProfiles)
					.where(inArray(employeeProfiles.userId, rosterIdsForCode))
			: [];
	const codeByUser = new Map(codeRows.map((r) => [r.userId, r.employeeCode]));
	const shiftByUser = new Map(codeRows.map((r) => [r.userId, r.shiftGroupId]));
	const profileByUser = new Map(codeRows.map((r) => [r.userId, r]));

	// Blue-collar workers (src/lib/no-login.ts) can't keep their own profile,
	// so whoever may open their portal — their leaders, and HR — sees the
	// details looking after them takes (src/lib/act-as.ts). Job, contact and
	// emergency details only: government IDs and bank details stay with HR.
	const portalIds = await openablePortals(user, roster);
	const detailIds = [...portalIds];
	const detailRows =
		detailIds.length > 0
			? await db
					.select({
						userId: employeeProfiles.userId,
						designation: employeeProfiles.designation,
						department: employeeProfiles.subProcessDepartment,
						teamAndFloor: employeeProfiles.teamAndFloor,
						dateOfJoining: employeeProfiles.dateOfJoining,
						phone: employeeProfiles.phone,
						gender: employeeProfiles.gender,
						dateOfBirth: employeeProfiles.dobActual,
						dobDocuments: employeeProfiles.dobDocuments,
						bloodGroup: employeeProfiles.bloodGroup,
						address: employeeProfiles.address,
						permanentAddress: employeeProfiles.permanentAddress,
						emergencyContactName: employeeProfiles.emergencyContactName,
						emergencyContactRelationship: employeeProfiles.emergencyContactRelationship,
						emergencyContactPhone: employeeProfiles.emergencyContactPhone
					})
					.from(employeeProfiles)
					.where(inArray(employeeProfiles.userId, detailIds))
			: [];
	const detailsByUser = new Map(
		detailRows.map(({ userId, dobDocuments, ...d }) => [userId, { ...d, dateOfBirth: d.dateOfBirth ?? dobDocuments }])
	);
	const shiftGroupNameById = new Map(allShiftGroups.map((g) => [g.id, g.name]));
	// Names for the reporting-manager and HR columns. Drawn from every user, not
	// just this roster, because a manager can sit outside the team being viewed.
	const allPeople = await db
		.select({ id: users.id, fullName: users.fullName, role: users.role, teamId: users.teamId, email: users.email })
		.from(users)
		.where(and(eq(users.isActive, true), notHidden))
		.orderBy(users.fullName);
	const nameById = new Map(allPeople.map((p) => [p.id, p.fullName]));

	// The manager/HR pickers in the settings panel. A Team Lead may only point a
	// reporting line inside their own team, so offering them the whole company
	// would be offering choices Save is going to reject.
	const assignablePeople = (
		user.role === 'team_lead' ? allPeople.filter((p) => p.teamId === user.teamId) : allPeople
	).map((p) => ({ id: p.id, fullName: p.fullName, role: p.role, noLogin: isNoLoginEmail(p.email) }));

	// One query for the whole roster — avoids an <img> request per row for
	// employees who have no picture.
	const withPictures = await getUsersWithProfilePicture(rosterIdsForCode);

	// Week-off roster in force today, per employee. Nobody assigned a roster
	// falls back to Saturday + Sunday, which is what the column shows for them.
	const weekOffByUser = await currentRosterByUser(rosterIdsForCode, today);

	// The rosters this actor may actually apply — a team lead sees org-wide and
	// own-team published rosters; a Super Admin sees drafts too.
	const weekOffRosterRows = await loadAssignableRosters(user);
	const weekOffRosterOptions = weekOffRosterRows.map((r) => ({
		id: r.id,
		name: r.name,
		description: r.description,
		pattern: r.pattern,
		weekdays: r.weekdays ?? null,
		rotationWeeks: r.rotationWeeks ?? null,
		rotationAnchorDate: r.rotationAnchorDate ?? null,
		teamId: r.teamId,
		status: r.status,
		summary: describeRoster({
			id: r.id,
			name: r.name,
			pattern: r.pattern,
			weekdays: r.weekdays ?? null,
			rotationWeeks: r.rotationWeeks ?? null,
			rotationAnchorDate: r.rotationAnchorDate ?? null
		}),
		weeks: rotationSummary({
			id: r.id,
			name: r.name,
			pattern: r.pattern,
			weekdays: r.weekdays ?? null,
			rotationWeeks: r.rotationWeeks ?? null,
			rotationAnchorDate: r.rotationAnchorDate ?? null
		})
	}));

	// Names of the named roles on this roster, for the role column and panel.
	const namedRoleName = new Map(
		(await db.select({ id: customRoles.id, name: customRoles.name }).from(customRoles)).map((r) => [r.id, r.name])
	);

	const rosterWithStatus = roster.map((r) => ({
		id: r.id,
		fullName: r.fullName,
		email: r.email,
		noLogin: isNoLoginEmail(r.email),
		// Null unless this viewer looks after them (see detailsByUser).
		details: detailsByUser.get(r.id) ?? null,
		canOpenPortal: portalIds.has(r.id),
		employeeCode: codeByUser.get(r.id) ?? null,
		shiftGroupId: shiftByUser.get(r.id) ?? null,
		shiftGroupName: shiftGroupNameById.get(shiftByUser.get(r.id) ?? '') ?? null,
		hasPicture: withPictures.has(r.id),
		reportsTo: r.reportsTo,
		reportsToName: r.reportsTo ? (nameById.get(r.reportsTo) ?? null) : null,
		reportsToChief: !r.reportsTo && Boolean(profileByUser.get(r.id)?.reportsToChief),
		topPosition: profileByUser.get(r.id)?.topPosition ?? 'chief',
		hrUserId: profileByUser.get(r.id)?.hrUserId ?? null,
		hrName: profileByUser.get(r.id)?.hrUserId
			? (nameById.get(profileByUser.get(r.id)!.hrUserId!) ?? null)
			: null,
		officeTimings: profileByUser.get(r.id)?.officeTimings ?? null,
		shiftType: profileByUser.get(r.id)?.shiftType ?? null,
		weekOffRosterId: weekOffByUser.get(r.id)?.rosterId ?? null,
		weekOffName: weekOffByUser.get(r.id)?.name ?? null,
		weekOffSummary: weekOffByUser.get(r.id)?.summary ?? 'Every Sat + Sun',
		role: r.role,
		customRoleId: r.customRoleId,
		customRoleName: r.customRoleId ? (namedRoleName.get(r.customRoleId) ?? null) : null,
		isActive: r.isActive,
		// The pending temporary password, for people who haven't signed in and set
		// their own yet. Shown only for accounts this viewer could already reset —
		// the same authorization the reset endpoint applies — so it never hands a
		// Team Lead a credential they couldn't replace anyway. Null the instant the
		// person changes their password.
		temporaryPassword: canViewTemporaryPassword(user, r, lineReach) ? r.temporaryPassword : null,
		// Whether this viewer may open the settings panel on this row. Decided
		// here rather than from a blanket isSuperAdmin so a Team Lead is offered
		// exactly the rows the settings endpoint will actually accept.
		canEditSettings: canEditPersonSettings(user, r, lineReach),
		leaveLeft: balanceByUser.get(r.id) ?? 0,
		status: attendanceByUser.get(r.id)?.checkInAt
			? attendanceByUser.get(r.id)?.checkOutAt
				? 'left'
				: 'present'
			: prohanceByUser.get(r.id)?.firstLogin
				? prohanceByUser.get(r.id)?.lastLogout
					? 'left'
					: 'present'
				: 'absent'
	}));

	let bulkImportsList: Array<{
		id: string;
		filename: string;
		status: 'pending_review' | 'applied';
		rowCount: number;
		createdAt: Date;
	}> = [];
	let passwordActivity: Array<{
		label: string;
		actorName: string | null;
		targetName: string | null;
		targetEmail: string | null;
		createdAt: Date;
	}> = [];

	if (hasCap(user, 'people.bulk_import')) {
		bulkImportsList = await db
			.select({
				id: bulkImports.id,
				filename: bulkImports.filename,
				status: bulkImports.status,
				rowCount: bulkImports.rowCount,
				createdAt: bulkImports.createdAt
			})
			.from(bulkImports)
			.orderBy(desc(bulkImports.createdAt));
	}

	if (hasCap(user, 'people.password_activity')) {
		const entries = await getPasswordActivity();
		const involvedIds = [
			...new Set(entries.flatMap((e) => [e.actorUserId, e.targetId].filter((id): id is string => Boolean(id))))
		];
		const involvedUsers =
			involvedIds.length > 0
				? await db.select({ id: users.id, fullName: users.fullName, email: users.email }).from(users).where(and(inArray(users.id, involvedIds), notHidden))
				: [];
		const byId = new Map(involvedUsers.map((u) => [u.id, u]));

		passwordActivity = entries.map((e) => ({
			label: PASSWORD_ACTION_LABELS[e.action] ?? e.action,
			actorName: byId.get(e.actorUserId)?.fullName ?? null,
			targetName: e.targetId ? byId.get(e.targetId)?.fullName ?? null : null,
			targetEmail: (e.details?.email as string | undefined) ?? null,
			createdAt: e.createdAt
		}));
	}

	return {
		roster: rosterWithStatus,
		teamSize: rosterWithStatus.length,
		presentNow: rosterWithStatus.filter((r) => r.status === 'present').length,
		onLeave: new Set(onLeaveToday.map((r) => r.userId)).size,
		pendingApprovals: pendingApprovalRows.length,
		creatableRoles,
		namedRoles,
		canCreateLogin: user.role === 'team_lead' || hasCap(user, 'people.create_login'),
		canBulkImport: hasCap(user, 'people.bulk_import'),
		canApproveLogins: hasCap(user, 'people.send_logins'),
		pendingLoginEmails: hasCap(user, 'people.send_logins') ? await pendingLoginEmailCount() : 0,
		canSeePasswordActivity: hasCap(user, 'people.password_activity'),
		canDeletePeople: hasCap(user, 'people.delete'),
		canAuthorRosters: hasCap(user, 'leave.week_off_rosters'),
		// People who can be someone's concerned HR: the HR roles.
		hrPeople: allPeople
			.filter((p) => p.role === 'admin' || p.role === 'super_admin')
			.map((p) => ({ id: p.id, fullName: p.fullName })),
		teamLeadTeamId: user.role === 'team_lead' ? user.teamId : null,
		shiftGroups: groupsWithPublishedCalendar,
		allShiftGroups,
		weekOffRosters: weekOffRosterOptions,
		// Candidates for the reporting-manager and HR pickers in the person panel.
		allPeople: assignablePeople,
		// A roster can be scoped to one team, so the author needs the list.
		allTeams:
			user.role === 'team_lead'
				? []
				: await db.select({ id: teams.id, name: teams.name }).from(teams).orderBy(teams.name),
		// Team leads assign rosters but don't author them. Employees never reach
		// this page at all — the load redirects them above.
		canAssignWeekOff: true,
		isSuperAdmin: user.role === 'super_admin',
		// Reporting to Chief or Mam moves approvals to HR, so it is an admin's call.
		canPickChief: user.role === 'super_admin' || user.role === 'admin',
		// The roster hides the delete control on your own row; the API refuses it too.
		currentUserId: user.id,
		bulkImports: bulkImportsList,
		passwordActivity
	};
};

export const actions: Actions = {
	createEmployee: async (event) => {
		const actor = event.locals.user;
		if (!actor) return { success: false, message: 'Sign in again to continue' };
		const form = await event.request.formData();
		const str = (k: string) => String(form.get(k) ?? '').trim();
		// Older clients post a bare `role`; the form now posts `access`.
		const access = str('access') || `base:${str('role') || 'employee'}`;
		const result = await createLogin(actor, {
			email: str('email'),
			fullName: str('fullName'),
			access,
			shiftGroupId: str('shiftGroupId'),
			teamId: str('teamId') || null,
			reportsTo: str('reportsTo') || null,
			hrUserId: str('hrUserId') || null,
			// Asked only when the email is left blank (src/lib/no-login.ts).
			blueCollar: str('blueCollar') === 'true',
			employeeCode: str('employeeCode') || null
		});
		if (result.success) {
			// Straight into their team and shift channels in Champ Chat.
			void syncMembershipFor(result.userId).catch((err) => console.error('[chat] sync failed:', err));
			const { userId: _id, ...rest } = result;
			return rest;
		}
		return result;
	},

	// Super Admin uploads a spreadsheet with the "HR Team Master data" sheet shape.
	// Parsed immediately into bulk_import_rows for review — nothing touches `users`
	// yet (see applyBulkImport below).
	uploadBulkImport: async (event) => {
		const actor = requireCap(event, 'people.bulk_import');
		const form = await event.request.formData();
		const file = form.get('file');
		// "Replace file" names the import under review it takes the place of;
		// "Upload another" leaves it out, and both stay up for review.
		const replaceImportId = String(form.get('replaceImportId') ?? '');

		if (!(file instanceof File) || file.size === 0) {
			return { bulkImportError: 'Choose an .xlsx file to upload' };
		}
		if (file.size > 5 * 1024 * 1024) {
			return { bulkImportError: 'File too large (max 5MB)' };
		}

		const buffer = Buffer.from(await file.arrayBuffer());

		let parseResult;
		try {
			parseResult = await parseHrTeamSheet(buffer);
		} catch (err) {
			return { bulkImportError: err instanceof Error ? err.message : 'Failed to parse workbook' };
		}
		const parsedRows = parseResult.rows;
		if (parsedRows.length === 0) {
			return {
				bulkImportError: `No employee rows found in "${parseResult.sheetName}" — every row needs at least a name, and a work email or a reporting manager.`
			};
		}

		const emails = parsedRows.map((r) => r.officialEmail);
		const existingByEmailRows = await db
			.select({ id: users.id, email: users.email })
			.from(users)
			.where(inArray(users.email, emails));
		const existingByEmail = new Map(existingByEmailRows.map((u) => [u.email, u.id]));

		// Full-name cross-check against ALL existing users, not just email matches — catches
		// the case where the sheet lists a different email for someone who already has a
		// real login (e.g. their actual account uses a different domain). Surfaced as a
		// review flag rather than silently creating a duplicate account for the same person.
		const allExistingUsers = await db.select({ id: users.id, fullName: users.fullName, email: users.email }).from(users).where(notHidden);

		// The employee code is unique and is the attendance join key, so a code
		// already taken by someone else has to be caught before apply — otherwise
		// the insert fails mid-batch and leaves the import half-applied.
		const sheetCodes = parsedRows
			.map((r) => r.employeeCode?.trim().toUpperCase())
			.filter((c): c is string => Boolean(c));
		const takenCodeRows =
			sheetCodes.length > 0
				? await db
						.select({ userId: employeeProfiles.userId, code: employeeProfiles.employeeCode })
						.from(employeeProfiles)
						.where(inArray(employeeProfiles.employeeCode, sheetCodes))
				: [];
		const takenCodes = new Map(
			takenCodeRows
				.filter((r): r is { userId: string; code: string } => Boolean(r.code))
				.map((r) => [r.code, r.userId])
		);

		const [importRow] = await db
			.insert(bulkImports)
			.values({ filename: file.name, uploadedBy: actor.id, rowCount: parsedRows.length })
			.returning();

		// Two rows in the same sheet claiming one address pass every check above —
		// neither is in `users` yet — and then collide on the unique email index
		// halfway through apply, leaving accounts created, credentials mailed, and
		// the import stuck part-applied. Caught here for the same reason duplicate
		// employee codes are.
		const seenInSheet = new Set<string>();

		const insertedRows = await db
			.insert(bulkImportRows)
			.values(
				parsedRows.map((r, rowIndex) => {
					const emailMatchId = existingByEmail.get(r.officialEmail) ?? null;
					const nameMatch = emailMatchId ? null : suggestExistingUserMatch(r.fullName, allExistingUsers);
					const code = r.employeeCode?.trim().toUpperCase() ?? null;
					const codeOwner = code ? takenCodes.get(code) : undefined;

					const duplicateInSheet = seenInSheet.has(r.officialEmail);
					seenInSheet.add(r.officialEmail);
					// The login id has to be an actual address — the portal
					// authenticates by email, so anything else creates an account its
					// owner can never sign in to, whatever password is mailed out.
					const emailUsable = looksLikeEmail(r.officialEmail);

					let status: 'ready' | 'needs_review' | 'skipped_existing' = 'ready';
					if (emailMatchId) status = 'skipped_existing';
					// Both of these produce an unusable login rather than a merely
					// questionable one, so they outrank the softer name/code flags.
					else if (!emailUsable || duplicateInSheet) status = 'needs_review';
					else if (nameMatch) status = 'needs_review';
					// A code already held by someone else can't be applied as-is.
					else if (codeOwner) status = 'needs_review';
					// No work email: someone has to say they are blue collar, and give
					// them a manager, before the row can be created.
					else if (isNoLoginEmail(r.officialEmail)) status = 'needs_review';

					const notes = [
						...(parseResult.repairs[rowIndex] ?? []),
						...(duplicateInSheet
							? [`officialEmail "${r.officialEmail}" is used by an earlier row in this sheet`]
							: [])
					];

					// Everything beyond the columns needed to create the login is
					// carried as-is and written to the profile on apply.
					const {
						fullName,
						officialEmail,
						designation,
						teamAndFloor,
						reportingAuthorityRaw,
						dottedLineAuthorityRaw,
						employeeCode: _code,
						bankRegionRaw: _bankRegionRaw,
						...profileData
					} = r;

					return {
						importId: importRow.id,
						employeeCode: code,
						fullName,
						designation,
						officialEmail,
						teamAndFloor,
						reportingAuthorityRaw,
						dottedLineAuthorityRaw,
						profileData,
						repairNotes: notes.length > 0 ? notes : null,
						existingUserId: emailMatchId ?? nameMatch?.id ?? null,
						status
					};
				})
			)
			.returning();

		for (let i = 0; i < parsedRows.length; i++) {
			const suggestedIndex = suggestReportsToIndex(parsedRows[i].reportingAuthorityRaw, parsedRows, i);
			const hasRawAuthority = Boolean(parsedRows[i].reportingAuthorityRaw);
			// "Chief" or "Mam" is not a row to find: it is recorded as reporting to that position.
			const needsReviewForReportingLine =
				hasRawAuthority && suggestedIndex === null && !isTopReference(parsedRows[i].reportingAuthorityRaw);
			const alreadyDecided = insertedRows[i].status !== 'ready';

			if (suggestedIndex !== null || (needsReviewForReportingLine && !alreadyDecided)) {
				await db
					.update(bulkImportRows)
					.set({
						reportsToRowId: suggestedIndex !== null ? insertedRows[suggestedIndex].id : null,
						status: needsReviewForReportingLine && !alreadyDecided ? 'needs_review' : insertedRows[i].status
					})
					.where(eq(bulkImportRows.id, insertedRows[i].id));
			}
		}

		// The preview shows the access they will get: anyone the sheet puts under
		// Chief or Mam, or whom another row reports to, is a Team Lead — the same rule the
		// database applies to live logins (drizzle/0030_auto_team_lead.sql). Only
		// Employees move; the Role column stays editable before applying.
		await db
			.update(bulkImportRows)
			.set({ role: 'team_lead' })
			.where(
				and(
					eq(bulkImportRows.importId, importRow.id),
					eq(bulkImportRows.role, 'employee'),
					sql`(${bulkImportRows.id} in (select reports_to_row_id from bulk_import_rows where import_id = ${importRow.id} and reports_to_row_id is not null)
						or lower(trim(${bulkImportRows.reportingAuthorityRaw})) in (${sql.join(TOP_REFERENCE_SPELLINGS.map((t) => sql`${t}`), sql`, `)}))`
				)
			);

		// The replaced sheet goes only once its successor parsed, and only while
		// it is still unapplied: an applied import is the record of who was made.
		let replaced: string | null = null;
		if (/^[0-9a-f-]{36}$/i.test(replaceImportId) && replaceImportId !== importRow.id) {
			replaced = await db.transaction(async (tx) => {
				const [old] = await tx
					.select({ id: bulkImports.id, filename: bulkImports.filename })
					.from(bulkImports)
					.where(and(eq(bulkImports.id, replaceImportId), eq(bulkImports.status, 'pending_review')))
					.limit(1);
				if (!old) return null;
				await tx.delete(bulkImportRows).where(eq(bulkImportRows.importId, old.id));
				await tx.delete(bulkImports).where(eq(bulkImports.id, old.id));
				return old.filename;
			});
		}

		await logActivity({
			actorUserId: actor.id,
			action: 'bulk_import.upload',
			targetType: 'bulk_import',
			targetId: importRow.id,
			details: {
				filename: file.name,
				rowCount: parsedRows.length,
				// How the columns were interpreted — worth auditing when the
				// mapping was decided by the model rather than known headers.
				sheetName: parseResult.sheetName,
				strategy: parseResult.strategy,
				note: parseResult.note,
				replaced
			}
		});

		return {
			bulkImportUploaded: importRow.id,
			bulkImportSheet: parseResult.sheetName,
			bulkImportStrategy: parseResult.strategy,
			bulkImportNote: parseResult.note
		};
	},

	// Creates one `users` row (+ employeeProfiles, + a team if the row is a team_lead)
	// per "ready" row in the given import. Refuses if any row still needs review.
	applyBulkImport: async (event) => {
		const actor = requireCap(event, 'people.bulk_import');
		const form = await event.request.formData();
		const importId = String(form.get('importId') ?? '');
		if (!importId) return { bulkImportError: 'Missing importId' };

		const [importRow] = await db.select().from(bulkImports).where(eq(bulkImports.id, importId)).limit(1);
		if (!importRow) throw error(404, 'Import not found');
		if (importRow.status === 'applied') {
			return { bulkImportError: 'This import has already been applied' };
		}

		const rows = await db.select().from(bulkImportRows).where(eq(bulkImportRows.importId, importId));
		const pending = rows.filter((r) => r.status === 'needs_review');
		if (pending.length > 0) {
			return { bulkImportError: `${pending.length} row(s) still need review before this import can be applied` };
		}
		// The review screen keeps these on the list; checked again here because a
		// no-login account nobody looks after would be unreachable.
		const unconfirmed = rows.filter((r) => r.status === 'ready' && isNoLoginEmail(r.officialEmail) && (!r.blueCollar || !r.reportsToRowId));
		if (unconfirmed.length > 0) {
			return { bulkImportError: `${unconfirmed.length} row(s) have no work email: confirm each as blue collar with a reporting manager, or add an email` };
		}

		// When set, every credentials mail for this run goes to this one address
		// instead of to the employees — for verifying the template and the Resend
		// setup against a real inbox without mailing the actual roster.
		const redirectAllMailTo = String(form.get('sendCredentialsTo') ?? '').trim().toLowerCase();

		const rowIdToUserId = new Map<string, string>();
		// Existing people whose blank profile columns this run filled in.
		let backfilledCount = 0;
		// Credentials handover, reported back so the Super Admin can see who still
		// needs their login passed on by hand. The password travels with the
		// failure: a hash is one-way, so if the only copy of the plaintext went out
		// with a mail that never landed, that account is stranded — nobody, Super
		// Admin included, can say what it is. Carried only for the sends that
		// actually failed, and only to the person who just ran the import.
		const emailFailures: { email: string; error: string; temporaryPassword: string | null }[] = [];
		const emailedCount = 0;
		const queuedUserIds: string[] = [];

		for (const row of rows) {
			if (row.status === 'skipped_existing') {
				if (row.existingUserId) {
					rowIdToUserId.set(row.id, row.existingUserId);
					// The account already exists, but its profile may not have been
					// filled — an import run before a field was mapped leaves that
					// column null forever, since re-uploading only ever skips the row.
					// Fills blanks only: a value HR has since corrected in the portal
					// is never overwritten by an older spreadsheet.
					const filled = await backfillProfile(row.existingUserId, row);
					if (filled.length > 0) backfilledCount++;
				}
				continue;
			}
			if (row.status !== 'ready') continue;

			// Hashed per row, not once per batch: each person gets their own
			// password, so each needs its own hash. Argon2 at these parameters costs
			// roughly 50ms, which is the dominant per-row cost of a large import.
			// With Clerk as the sign-in nobody is given one: they sign in with an
			// emailed code and choose their own (password-state.ts).
			// No work email (src/lib/no-login.ts): on the roster, never a login.
			const noLogin = isNoLoginEmail(row.officialEmail);
			const { temporaryPassword, passwordHash } = noLogin
				? { temporaryPassword: null, passwordHash: NO_LOGIN }
				: await newLoginCredentials();

			const [createdUser] = await db
				.insert(users)
				.values({
					email: row.officialEmail,
					passwordHash,
					role: row.role,
					fullName: row.fullName,
					isActive: true,
					mustChangePassword: !noLogin,
					// Kept readable on the roster until this person signs in and
					// chooses their own. A master-tracker batch is exactly where the
					// credentials mail goes wrong at scale, and re-running the import
					// cannot re-issue a row it has already created.
					temporaryPassword
				})
				.returning();

			rowIdToUserId.set(row.id, createdUser.id);
			// One bad address must not stop the rest of the batch; whoever is
			// missing from Clerk is picked up by scripts/migrate-to-clerk.ts.
			if (!noLogin) {
				await addNewLoginToClerk(createdUser.id, temporaryPassword).catch((err) =>
					console.error('[clerk] bulk create sync failed for', createdUser.email, err)
				);
			}

			await db.insert(employeeProfiles).values({
				userId: createdUser.id,
				// The employee code is the portal-wide identity key and the join key
				// for EasyTime Pro attendance — persist it, don't just display it.
				employeeCode: row.employeeCode ? row.employeeCode.trim().toUpperCase() : null,
				designation: row.designation,
				teamAndFloor: row.teamAndFloor,
				directReportingAuthority: row.reportingAuthorityRaw,
				// "Chief" or "Mam" in the sheet is a head of the company, not a
				// person to link — recorded as a flag so approvals go straight to HR.
				reportsToChief: !row.reportsToRowId && isTopReference(row.reportingAuthorityRaw),
				topPosition: topPositionReference(row.reportingAuthorityRaw) ?? 'chief',
				dottedLineReportingAuthority: row.dottedLineAuthorityRaw,
				// Everything else the spreadsheet carried.
				...profileValuesFromImport(row.profileData)
			});

			await db.update(bulkImportRows).set({ status: 'created', createdUserId: createdUser.id }).where(eq(bulkImportRows.id, row.id));

			// The credentials email is not sent here: it is queued after the loop and
			// waits for an admin's approval (src/lib/server/login-emails.ts).
			if (!noLogin) queuedUserIds.push(createdUser.id);

			await logActivity({
				actorUserId: actor.id,
				action: 'user.bulk_create',
				targetType: 'user',
				targetId: createdUser.id,
				// The password itself is never logged — only whether its delivery
				// worked, which is what an operator needs to chase a missing login.
				details: {
					email: createdUser.email,
					importId,
					role: row.role,
					welcomeEmail: noLogin ? 'none: no login' : 'queued for approval',
					welcomeEmailRedirectedTo: redirectAllMailTo || null
				}
			});
		}
		const queuedCount = await queueLoginEmails(queuedUserIds, { source: 'bulk', requestedBy: actor.id, importId, sendTo: redirectAllMailTo || null });

		for (const row of rows) {
			if (row.status !== 'ready') continue;
			const userId = rowIdToUserId.get(row.id);
			if (!userId) continue;

			const managerUserId = row.reportsToRowId ? rowIdToUserId.get(row.reportsToRowId) ?? null : null;

			let teamId: string | null = null;
			if (row.role === 'team_lead') {
				const [team] = await db.insert(teams).values({ name: `${row.fullName}'s Team`, teamLeadId: userId }).returning();
				teamId = team.id;
			}

			await db.update(users).set({ reportsTo: managerUserId, teamId }).where(eq(users.id, userId));
		}

		for (const row of rows) {
			if (row.status !== 'ready' || row.role === 'team_lead') continue;
			const userId = rowIdToUserId.get(row.id);
			const managerUserId = row.reportsToRowId ? rowIdToUserId.get(row.reportsToRowId) ?? null : null;
			if (!userId || !managerUserId) continue;

			const [manager] = await db.select({ teamId: users.teamId }).from(users).where(eq(users.id, managerUserId)).limit(1);
			if (manager?.teamId) {
				await db.update(users).set({ teamId: manager.teamId }).where(eq(users.id, userId));
			}
		}

		// Resolve dotted-line managers against everyone now in the portal, not
		// just this batch — the dotted line often points at someone senior who was
		// already onboarded. Unresolvable names (people outside the roster, or a
		// title like "Chief") keep their raw text and simply carry no code.
		const allUsers = await db.select({ id: users.id, fullName: users.fullName }).from(users).where(notHidden);
		const candidates = allUsers.map((u) => ({ key: u.id, fullName: u.fullName }));

		for (const row of rows) {
			if (row.status !== 'ready' || !row.dottedLineAuthorityRaw) continue;
			const userId = rowIdToUserId.get(row.id);
			if (!userId) continue;

			const result = matchName(row.dottedLineAuthorityRaw, candidates);
			if (result.status !== 'matched' || result.key === userId) continue;

			await db
				.update(employeeProfiles)
				.set({ dottedLineManagerId: result.key })
				.where(eq(employeeProfiles.userId, userId));
		}

		const createdCount = rows.filter((r) => r.status === 'ready').length;
		const skippedCount = rows.filter((r) => r.status === 'skipped_existing').length;

		await db.update(bulkImports).set({ status: 'applied', appliedAt: new Date() }).where(eq(bulkImports.id, importId));

		await logActivity({
			actorUserId: actor.id,
			action: 'bulk_import.apply',
			targetType: 'bulk_import',
			targetId: importId,
			details: {
				createdCount,
				skippedCount,
				backfilledCount,
				emailedCount,
				emailFailedCount: emailFailures.length
			}
		});

		return {
			bulkImportApplied: {
				createdCount,
				skippedCount,
				backfilledCount,
				emailedCount,
				queuedCount,
				// Listed rather than counted: the point of surfacing these is telling
				// HR exactly whose login still needs delivering by hand.
				emailFailures,
				mailerConfigured: isMailerConfigured(),
				redirectedTo: redirectAllMailTo || null
			}
		};
	},

	// Re-issues the logins an already-applied import created.
	//
	// A temporary password exists as plaintext for exactly as long as the apply
	// loop holds it — after that there is only an argon2 hash, so there is nothing
	// to "re-send". These accounts get a NEW temporary password and the credentials
	// mail goes out again.
	//
	// Needed whenever the first handover didn't reach people: a batch that outran
	// Resend's rate limit, a run made before the sending domain was verified, or an
	// import whose email column parsed wrong, where the original mail was addressed
	// to something that was never a mailbox. In every one of those cases the
	// account exists, the person has a password they were told to use, and it does
	// not work — re-running the import can't help, because its rows are `created`.
	//
	// Anyone who has already set their own password is skipped. They are
	// demonstrably not stuck, and resetting them would lock out precisely the
	// people the import worked for.
	resendBulkImportLogins: async (event) => {
		const actor = requireCap(event, 'people.bulk_import');
		const form = await event.request.formData();
		const importId = String(form.get('importId') ?? '');
		if (!importId) return { bulkImportError: 'Missing importId' };

		const [importRow] = await db.select().from(bulkImports).where(eq(bulkImports.id, importId)).limit(1);
		if (!importRow) throw error(404, 'Import not found');

		// Same dry-run escape hatch as apply: route the whole batch to one reviewer
		// instead of to the employees.
		const redirectAllMailTo = String(form.get('sendCredentialsTo') ?? '').trim().toLowerCase();

		const createdRows = await db
			.select({ createdUserId: bulkImportRows.createdUserId })
			.from(bulkImportRows)
			.where(and(eq(bulkImportRows.importId, importId), eq(bulkImportRows.status, 'created')));

		const createdUserIds = createdRows
			.map((r) => r.createdUserId)
			.filter((id): id is string => Boolean(id));

		if (createdUserIds.length === 0) {
			return { bulkImportError: 'This import created no logins, so there is nothing to re-issue' };
		}

		const accounts = await db.select().from(users).where(inArray(users.id, createdUserIds));

		let reissuedCount = 0;
		const emailedCount = 0;
		const queuedUserIds: string[] = [];
		// People who already signed in and chose their own password. Left untouched.
		let alreadyOnboardedCount = 0;
		let inactiveCount = 0;
		const emailFailures: { email: string; error: string; temporaryPassword: string | null }[] = [];

		for (const account of accounts) {
			if (!account.mustChangePassword) {
				alreadyOnboardedCount++;
				continue;
			}
			if (!account.isActive) {
				inactiveCount++;
				continue;
			}

			// With Clerk as the sign-in there is no password to re-issue: the login
			// email goes out again and the person signs in with an emailed code.
			const clerkSignIn = clerkAuthActive();
			const temporaryPassword = clerkSignIn ? null : generateTemporaryPassword();
			if (temporaryPassword) {
				const passwordHash = await hashPassword(temporaryPassword);
				await db
					.update(users)
					.set({
						passwordHash,
						mustChangePassword: true,
						temporaryPassword,
						updatedAt: new Date()
					})
					.where(eq(users.id, account.id));
				await mirrorPasswordToClerk(account.id, temporaryPassword, { signOutOtherSessions: true }).catch((err) =>
					console.error('[clerk] reissue sync failed for', account.email, err)
				);
			} else {
				await ensureClerkAccount(account.id);
			}
			reissuedCount++;

			// An account whose login id isn't an address can't be mailed — and can't
			// be signed in to either, which is usually why this button was pressed.
			// Reported with its password so the operator can correct the address on
			// the roster and hand the login over meanwhile. Everyone else's email is
			// queued for an admin to approve.
			const deliverTo = redirectAllMailTo || (looksLikeEmail(account.email) ? account.email : null);
			if (deliverTo) queuedUserIds.push(account.id);
			else
				emailFailures.push({
					email: account.email,
					error: temporaryPassword
						? `"${account.email}" is not an email address — correct it on the roster, then pass this password on directly`
						: `"${account.email}" is not an email address — correct it on the roster; they sign in with a code sent to that address`,
					temporaryPassword
				});

			await logActivity({
				actorUserId: actor.id,
				action: 'user.bulk_reissue',
				targetType: 'user',
				targetId: account.id,
				details: {
					email: account.email,
					importId,
					welcomeEmail: deliverTo ? 'queued for approval' : 'not an email address',
					welcomeEmailRedirectedTo: redirectAllMailTo || null
				}
			});
		}

		const queuedCount = await queueLoginEmails(queuedUserIds, { source: 'reissue', requestedBy: actor.id, importId, sendTo: redirectAllMailTo || null });

		await logActivity({
			actorUserId: actor.id,
			action: 'bulk_import.reissue',
			targetType: 'bulk_import',
			targetId: importId,
			details: {
				reissuedCount,
				emailedCount,
				alreadyOnboardedCount,
				inactiveCount,
				emailFailedCount: emailFailures.length
			}
		});

		return {
			bulkImportReissued: {
				reissuedCount,
				emailedCount,
				queuedCount,
				alreadyOnboardedCount,
				inactiveCount,
				emailFailures,
				mailerConfigured: isMailerConfigured(),
				redirectedTo: redirectAllMailTo || null
			}
		};
	}
};

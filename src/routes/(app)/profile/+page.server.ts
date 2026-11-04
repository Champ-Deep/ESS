import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db/postgres';
import { employeeProfiles, users } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { logActivity, getProfilePicture } from '$lib/server/db/mongo';
import { resolveManagers } from '$lib/server/managers';

export const load: PageServerLoad = async ({ locals }) => {
	const user = locals.user!;

	const [profile] = await db
		.select()
		.from(employeeProfiles)
		.where(eq(employeeProfiles.userId, user.id))
		.limit(1);

	const [userRow] = await db
		.select({
			id: users.id,
			email: users.email,
			fullName: users.fullName,
			role: users.role,
			teamId: users.teamId,
			reportsTo: users.reportsTo
		})
		.from(users)
		.where(eq(users.id, user.id))
		.limit(1);

	const picture = await getProfilePicture(user.id);

	// Managers render as "Name (EMPCODE)" — the employee code is the portal's
	// identity key, so a manager is shown the same way a person is looked up.
	const managers = await resolveManagers({
		reportsTo: userRow?.reportsTo ?? null,
		directRaw: profile?.directReportingAuthority ?? null,
		dottedManagerId: profile?.dottedLineManagerId ?? null,
		dottedRaw: profile?.dottedLineReportingAuthority ?? null,
		selfUserId: user.id
	});

	return {
		profile: profile ?? null,
		userRow,
		managers,
		hasProfilePicture: Boolean(picture),
		// Cache-buster: without it a reload can serve the previous image from
		// the browser cache for the life of its max-age.
		profilePictureVersion: picture?.updatedAt?.getTime() ?? null
	};
};

export const actions: Actions = {
	updateSelfService: async ({ request, locals }) => {
		const user = locals.user!;
		const form = await request.formData();

		const [existing] = await db
			.select()
			.from(employeeProfiles)
			.where(eq(employeeProfiles.userId, user.id))
			.limit(1);

		/**
		 * Fields an employee may change on their own profile. HR-locked columns
		 * (employee code, designation, reporting lines, joining dates) are absent
		 * by design: reading the form key-by-key means a crafted POST cannot write
		 * anything that isn't listed here.
		 */
		const SELF_EDITABLE = [
			'phone',
			'personalEmail',
			'address',
			'permanentAddress',
			'emergencyContactName',
			'emergencyContactRelationship',
			'emergencyContactPhone',
			'fatherName',
			'motherName',
			'maritalStatus',
			'spouseName',
			'bankAccountNumber',
			'bankAccountHolderName',
			'bankName',
			'bankIfsc',
			'aadharNumber',
			'panNumber',
			'uanNumber',
			'underGraduate',
			'graduate',
			'masters',
			'diplomaOthers',
			'totalExperience'
		] as const;

		// Only fields actually present in the submission are written. Assigning
		// every field unconditionally would let a form that omits one — a partial
		// save, or a card not rendered in this submit — silently blank it.
		const values: Record<string, unknown> = { updatedAt: new Date() };
		for (const name of SELF_EDITABLE) {
			if (!form.has(name)) continue;
			const raw = String(form.get(name) ?? '').trim();
			values[name] = raw === '' ? null : raw;
		}

		if (existing) {
			await db.update(employeeProfiles).set(values).where(eq(employeeProfiles.userId, user.id));
		} else {
			await db.insert(employeeProfiles).values({ userId: user.id, ...values });
		}

		await logActivity({
			actorUserId: user.id,
			action: 'profile.self_update',
			targetType: 'employee_profile',
			targetId: user.id
		});

		return { success: true };
	}
};

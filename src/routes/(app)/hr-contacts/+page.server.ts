import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db/postgres';
import { users, employeeProfiles } from '$lib/server/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { notHidden } from '$lib/server/hidden-users';
import { getUsersWithProfilePicture } from '$lib/server/db/mongo';

export const load: PageServerLoad = async ({ locals }) => {
	const user = locals.user!;

	const [dbUser] = await db
		.select({ reportsTo: users.reportsTo })
		.from(users)
		.where(eq(users.id, user.id))
		.limit(1);

	const idsToShow = new Set<string>();
	if (dbUser?.reportsTo) idsToShow.add(dbUser.reportsTo);

	const superAdmins = await db
		.select({ id: users.id })
		.from(users)
		.where(and(eq(users.role, 'super_admin'), notHidden));
	superAdmins.forEach((a) => idsToShow.add(a.id));
	idsToShow.delete(user.id);

	if (idsToShow.size === 0) {
		return { contacts: [] };
	}

	const rows = await db
		.select({
			id: users.id,
			fullName: users.fullName,
			email: users.email,
			role: users.role,
			designation: employeeProfiles.designation,
			officeTimings: employeeProfiles.officeTimings,
			// Where to find them: the floor, then the team-and-floor line from the HR sheet.
			floorDetails: employeeProfiles.floorDetails,
			teamAndFloor: employeeProfiles.teamAndFloor
		})
		.from(users)
		.leftJoin(employeeProfiles, eq(employeeProfiles.userId, users.id))
		.where(and(inArray(users.id, [...idsToShow]), notHidden));

	const withPicture = await getUsersWithProfilePicture(rows.map((r) => r.id));

	return {
		contacts: rows.map((r) => ({
			...r,
			hasPicture: withPicture.has(r.id),
			isManager: r.id === dbUser?.reportsTo
		}))
	};
};

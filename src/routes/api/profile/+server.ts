import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/client';
import { employeeProfiles, users } from '$lib/server/db/schema';
import { requireUser } from '$lib/server/rbac';
import { eq } from 'drizzle-orm';

export const GET: RequestHandler = async (event) => {
	const user = requireUser(event);

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
			teamId: users.teamId
		})
		.from(users)
		.where(eq(users.id, user.id))
		.limit(1);

	return json({ profile: profile ?? null, user: userRow });
};

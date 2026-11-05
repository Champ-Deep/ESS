import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db/client';
import { users } from '$lib/server/db/schema';
import { needsCurrentPassword } from '$lib/server/clerk';

/**
 * Reached two ways: a new login is sent here until the temporary password is
 * replaced (`required`), and anyone can come here from their profile menu to
 * choose a new password of their own accord.
 */
export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) {
		throw redirect(303, '/login');
	}
	const [row] = await db
		.select({ passwordHash: users.passwordHash, mustChangePassword: users.mustChangePassword })
		.from(users)
		.where(eq(users.id, locals.user.id))
		.limit(1);
	return {
		user: locals.user,
		required: locals.user.mustChangePassword,
		// A first password after an emailed-code sign-in (Clerk) asks for no current one.
		needsCurrent: row ? needsCurrentPassword(row) : true
	};
};

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/postgres';
import { employeeProfiles } from '$lib/server/db/schema';
import { logActivity } from '$lib/server/db/mongo';
import { and, eq, ne } from 'drizzle-orm';
import { requireCap } from '$lib/server/capabilities';

/**
 * Sets an employee's company code (e.g. "CIPL2666") — the value that identifies
 * them across the portal, the HR master spreadsheets, and EasyTime Pro (where it
 * is the device-side {emp_code}). Attendance ingestion joins on this, so it is
 * stored uppercase and must be unique.
 */
export const PUT: RequestHandler = async (event) => {
	const actor = requireCap(event, 'people.employee_code');
	const userId = event.params.id;
	const { employeeCode } = await event.request.json();

	if (typeof employeeCode !== 'string' || !employeeCode.trim()) {
		throw error(400, 'employeeCode is required');
	}

	const normalized = employeeCode.trim().toUpperCase();
	if (normalized.length > 32) {
		throw error(400, 'employeeCode must be 32 characters or fewer');
	}

	const [profile] = await db
		.select()
		.from(employeeProfiles)
		.where(eq(employeeProfiles.userId, userId))
		.limit(1);
	if (!profile) throw error(404, 'Employee profile not found');

	// The code is the join key for attendance — a duplicate would silently
	// attribute one person's punches to another.
	const [clash] = await db
		.select({ userId: employeeProfiles.userId })
		.from(employeeProfiles)
		.where(
			and(eq(employeeProfiles.employeeCode, normalized), ne(employeeProfiles.userId, userId))
		)
		.limit(1);
	if (clash) {
		throw error(409, `Employee code ${normalized} is already assigned to another employee`);
	}

	const [updated] = await db
		.update(employeeProfiles)
		.set({ employeeCode: normalized, updatedAt: new Date() })
		.where(eq(employeeProfiles.userId, userId))
		.returning();

	await logActivity({
		actorUserId: actor.id,
		action: 'employee_profile.set_employee_code',
		targetType: 'user',
		targetId: userId,
		details: { employeeCode: normalized, previous: profile.employeeCode }
	});

	return json({ profile: updated });
};

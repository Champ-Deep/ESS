import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/postgres';
import { leaveTypes } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { logActivity } from '$lib/server/db/mongo';
import { deleteLeaveType } from '$lib/server/admin-cleanup';
import { requireCap } from '$lib/server/capabilities';

/**
 * Permanently deletes a leave type along with every allocation, application
 * and ledger entry that used it.
 *
 * This is for types created in error — duplicates left by seeding. To retire a
 * policy that people have genuinely taken leave under, archive it instead
 * (POST .../archive), which hides it while preserving the history.
 */
/**
 * Sets (or clears) the per-month ceiling on how much of this type one person
 * may take.
 *
 * The balance itself is never touched here — this only limits how fast it can
 * be drawn down. Sending null removes the ceiling, which is the shipped state:
 * the written policy gives an accrual rate and a carry-forward cap and says
 * nothing about a monthly limit, so nothing is capped until someone decides to.
 */
export const PATCH: RequestHandler = async (event) => {
	const actor = requireCap(event, 'policies.publish');
	const leaveTypeId = event.params.id;

	const body = await event.request.json().catch(() => null);
	if (!body || !('monthlyUsageCap' in body)) {
		throw error(400, 'monthlyUsageCap is required (a number of days, or null for no limit)');
	}

	const raw = body.monthlyUsageCap;
	let cap: string | null = null;
	if (raw !== null && raw !== '') {
		const n = Number(raw);
		if (!Number.isFinite(n) || n <= 0) {
			throw error(400, 'monthlyUsageCap must be a positive number of days, or null for no limit');
		}
		if (n > 366) throw error(400, 'monthlyUsageCap must be a number of days in a month');
		// Leave is booked in half days at finest, so a cap between them could never
		// be reached exactly.
		if (Math.round(n * 2) !== n * 2) {
			throw error(400, 'monthlyUsageCap must be a whole or half day');
		}
		cap = String(n);
	}

	const [updated] = await db
		.update(leaveTypes)
		.set({ monthlyUsageCap: cap })
		.where(eq(leaveTypes.id, leaveTypeId))
		.returning();
	if (!updated) throw error(404, 'Leave type not found');

	await logActivity({
		actorUserId: actor.id,
		action: 'leave_type.set_monthly_cap',
		targetType: 'leave_type',
		targetId: leaveTypeId,
		details: { name: updated.name, code: updated.code, monthlyUsageCap: cap }
	});

	return json({ leaveType: { id: updated.id, name: updated.name, monthlyUsageCap: updated.monthlyUsageCap } });
};

export const DELETE: RequestHandler = async (event) => {
	const actor = requireCap(event, 'policies.publish');
	const leaveTypeId = event.params.id;

	let result;
	try {
		result = await deleteLeaveType(leaveTypeId);
	} catch (err) {
		throw error(404, err instanceof Error ? err.message : 'Leave type not found');
	}

	await logActivity({
		actorUserId: actor.id,
		action: 'leave_type.delete',
		targetType: 'leave_type',
		targetId: leaveTypeId,
		details: { name: result.name, affectedRows: result.affected }
	});

	return json({ deleted: result });
};

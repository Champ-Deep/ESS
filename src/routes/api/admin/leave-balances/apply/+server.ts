import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/postgres';
import { leaveTypes } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { logActivity } from '$lib/server/db/mongo';
import {
	parseLeaveBalanceSheet,
	LeaveBalanceSheetError
} from '$lib/server/leave-balance-sheet';
import { resolveLeaveBalances, applyLeaveBalances } from '$lib/server/leave-balance-apply';
import { MAX_UPLOAD_BYTES, resolveYear } from '$lib/server/leave-balance-upload';
import { requireCap } from '$lib/server/capabilities';

/**
 * Applies an HR leave-balance upload — Super Admin and Admin (HR).
 *
 * The same file is re-parsed and re-resolved here rather than trusting a staged
 * preview, so what gets written is measured against the balances as they are now.
 *
 * Rows whose employee code or leave type matched nothing are skipped, not
 * guessed: the preview lists them by name so HR can fix the sheet and re-upload.
 */
export const POST: RequestHandler = async (event) => {
	const actor = requireCap(event, 'leave.set_balances');

	const form = await event.request.formData();
	const file = form.get('file');
	const rawNote = form.get('note');

	if (!(file instanceof File)) throw error(400, 'file is required');
	if (file.size === 0) throw error(400, 'That file is empty');
	if (file.size > MAX_UPLOAD_BYTES) throw error(400, 'File too large (max 5MB)');

	const year = resolveYear(form.get('year'));
	const note = typeof rawNote === 'string' && rawNote.trim() ? rawNote.trim().slice(0, 500) : null;

	const types = await db
		.select({ code: leaveTypes.code, name: leaveTypes.name })
		.from(leaveTypes)
		.where(eq(leaveTypes.isActive, true));
	const knownTypeTokens = types.flatMap((t) =>
		[t.code, t.name].filter((v): v is string => Boolean(v))
	);

	const buffer = Buffer.from(await file.arrayBuffer());

	let parsed;
	try {
		parsed = await parseLeaveBalanceSheet(buffer, { filename: file.name, knownTypeTokens });
	} catch (err) {
		if (err instanceof LeaveBalanceSheetError) throw error(400, err.message);
		throw err;
	}

	const summary = await resolveLeaveBalances(parsed.balances, year);

	if (summary.matchedCount === 0) {
		throw error(
			422,
			'None of the rows in that file could be matched to an employee and a published leave type, so nothing was applied.'
		);
	}

	const result = await applyLeaveBalances(summary, actor.id, note);

	await logActivity({
		actorUserId: actor.id,
		action: 'leave.balances_uploaded',
		// One upload spans many allocation rows, so the batch is the audit subject
		// rather than any single row; the figures themselves are in `details`.
		targetType: 'leave_allocation',
		details: {
			filename: file.name,
			year,
			note,
			created: result.created,
			updated: result.updated,
			skipped: result.skipped,
			// Kept so an audit can see which figures were set, not just how many.
			applied: summary.rows
				.filter((r) => r.applicable)
				.map((r) => ({
					empCode: r.empCode,
					leaveType: r.leaveTypeName,
					days: r.days,
					previousDays: r.existingDays
				})),
			unmatchedCodes: summary.unmatchedCodes,
			unmatchedTypes: summary.unmatchedTypes
		}
	});

	return json({
		year,
		created: result.created,
		updated: result.updated,
		skipped: result.skipped,
		unmatchedCodes: summary.unmatchedCodes,
		unmatchedTypes: summary.unmatchedTypes
	});
};

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/client';
import { leaveTypes } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import {
	parseLeaveBalanceSheet,
	LeaveBalanceSheetError
} from '$lib/server/leave-balance-sheet';
import { resolveLeaveBalances } from '$lib/server/leave-balance-apply';
import { MAX_UPLOAD_BYTES, resolveYear } from '$lib/server/leave-balance-upload';
import { requireCap } from '$lib/server/capabilities';

/**
 * Previews an HR leave-balance upload — Super Admin and Admin (HR).
 *
 * Parses the sheet, matches every employee code and leave type, and reports what
 * applying it would change. Writes nothing; the uploader confirms on screen and
 * POSTs the same file to ./apply.
 */
export const POST: RequestHandler = async (event) => {
	requireCap(event, 'leave.set_balances');

	const form = await event.request.formData();
	const file = form.get('file');

	if (!(file instanceof File)) throw error(400, 'file is required');
	if (file.size === 0) throw error(400, 'That file is empty');
	if (file.size > MAX_UPLOAD_BYTES) throw error(400, 'File too large (max 5MB)');

	const year = resolveYear(form.get('year'));

	// The published types tell a balance column apart from an unrelated one in a
	// wide sheet, so the parser is given the tokens it can expect to see.
	const types = await db
		.select({ code: leaveTypes.code, name: leaveTypes.name })
		.from(leaveTypes)
		.where(eq(leaveTypes.isActive, true));
	const knownTypeTokens = types.flatMap((t) => [t.code, t.name].filter((v): v is string => Boolean(v)));

	const buffer = Buffer.from(await file.arrayBuffer());

	let parsed;
	try {
		parsed = await parseLeaveBalanceSheet(buffer, { filename: file.name, knownTypeTokens });
	} catch (err) {
		// The parser's messages are written for the uploader — pass them through
		// rather than replacing them with a generic 400.
		if (err instanceof LeaveBalanceSheetError) throw error(400, err.message);
		throw err;
	}

	const summary = await resolveLeaveBalances(parsed.balances, year);

	return json({
		filename: file.name,
		sheetName: parsed.sheetName,
		layout: parsed.layout,
		year: summary.year,
		unmappedHeaders: parsed.unmappedHeaders,
		skippedRows: parsed.skippedRows,
		rowCount: summary.rows.length,
		matchedCount: summary.matchedCount,
		unmatchedCodes: summary.unmatchedCodes,
		unmatchedTypes: summary.unmatchedTypes,
		createCount: summary.createCount,
		updateCount: summary.updateCount,
		noChangeCount: summary.noChangeCount,
		belowUsedCount: summary.belowUsedCount,
		rows: summary.rows
	});
};

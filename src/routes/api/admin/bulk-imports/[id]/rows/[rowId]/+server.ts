import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/postgres';
import { bulkImports, bulkImportRows, users } from '$lib/server/db/schema';
import { looksLikeEmail } from '$lib/server/bulk-import';
import { eq, and, ne } from 'drizzle-orm';
import { requireCap } from '$lib/server/capabilities';
import { isTopReference, topLabel } from '$lib/chief';
import { isNoLoginEmail } from '$lib/no-login';

const VALID_ROLES = ['super_admin', 'admin', 'team_lead', 'employee'] as const;

// Super Admin edits a single row during review — email, role, or which row is the
// manager (or clears it). Only allowed while the parent import is still pending_review;
// once applied, rows are historical record and shouldn't be mutated.
export const PATCH: RequestHandler = async (event) => {
	requireCap(event, 'people.bulk_import');
	const importId = event.params.id;
	const rowId = event.params.rowId;

	const [importRow] = await db.select().from(bulkImports).where(eq(bulkImports.id, importId)).limit(1);
	if (!importRow) throw error(404, 'Import not found');
	if (importRow.status !== 'pending_review') {
		throw error(400, 'This import has already been applied and can no longer be edited');
	}

	const [row] = await db
		.select()
		.from(bulkImportRows)
		.where(and(eq(bulkImportRows.id, rowId), eq(bulkImportRows.importId, importId)))
		.limit(1);
	if (!row) throw error(404, 'Row not found in this import');

	const body = await event.request.json();
	const patch: Partial<typeof bulkImportRows.$inferInsert> = {};

	if ('officialEmail' in body) {
		// Held to the same shape the parser requires, because this is the screen
		// where an unusable login id gets corrected — accepting anything containing
		// an "@" would let the bad value straight back through.
		if (typeof body.officialEmail !== 'string' || !looksLikeEmail(body.officialEmail)) {
			throw error(400, 'officialEmail must be a valid email address');
		}
		const officialEmail = body.officialEmail.trim().toLowerCase();

		// `users.email` is unique, and apply inserts row by row with no transaction
		// around the batch. A collision therefore doesn't fail the edit — it fails
		// halfway through creating accounts, after some have already been made and
		// mailed. Cheaper to refuse it here.
		const [clashingRow] = await db
			.select({ id: bulkImportRows.id, fullName: bulkImportRows.fullName })
			.from(bulkImportRows)
			.where(
				and(
					eq(bulkImportRows.importId, importId),
					eq(bulkImportRows.officialEmail, officialEmail),
					ne(bulkImportRows.id, rowId)
				)
			)
			.limit(1);
		if (clashingRow) {
			throw error(400, `"${officialEmail}" is already used by another row in this import (${clashingRow.fullName})`);
		}

		const [clashingUser] = await db
			.select({ fullName: users.fullName, hidden: users.hidden })
			.from(users)
			.where(eq(users.email, officialEmail))
			.limit(1);
		if (clashingUser) {
			throw error(400, clashingUser.hidden ? `"${officialEmail}" is not available` : `"${officialEmail}" already belongs to an existing account (${clashingUser.fullName})`);
		}

		patch.officialEmail = officialEmail;
	}

	if ('role' in body) {
		if (!VALID_ROLES.includes(body.role)) {
			throw error(400, `role must be one of: ${VALID_ROLES.join(', ')}`);
		}
		patch.role = body.role;
	}

	if ('reportsToRowId' in body) {
		if (body.reportsToRowId !== null) {
			if (typeof body.reportsToRowId !== 'string') {
				throw error(400, 'reportsToRowId must be a string row id or null');
			}
			const [targetRow] = await db
				.select({ id: bulkImportRows.id })
				.from(bulkImportRows)
				.where(and(eq(bulkImportRows.id, body.reportsToRowId), eq(bulkImportRows.importId, importId)))
				.limit(1);
			if (!targetRow) throw error(400, 'reportsToRowId must reference another row in this same import');
			if (body.reportsToRowId === rowId) throw error(400, 'A row cannot report to itself');
		}
		patch.reportsToRowId = body.reportsToRowId;
		// Clearing the manager of a row the sheet put under Chief or Mam means
		// "nobody", so the sheet's "Chief"/"Mam" must not be read as the answer at apply.
		if (body.reportsToRowId === null && isTopReference(row.reportingAuthorityRaw)) patch.reportingAuthorityRaw = null;
	}

	// Reports to Chief or Mam, the heads of the company: no row to point at,
	// recorded the same way an upload records a sheet that says "Chief"/"Mam".
	if (body.reportsToChief === true) {
		patch.reportsToRowId = null;
		patch.reportingAuthorityRaw = topLabel(body.topPosition);
	}

	// Explicit resolution for a row flagged as a possible existing-person match
	// (needs_review + existingUserId set by a name match at upload time). The Super
	// Admin must say which it is — editing other fields does NOT implicitly decide this.
	if ('duplicateDecision' in body) {
		if (row.status !== 'needs_review' || !row.existingUserId) {
			throw error(400, 'This row has no pending duplicate-person decision');
		}
		if (body.duplicateDecision === 'link') {
			patch.status = 'skipped_existing';
		} else if (body.duplicateDecision === 'create_new') {
			patch.status = 'ready';
			patch.existingUserId = null;
		} else {
			throw error(400, 'duplicateDecision must be "link" or "create_new"');
		}
	}

	// --- Blue collar (src/lib/no-login.ts) -------------------------------------
	// A row with no work email is created only once the reviewer says the person
	// is blue collar — no login, looked after by their reporting manager — and
	// has given them a manager who can sign in to do that.
	if ('blueCollar' in body) {
		if (typeof body.blueCollar !== 'boolean') throw error(400, 'blueCollar must be true or false');
		if (body.blueCollar && !isNoLoginEmail(patch.officialEmail ?? row.officialEmail)) {
			throw error(400, 'Only a row with no work email can be marked blue collar');
		}
		patch.blueCollar = body.blueCollar;
		if (body.blueCollar) patch.role = 'employee';
	}
	// A real email makes it an ordinary login again.
	if (patch.officialEmail) patch.blueCollar = false;
	const managerRowId = 'reportsToRowId' in patch ? patch.reportsToRowId : row.reportsToRowId;
	if (patch.blueCollar ?? row.blueCollar) {
		const [manager] = managerRowId
			? await db
					.select({ fullName: bulkImportRows.fullName, officialEmail: bulkImportRows.officialEmail })
					.from(bulkImportRows)
					.where(eq(bulkImportRows.id, managerRowId))
					.limit(1)
			: [];
		const problem = !manager
			? `Pick ${row.fullName}'s reporting manager first: a blue-collar worker needs someone to look after them`
			: isNoLoginEmail(manager.officialEmail)
				? `${manager.fullName} has no login either, so they can't look after ${row.fullName}. Pick a manager who can sign in.`
				: null;
		// Asked for now: refuse. Already confirmed and the manager just changed:
		// the confirmation lapses and the row goes back on the review list.
		if (problem && body.blueCollar === true) throw error(400, problem);
		if (problem) patch.blueCollar = false;
	}

	if (Object.keys(patch).length === 0) {
		throw error(400, 'No recognized fields to update (officialEmail, role, reportsToRowId, reportsToChief, duplicateDecision, blueCollar)');
	}

	// Editing email/role/manager on a row that only needed review for its REPORTING
	// LINE (no duplicate-person flag) confirms it — but a duplicate-person flag can
	// only be cleared by an explicit duplicateDecision above, never implicitly.
	if (row.status === 'needs_review' && !row.existingUserId && !('duplicateDecision' in body)) {
		patch.status = 'ready';
	}
	// Still no email and not confirmed blue collar: it stays on the review list.
	if ((patch.status ?? row.status) === 'ready' && isNoLoginEmail(patch.officialEmail ?? row.officialEmail) && !(patch.blueCollar ?? row.blueCollar)) {
		patch.status = 'needs_review';
	}

	// A newly chosen manager, or Chief, makes a Team Lead — as at upload. Only an
	// Employee moves, and only on the change, so a role set by hand stays.
	if (body.reportsToChief === true && row.role === 'employee' && !('role' in body)) patch.role = 'team_lead';
	let promotedManager: typeof bulkImportRows.$inferSelect | null = null;
	if (typeof patch.reportsToRowId === 'string' && patch.reportsToRowId !== row.reportsToRowId) {
		[promotedManager] = await db
			.update(bulkImportRows)
			.set({ role: 'team_lead' })
			.where(and(eq(bulkImportRows.id, patch.reportsToRowId), eq(bulkImportRows.role, 'employee')))
			.returning();
	}

	const [updated] = await db.update(bulkImportRows).set(patch).where(eq(bulkImportRows.id, rowId)).returning();

	return json({ row: updated, promotedManager: promotedManager ?? null });
};

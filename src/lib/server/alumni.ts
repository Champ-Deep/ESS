import ExcelJS from 'exceljs';
import { Readable } from 'node:stream';
import { db } from '$lib/server/db/postgres';
import { alumni, alumniImports, employeeProfiles, loginEmails, users } from '$lib/server/db/schema';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { logActivity } from '$lib/server/db/mongo';
import { hasCap, invalidateCapabilities } from '$lib/server/capabilities';
import { notHidden } from '$lib/server/hidden-users';
import { ALUMNI_FIELDS, alumniKey, buildAlumniRow, findHeaderRow, type AlumniRow } from '$lib/alumni';
import type { SessionUser } from '$lib/server/auth';

/**
 * The Alumni tracker (Admin Controls › Alumni): HR uploads the left-employee
 * tracker; each row becomes, or updates, one alumni record. Rows are linked
 * to their portal login by employee code, then official email, then an exact
 * and unique name, and a linked profile with no last working day gets the
 * sheet's (payroll reads it for the final cycle).
 *
 * Closing a leaver's login is never a side effect of an upload: HR does it
 * from the list of leavers whose login is still open, and can reopen one.
 */

type Fail = { ok: false; message: string };

const MAX_ROWS = 20_000;
const LEFT_SHEET = /left|alumni|exit|resign|separat|ex[\s-]?employee|leaver|attrition/i;

/** ExcelJS cell value → a plain value (Date and numbers kept, so dates parse). */
function unwrap(value: unknown): unknown {
	if (value === null || value === undefined) return null;
	if (value instanceof Date || typeof value !== 'object') return value;
	const cell = value as Record<string, unknown>;
	if ('formula' in cell || 'sharedFormula' in cell) return unwrap(cell.result);
	if ('error' in cell) return null;
	if (Array.isArray(cell.richText)) return cell.richText.map((r) => (r as { text?: unknown }).text ?? '').join('');
	if ('text' in cell) return unwrap(cell.text);
	return null;
}

function sheetRows(ws: ExcelJS.Worksheet): unknown[][] {
	const out: unknown[][] = [];
	ws.eachRow({ includeEmpty: true }, (row, n) => {
		const values = Array.isArray(row.values) ? row.values.slice(1) : [];
		out[n - 1] = values.map(unwrap);
	});
	return Array.from(out, (r) => r ?? []);
}

/** Reads the tracker: the sheet that looks like the left list, its header row, its people. */
export async function readTracker(buffer: Buffer, filename: string): Promise<{ sheetName: string; rows: AlumniRow[]; skipped: number } | Fail> {
	const wb = new ExcelJS.Workbook();
	const lower = filename.toLowerCase();
	try {
		if (lower.endsWith('.csv')) await wb.csv.read(Readable.from(buffer));
		else if (lower.endsWith('.xlsx')) await wb.xlsx.load(buffer as unknown as ArrayBuffer);
		else return { ok: false, message: 'Upload the tracker as .xlsx or .csv (an old .xls has to be saved as .xlsx first)' };
	} catch {
		return { ok: false, message: 'That file could not be opened as a spreadsheet' };
	}

	let best: { ws: ExcelJS.Worksheet; rows: unknown[][]; header: number; score: number } | null = null;
	for (const ws of wb.worksheets) {
		const rows = sheetRows(ws);
		const h = findHeaderRow(rows);
		if (h.index < 0) continue;
		// A sheet named like the left list wins over a better-scoring other sheet.
		const score = h.score + (LEFT_SHEET.test(ws.name) ? 100 : 0);
		if (!best || score > best.score) best = { ws, rows, header: h.index, score };
	}
	if (!best) return { ok: false, message: 'No sheet has a header row with the employee name ("Name Of the Employee" or "Employee Name")' };

	const headers = best.rows[best.header];
	const body = best.rows.slice(best.header + 1);
	if (body.length > MAX_ROWS) return { ok: false, message: `That sheet has ${body.length} rows; the tracker can take up to ${MAX_ROWS} at a time` };
	const rows: AlumniRow[] = [];
	let skipped = 0;
	for (const cells of body) {
		if (!cells.some((c) => c !== null && c !== undefined && String(c).trim() !== '')) continue;
		const r = buildAlumniRow(headers, cells);
		if (r) rows.push(r);
		else skipped++;
	}
	if (rows.length === 0) return { ok: false, message: `No people found under the headers of "${best.ws.name}"` };
	return { sheetName: best.ws.name, rows, skipped };
}

type Person = { id: string; email: string; fullName: string; isActive: boolean; role: string; code: string | null; lwd: string | null; profileId: string | null };

async function loadPeople(): Promise<Person[]> {
	return db
		.select({
			id: users.id,
			email: users.email,
			fullName: users.fullName,
			isActive: users.isActive,
			role: users.role,
			code: employeeProfiles.employeeCode,
			lwd: employeeProfiles.lastWorkingDay,
			profileId: employeeProfiles.id
		})
		.from(users)
		.leftJoin(employeeProfiles, eq(employeeProfiles.userId, users.id))
		.where(notHidden);
}

const normName = (s: string) => s.toLowerCase().replace(/[^a-z]+/g, ' ').trim();

/** The login a tracker row belongs to: employee code, then official email, then a unique exact name. */
export function matcher(people: Person[]) {
	const byCode = new Map<string, Person>();
	const byEmail = new Map<string, Person>();
	const byName = new Map<string, Person[]>();
	for (const p of people) {
		if (p.code) byCode.set(p.code.toUpperCase().replace(/\s+/g, ''), p);
		byEmail.set(p.email.toLowerCase(), p);
		const n = normName(p.fullName);
		byName.set(n, [...(byName.get(n) ?? []), p]);
	}
	return (r: Pick<AlumniRow, 'employeeCode' | 'officialEmail' | 'fullName'>): Person | null => {
		if (r.employeeCode && byCode.has(r.employeeCode)) return byCode.get(r.employeeCode)!;
		if (r.officialEmail && byEmail.has(r.officialEmail)) return byEmail.get(r.officialEmail)!;
		const same = byName.get(normName(r.fullName ?? '')) ?? [];
		return same.length === 1 ? same[0] : null;
	};
}

/** Fills an empty profile last working day from the tracker; never overwrites one. */
async function fillLastWorkingDay(p: Person, lwd: string | null): Promise<boolean> {
	if (!lwd || p.lwd) return false;
	if (p.profileId) await db.update(employeeProfiles).set({ lastWorkingDay: lwd, updatedAt: new Date() }).where(eq(employeeProfiles.id, p.profileId));
	else await db.insert(employeeProfiles).values({ userId: p.id, lastWorkingDay: lwd });
	p.lwd = lwd;
	return true;
}

export type ImportSummary = { rows: number; created: number; updated: number; matched: number; lwdFilled: number; skipped: number; sheetName: string; stillOpen: number };

export async function importAlumniTracker(actor: SessionUser, file: { name: string; buffer: Buffer }): Promise<({ ok: true } & ImportSummary) | Fail> {
	if (!hasCap(actor, 'people.alumni')) return { ok: false, message: 'You do not have the Alumni tracker privilege' };
	const read = await readTracker(file.buffer, file.name);
	if ('ok' in read) return read;

	// One record per person even if the sheet lists them twice: the later row wins.
	const unique = new Map<string, AlumniRow>();
	for (const r of read.rows) unique.set(alumniKey(r), r);

	const existing = await db.select().from(alumni);
	const byKey = new Map<string, (typeof existing)[number]>();
	for (const e of existing) {
		byKey.set(alumniKey(e), e);
		// A record first saved without a code is still found once a code appears.
		byKey.set(alumniKey({ ...e, employeeCode: null }), e);
	}

	const people = await loadPeople();
	const match = matcher(people);

	const [imp] = await db.insert(alumniImports).values({ filename: file.name.slice(0, 200), sheetName: read.sheetName, rowCount: unique.size, uploadedBy: actor.id }).returning();

	let created = 0;
	let updated = 0;
	let matched = 0;
	let lwdFilled = 0;
	const inserts: (typeof alumni.$inferInsert)[] = [];
	for (const r of unique.values()) {
		const person = match(r);
		if (person) {
			matched++;
			if (await fillLastWorkingDay(person, r.lastWorkingDay)) lwdFilled++;
		}
		const prev = byKey.get(alumniKey(r)) ?? (r.employeeCode ? byKey.get(alumniKey({ ...r, employeeCode: null })) : undefined);
		const fields = Object.fromEntries(ALUMNI_FIELDS.map((f) => [f, r[f]]));
		if (!prev) {
			inserts.push({ ...(fields as unknown as typeof alumni.$inferInsert), fullName: r.fullName!, details: r.details, userId: person?.id ?? null, importId: imp.id });
			created++;
			continue;
		}
		// A blank cell never wipes what an earlier upload recorded.
		const patch: Record<string, unknown> = {};
		for (const f of ALUMNI_FIELDS) if (r[f] !== null) patch[f] = r[f];
		await db
			.update(alumni)
			.set({ ...patch, details: { ...prev.details, ...r.details }, userId: person?.id ?? prev.userId, importId: imp.id, updatedAt: new Date() })
			.where(eq(alumni.id, prev.id));
		updated++;
	}
	for (let i = 0; i < inserts.length; i += 500) await db.insert(alumni).values(inserts.slice(i, i + 500));

	await db.update(alumniImports).set({ createdCount: created, updatedCount: updated, matchedCount: matched }).where(eq(alumniImports.id, imp.id));
	await logActivity({
		actorUserId: actor.id,
		action: 'alumni.import',
		targetType: 'alumni_import',
		targetId: imp.id,
		details: { filename: file.name, sheet: read.sheetName, rows: unique.size, created, updated, matched, lwdFilled }
	});
	return { ok: true, rows: unique.size, created, updated, matched, lwdFilled, skipped: read.skipped, sheetName: read.sheetName, stillOpen: await leaversWithOpenLogin() };
}

/** Leavers whose portal login is still open (left on or before today, or no date). */
export async function leaversWithOpenLogin(): Promise<number> {
	const r = await db.execute(sql`
		select count(distinct a.user_id)::int as n
		from alumni a join users u on u.id = a.user_id
		where u.is_active and u.hidden = false and u.role <> 'super_admin'
			and (a.last_working_day is null or a.last_working_day <= (now() at time zone 'Asia/Kolkata')::date)
	`);
	return (r.rows[0] as { n?: number } | undefined)?.n ?? 0;
}

export async function alumniPageData() {
	const [rows, imports] = await Promise.all([
		db
			.select({ a: alumni, loginActive: users.isActive, role: users.role })
			.from(alumni)
			.leftJoin(users, eq(users.id, alumni.userId))
			.orderBy(desc(alumni.lastWorkingDay), alumni.fullName),
		db
			.select({ id: alumniImports.id, filename: alumniImports.filename, sheetName: alumniImports.sheetName, rows: alumniImports.rowCount, created: alumniImports.createdCount, updated: alumniImports.updatedCount, matched: alumniImports.matchedCount, at: alumniImports.createdAt, by: users.fullName })
			.from(alumniImports)
			.leftJoin(users, eq(users.id, alumniImports.uploadedBy))
			.orderBy(desc(alumniImports.createdAt))
			.limit(5)
	]);
	return {
		alumni: rows.map(({ a, loginActive, role }) => ({
			id: a.id,
			employeeCode: a.employeeCode,
			fullName: a.fullName,
			officialEmail: a.officialEmail,
			personalEmail: a.personalEmail,
			phone: a.phone,
			designation: a.designation,
			team: a.team,
			department: a.department,
			company: a.company,
			dateOfJoining: a.dateOfJoining,
			resignationDate: a.resignationDate,
			lastWorkingDay: a.lastWorkingDay,
			natureOfExit: a.natureOfExit,
			reason: a.reason,
			remarks: a.remarks,
			rehireEligible: a.rehireEligible,
			fnfStatus: a.fnfStatus,
			details: a.details,
			userId: a.userId,
			/** none: not in the portal · open: login still works · closed: login closed. */
			login: !a.userId || loginActive === null ? ('none' as const) : loginActive ? ('open' as const) : ('closed' as const),
			superAdmin: role === 'super_admin'
		})),
		imports: imports.map((i) => ({ ...i, at: i.at.toISOString() }))
	};
}

/** Closes the logins of people the tracker says have left. */
export async function closeLeaverLogins(actor: SessionUser, userIds: string[]): Promise<{ ok: true; message: string } | Fail> {
	if (!hasCap(actor, 'people.alumni')) return { ok: false, message: 'You do not have the Alumni tracker privilege' };
	const ids = [...new Set(userIds)].filter((id) => id !== actor.id);
	if (ids.length === 0) return { ok: false, message: 'Pick at least one person' };
	// Only people on the alumni list, never a Super Admin, never yourself.
	const rows = await db
		.select({ id: users.id, fullName: users.fullName, email: users.email, lwd: alumni.lastWorkingDay })
		.from(alumni)
		.innerJoin(users, eq(users.id, alumni.userId))
		.where(and(inArray(users.id, ids), eq(users.isActive, true), notHidden, sql`${users.role} <> 'super_admin'`));
	if (rows.length === 0) return { ok: false, message: 'None of them has an open login to close' };
	const targetIds = [...new Set(rows.map((r) => r.id))];

	const people = new Map((await loadPeople()).map((p) => [p.id, p]));
	for (const r of rows) {
		const p = people.get(r.id);
		if (p) await fillLastWorkingDay(p, r.lwd);
	}
	await db.update(users).set({ isActive: false, updatedAt: new Date() }).where(inArray(users.id, targetIds));
	// A login email still waiting must not go to someone who has left.
	await db
		.update(loginEmails)
		.set({ status: 'cancelled', error: 'Left the company' })
		.where(and(inArray(loginEmails.userId, targetIds), inArray(loginEmails.status, ['pending', 'approved', 'failed'])));
	for (const id of targetIds) invalidateCapabilities(id);
	await logActivity({
		actorUserId: actor.id,
		action: 'alumni.close_logins',
		targetType: 'user',
		targetId: targetIds.length === 1 ? targetIds[0] : 'many',
		details: { closed: rows.map((r) => r.email) }
	});
	return {
		ok: true,
		message: `Closed ${targetIds.length === 1 ? `${rows[0].fullName}'s login` : `${targetIds.length} logins`}. ${targetIds.length === 1 ? 'They' : 'They'} can no longer sign in; their records stay, and payroll still covers their final cycle.`
	};
}

/** Reopens a login closed by mistake. */
export async function reopenLogin(actor: SessionUser, userId: string): Promise<{ ok: true; message: string } | Fail> {
	if (!hasCap(actor, 'people.alumni')) return { ok: false, message: 'You do not have the Alumni tracker privilege' };
	const [u] = await db
		.select({ id: users.id, fullName: users.fullName, email: users.email })
		.from(alumni)
		.innerJoin(users, eq(users.id, alumni.userId))
		.where(and(eq(users.id, userId), eq(users.isActive, false), notHidden))
		.limit(1);
	if (!u) return { ok: false, message: 'That login is not closed' };
	await db.update(users).set({ isActive: true, updatedAt: new Date() }).where(eq(users.id, u.id));
	invalidateCapabilities(u.id);
	await logActivity({ actorUserId: actor.id, action: 'alumni.reopen_login', targetType: 'user', targetId: u.id, details: { email: u.email } });
	return { ok: true, message: `${u.fullName} can sign in again.` };
}

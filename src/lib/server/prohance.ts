import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db/client';
import { prohanceDays, prohanceSyncs, employeeProfiles, users } from '$lib/server/db/schema';
import { normalizeEmpCode } from '$lib/server/easytime-import';
import { notHidden } from '$lib/server/hidden-users';
import { and, eq, sql } from 'drizzle-orm';
import { inArray } from '$lib/server/db/sql';

/**
 * ProHance Web Services API client + sync (see "ProHance Web Services API
 * Guide v21.0.pdf" in the repo root).
 *
 * The portal POLLS ProHance — there is no push from their side. Each run pulls
 * the Comprehensive User Report (reportBy=User, viewBy=Day) for the window
 * "25th of the previous month → today" and upserts one prohance_days row per
 * employee per day. The window matches the company's payroll cycle and always
 * re-covers recent days, so late-arriving ProHance data self-corrects; the
 * (emp_code, session_date) unique key makes re-pulling idempotent.
 *
 * Auth: `Authorization: Basic <key>` where <key> is the opaque base64 API key
 * generated in the ProHance admin ("Prohance_API_KEY" in the environment).
 * ProHance also whitelists caller IPs server-side — a 401 "Invalid
 * credentials" can therefore mean a stale key OR an unauthorized egress IP.
 */

const REPORT_COLUMNS = [
	'Employee ID',
	'Console Login Id',
	'FirstLogin',
	'LastLogout',
	'TOT_LoggedHours',
	'TOT_ActiveHours',
	'TOT_TimeOnSystem',
	'TOT_TimeAwayFromSystem',
	'TOT_IdleTime',
	'DayTypeAlias'
].join(',');

/** Timestamps in ProHance reports carry no zone; the org runs on IST. */
const DEFAULT_UTC_OFFSET = '+05:30';

function config() {
	const baseUrl = (env.PROHANCE_BASE_URL ?? '').replace(/\/+$/, '');
	// Two credential shapes: a dedicated web-service username/password issued
	// by the ProHance team (the guide's documented auth — standard Basic), or
	// the opaque base64 key generated in the ProHance admin UI. User/password
	// wins when both are set.
	const user = env.PROHANCE_WS_USER ?? '';
	const password = env.PROHANCE_WS_PASSWORD ?? '';
	const apiKey =
		user && password
			? Buffer.from(`${user}:${password}`, 'utf8').toString('base64')
			: (env.PROHANCE_API_KEY ?? env.Prohance_API_KEY ?? '');
	return {
		baseUrl,
		apiKey,
		utcOffset: env.PROHANCE_UTC_OFFSET || DEFAULT_UTC_OFFSET
	};
}

export function isProhanceConfigured(): boolean {
	const { baseUrl, apiKey } = config();
	return Boolean(baseUrl && apiKey);
}

export interface ProhanceDayRow {
	empCode: string;
	consoleLoginId: string | null;
	userName: string | null;
	sessionDate: string; // YYYY-MM-DD
	firstLogin: Date | null;
	lastLogout: Date | null;
	loggedMinutes: number | null;
	activeMinutes: number | null;
	idleMinutes: number | null;
	timeOnSystemMinutes: number | null;
	timeAwayMinutes: number | null;
	dayType: string | null;
	raw: Record<string, unknown>;
}

const MONTHS: Record<string, number> = {
	jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
	jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
};

/** "2026-07-25", "25-Jul-2026" or "25/07/2026" → "2026-07-25"; null otherwise. */
function parseSessionDate(value: unknown): string | null {
	const s = String(value ?? '').trim();
	if (!s) return null;
	let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
	if (m) return `${m[1]}-${m[2]}-${m[3]}`;
	m = s.match(/^(\d{1,2})-([A-Za-z]{3})[A-Za-z]*-(\d{4})/);
	if (m) {
		const month = MONTHS[m[2].toLowerCase()];
		if (month) return `${m[3]}-${String(month).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
	}
	m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
	if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
	return null;
}

/**
 * ProHance timestamps come as "02-Nov-2016 08:59:28", "2016-11-02 08:59:28" or
 * a bare "08:59:28"/"08:59" (in which case the session date provides the day).
 * All are wall-clock in the org's zone — pinned via the configured UTC offset.
 */
function parseTimestamp(value: unknown, sessionDate: string, utcOffset: string): Date | null {
	const s = String(value ?? '').trim();
	if (!s || s === '-' || s === '--') return null;

	let datePart: string | null = null;
	let timePart: string | null = null;

	const dateTime = s.match(/^(.+?)\s+(\d{1,2}:\d{2}(?::\d{2})?)$/);
	if (dateTime) {
		datePart = parseSessionDate(dateTime[1]);
		timePart = dateTime[2];
	} else if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(s)) {
		datePart = sessionDate;
		timePart = s;
	}
	if (!datePart || !timePart) return null;

	const [h, min, sec = '00'] = timePart.split(':');
	const iso = `${datePart}T${h.padStart(2, '0')}:${min}:${sec.padStart(2, '0')}${utcOffset}`;
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? null : d;
}

/** "07:32:00" / "07:32" → minutes; plain numbers are hours ("7.5" → 450). */
function parseDurationMinutes(value: unknown): number | null {
	const s = String(value ?? '').trim();
	if (!s || s === '-' || s === '--') return null;
	const m = s.match(/^(\d{1,3}):(\d{2})(?::(\d{2}))?$/);
	if (m) return Number(m[1]) * 60 + Number(m[2]) + Math.round(Number(m[3] ?? 0) / 60);
	const n = Number(s);
	if (Number.isFinite(n)) return Math.round(n * 60);
	return null;
}

/**
 * A report item nests values under "Report Columns" / "User Attributes"
 * containers (per the guide's config method); user fields sit at the top
 * level. Flatten all of it into one bag keyed by header text.
 */
function flattenItem(item: Record<string, unknown>): Record<string, unknown> {
	const flat: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(item)) {
		if (v && typeof v === 'object' && !Array.isArray(v)) {
			for (const [ik, iv] of Object.entries(v as Record<string, unknown>)) flat[ik] = iv;
		} else {
			flat[k] = v;
		}
	}
	return flat;
}

/** Case/spacing-insensitive lookup across the aliases a field appears under. */
function pick(flat: Record<string, unknown>, aliases: string[]): unknown {
	const norm = (k: string) => k.replace(/[\s_]/g, '').toLowerCase();
	const index = new Map(Object.keys(flat).map((k) => [norm(k), k]));
	for (const alias of aliases) {
		const key = index.get(norm(alias));
		if (key !== undefined && flat[key] !== undefined && flat[key] !== '') return flat[key];
	}
	return null;
}

export async function fetchComprehensiveReport(
	fromDate: string,
	toDate: string
): Promise<ProhanceDayRow[]> {
	const { baseUrl, apiKey, utcOffset } = config();
	if (!baseUrl || !apiKey) {
		throw new Error('ProHance is not configured (PROHANCE_BASE_URL / Prohance_API_KEY)');
	}

	const res = await fetch(`${baseUrl}/report/comprehensive/getdata`, {
		method: 'POST',
		headers: {
			Authorization: `Basic ${apiKey}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			fromDate,
			toDate,
			shifts: '',
			shiftHrsOnly: 'false',
			userGroupName: '',
			superGroupName: '',
			reportBy: 'User',
			viewBy: 'Day',
			filterBy: 'dayType',
			filterByValue: 'All',
			userType: 'All',
			filterByData: '',
			avgDaysDaytype: 'All',
			sdRatioValue: '1.0',
			reportColumns: REPORT_COLUMNS,
			reportDurationFormat: 'HH',
			displayData: 'byEachGroup',
			displayOverallData: 'NO',
			displayOnlyActiveUsersData: false,
			displayTimeBasedOnTimeZone: 'byLoggedInUser'
		}),
		signal: AbortSignal.timeout(120_000)
	});

	const text = await res.text();
	if (!res.ok) {
		throw new Error(`ProHance getdata failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
	}

	let payload: unknown;
	try {
		payload = JSON.parse(text);
	} catch {
		throw new Error(`ProHance returned non-JSON: ${text.slice(0, 300)}`);
	}

	if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
		const status = (payload as Record<string, unknown>).operationStatus;
		if (status === 'FAILURE') {
			throw new Error(`ProHance rejected the request: ${(payload as Record<string, unknown>).reason ?? text.slice(0, 300)}`);
		}
		// Some deployments wrap the array — accept the first array-valued field.
		const arr = Object.values(payload).find(Array.isArray);
		payload = arr ?? [];
	}
	if (!Array.isArray(payload)) return [];

	const rows: ProhanceDayRow[] = [];
	for (const item of payload) {
		if (!item || typeof item !== 'object') continue;
		const flat = flattenItem(item as Record<string, unknown>);

		const empCodeRaw = pick(flat, ['Employee ID', 'employeeId', 'Employee No', 'employeeNo']);
		const consoleLoginId = (pick(flat, ['Console Login Id', 'consoleLoginId', 'webLoginId']) ??
			null) as string | null;
		const sessionDate = parseSessionDate(pick(flat, ['Session Date', 'sessionDate', 'Date']));
		// ProHance leaves "Employee Id" blank for some people; the console login's
		// local-part stands in so those rows still get a stable per-person key
		// instead of colliding on ''. Aggregate/summary rows carry neither → skip.
		const empSource = String(empCodeRaw ?? '').trim() || (consoleLoginId ?? '').split('@')[0].trim();
		if (!empSource || !sessionDate) continue;

		rows.push({
			empCode: normalizeEmpCode(empSource),
			consoleLoginId,
			userName: (pick(flat, ['User Name', 'userName']) ?? null) as string | null,
			sessionDate,
			firstLogin: parseTimestamp(pick(flat, ['FirstLogin', 'firstLogin']), sessionDate, utcOffset),
			lastLogout: parseTimestamp(pick(flat, ['LastLogout', 'lastLogout']), sessionDate, utcOffset),
			loggedMinutes: parseDurationMinutes(pick(flat, ['TOT_LoggedHours', 'loggedHours'])),
			activeMinutes: parseDurationMinutes(pick(flat, ['TOT_ActiveHours', 'activeHours'])),
			idleMinutes: parseDurationMinutes(pick(flat, ['TOT_IdleTime', 'idleTime'])),
			timeOnSystemMinutes: parseDurationMinutes(pick(flat, ['TOT_TimeOnSystem', 'timeOnSystem'])),
			timeAwayMinutes: parseDurationMinutes(
				pick(flat, ['TOT_TimeAwayFromSystem', 'timeAwayFromSystem'])
			),
			dayType: (pick(flat, ['DayTypeAlias', 'dayTypeAlias', 'DayType', 'dayType']) ??
				null) as string | null,
			raw: flat
		});
	}
	return rows;
}

/** Statements per D1 batch. */
const BATCH = 200;

/** Upserts report rows and resolves employee codes to portal users. */
async function applyRows(rows: ProhanceDayRow[], syncId: string) {
	let matched = 0;
	let unmatched = 0;
	if (rows.length === 0) return { matched, unmatched };

	const codes = [...new Set(rows.map((r) => r.empCode))];
	const profiles = await db
		.select({ userId: employeeProfiles.userId, employeeCode: employeeProfiles.employeeCode })
		.from(employeeProfiles)
		.innerJoin(users, eq(users.id, employeeProfiles.userId))
		.where(and(notHidden, inArray(employeeProfiles.employeeCode, codes)));
	const userByCode = new Map(
		profiles
			.filter((p): p is { userId: string; employeeCode: string } => Boolean(p.employeeCode))
			.map((p) => [normalizeEmpCode(p.employeeCode), p.userId])
	);

	// Fallback join: ProHance's "Employee Id" is not always the CIPL code — for
	// many people it's a login-style id ("aayushi.j"), and their console login
	// ("Aayushi.j@CIPL.CLOUD") shares its local-part with the portal email
	// ("aayushi.j@championsmail.com"). Only local-parts that map to exactly ONE
	// portal user are used — this feeds attendance, so an ambiguous match is
	// worse than no match.
	const localpart = (s: string) => s.split('@')[0].trim().toLowerCase();
	const portalUsers = await db.select({ id: users.id, email: users.email }).from(users).where(notHidden);
	const byLocalpart = new Map<string, string | null>();
	for (const u of portalUsers) {
		const lp = localpart(u.email);
		if (!lp) continue;
		byLocalpart.set(lp, byLocalpart.has(lp) ? null : u.id); // null = ambiguous
	}

	// One upsert per row, sent in batches: a window is thousands of rows, more
	// than D1 allows as separate queries in one invocation.
	const upserts = rows.map((row) => {
		const userId =
			userByCode.get(row.empCode) ??
			(row.consoleLoginId ? byLocalpart.get(localpart(row.consoleLoginId)) : null) ??
			byLocalpart.get(row.empCode.toLowerCase()) ??
			null;
		if (userId) matched += 1;
		else unmatched += 1;

		return db
			.insert(prohanceDays)
			.values({
				syncId,
				empCode: row.empCode,
				consoleLoginId: row.consoleLoginId,
				userName: row.userName,
				sessionDate: row.sessionDate,
				firstLogin: row.firstLogin,
				lastLogout: row.lastLogout,
				loggedMinutes: row.loggedMinutes,
				activeMinutes: row.activeMinutes,
				idleMinutes: row.idleMinutes,
				timeOnSystemMinutes: row.timeOnSystemMinutes,
				timeAwayMinutes: row.timeAwayMinutes,
				dayType: row.dayType,
				raw: row.raw,
				matchedUserId: userId
			})
			.onConflictDoUpdate({
				target: [prohanceDays.empCode, prohanceDays.sessionDate],
				set: {
					syncId,
					consoleLoginId: row.consoleLoginId,
					userName: row.userName,
					firstLogin: row.firstLogin,
					lastLogout: row.lastLogout,
					loggedMinutes: row.loggedMinutes,
					activeMinutes: row.activeMinutes,
					idleMinutes: row.idleMinutes,
					timeOnSystemMinutes: row.timeOnSystemMinutes,
					timeAwayMinutes: row.timeAwayMinutes,
					dayType: row.dayType,
					raw: row.raw,
					matchedUserId: userId,
					updatedAt: new Date()
				}
			});
	});
	for (let i = 0; i < upserts.length; i += BATCH) {
		const [first, ...rest] = upserts.slice(i, i + BATCH);
		await db.batch([first, ...rest]);
	}
	return { matched, unmatched };
}

const toDateStr = (d: Date) =>
	`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * The polling window: the 25th of the previous month through today — i.e. the
 * running two-cycle band "25th of prev month → 26th of next month" with the
 * future part omitted (ProHance has no rows for days that haven't happened;
 * the half-hourly poll keeps extending coverage day by day until the band
 * rolls forward). Both the previous payroll cycle and the running one stay
 * refreshed, so late ProHance corrections land automatically.
 */
export function syncWindow(now = new Date()): { fromDate: string; toDate: string } {
	return {
		fromDate: toDateStr(new Date(now.getFullYear(), now.getMonth() - 1, 25)),
		toDate: toDateStr(now)
	};
}

/**
 * ProHance rejects report ranges over 31 days ("Report duration cannot be
 * more than 31 days"), so windows are pulled in ≤28-day chunks.
 */
export function chunkRanges(
	fromDate: string,
	toDate: string,
	maxDays = 28
): Array<{ fromDate: string; toDate: string }> {
	const out: Array<{ fromDate: string; toDate: string }> = [];
	const iso = (d: Date) => d.toISOString().slice(0, 10);
	const end = new Date(`${toDate}T00:00:00Z`);
	let cursor = new Date(`${fromDate}T00:00:00Z`);
	while (cursor <= end) {
		const chunkEnd = new Date(cursor);
		chunkEnd.setUTCDate(chunkEnd.getUTCDate() + maxDays - 1);
		out.push({ fromDate: iso(cursor), toDate: iso(chunkEnd > end ? end : chunkEnd) });
		cursor = new Date(chunkEnd);
		cursor.setUTCDate(cursor.getUTCDate() + 1);
	}
	return out;
}

export interface SyncResult {
	syncId: string;
	fromDate: string;
	toDate: string;
	rowCount: number;
	matchedCount: number;
	unmatchedCount: number;
	rematchedCount: number;
}

export interface SyncWindowOverride {
	fromDate: string;
	toDate: string;
}

let inFlight: Promise<SyncResult> | null = null;

/**
 * One full pull-and-apply. Concurrent callers (poller tick + manual trigger)
 * share the same in-flight run instead of hammering ProHance twice. An
 * explicit window (admin backfill) still runs chunked like the default one.
 */
export function runProhanceSync(
	trigger: 'poll' | 'manual',
	window?: SyncWindowOverride
): Promise<SyncResult> {
	if (inFlight) return inFlight;
	inFlight = doSync(trigger, window).finally(() => {
		inFlight = null;
	});
	return inFlight;
}

/**
 * Rows that never resolved to a user get another chance on every run — on the
 * production server the whole roster already exists, and anyone onboarded
 * later picks up their full stored ProHance history on the next poll.
 */
async function rematchUnmatchedRows(): Promise<number> {
	const orphans = await db
		.selectDistinct({
			empCode: prohanceDays.empCode,
			consoleLoginId: prohanceDays.consoleLoginId
		})
		.from(prohanceDays)
		.where(sql`${prohanceDays.matchedUserId} is null`);
	if (orphans.length === 0) return 0;

	const profiles = await db
		.select({ userId: employeeProfiles.userId, employeeCode: employeeProfiles.employeeCode })
		.from(employeeProfiles)
		.innerJoin(users, eq(users.id, employeeProfiles.userId))
		.where(
			and(
				notHidden,
				inArray(
					employeeProfiles.employeeCode,
					orphans.map((o) => o.empCode)
				)
			)
		);
	const userByCode = new Map(
		profiles
			.filter((p): p is { userId: string; employeeCode: string } => Boolean(p.employeeCode))
			.map((p) => [normalizeEmpCode(p.employeeCode), p.userId])
	);

	const localpart = (s: string) => s.split('@')[0].trim().toLowerCase();
	const portalUsers = await db.select({ id: users.id, email: users.email }).from(users).where(notHidden);
	const byLocalpart = new Map<string, string | null>();
	for (const u of portalUsers) {
		const lp = localpart(u.email);
		if (!lp) continue;
		byLocalpart.set(lp, byLocalpart.has(lp) ? null : u.id);
	}

	let rematched = 0;
	const updates = [];
	for (const o of orphans) {
		const userId =
			userByCode.get(o.empCode) ??
			(o.consoleLoginId ? byLocalpart.get(localpart(o.consoleLoginId)) : null) ??
			byLocalpart.get(o.empCode.toLowerCase()) ??
			null;
		if (!userId) continue;
		updates.push(
			db
				.update(prohanceDays)
				.set({ matchedUserId: userId, updatedAt: new Date() })
				.where(and(eq(prohanceDays.empCode, o.empCode), sql`${prohanceDays.matchedUserId} is null`))
				.returning({ id: prohanceDays.id })
		);
	}
	for (let i = 0; i < updates.length; i += BATCH) {
		const [first, ...rest] = updates.slice(i, i + BATCH);
		for (const updated of await db.batch([first, ...rest])) rematched += updated.length;
	}
	return rematched;
}

async function doSync(trigger: 'poll' | 'manual', window?: SyncWindowOverride): Promise<SyncResult> {
	const { fromDate, toDate } = window ?? syncWindow();
	const [syncRow] = await db
		.insert(prohanceSyncs)
		.values({ trigger, rangeFrom: fromDate, rangeTo: toDate })
		.returning();

	try {
		// ProHance caps a report at 31 days, so the window is pulled chunk by chunk.
		const rows: ProhanceDayRow[] = [];
		for (const chunk of chunkRanges(fromDate, toDate)) {
			rows.push(...(await fetchComprehensiveReport(chunk.fromDate, chunk.toDate)));
		}
		const { matched, unmatched } = await applyRows(rows, syncRow.id);
		const rematchedCount = await rematchUnmatchedRows();
		await db
			.update(prohanceSyncs)
			.set({
				status: 'ok',
				rowCount: rows.length,
				matchedCount: matched,
				unmatchedCount: unmatched,
				finishedAt: new Date()
			})
			.where(eq(prohanceSyncs.id, syncRow.id));
		return {
			syncId: syncRow.id,
			fromDate,
			toDate,
			rowCount: rows.length,
			matchedCount: matched,
			unmatchedCount: unmatched,
			rematchedCount
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		await db
			.update(prohanceSyncs)
			.set({ status: 'error', error: message.slice(0, 2000), finishedAt: new Date() })
			.where(eq(prohanceSyncs.id, syncRow.id));
		throw err;
	}
}

/**
 * Starts the in-process poller. Interval comes from PROHANCE_POLL_MINUTES
 * (default 30, minimum 5; 0 disables). No-op when ProHance isn't configured.
 * The globalThis guard keeps dev-server HMR from stacking intervals.
 */
export function startProhancePoller() {
	if (!isProhanceConfigured()) return;

	const raw = Number(env.PROHANCE_POLL_MINUTES ?? '30');
	if (raw === 0) return;
	const minutes = Number.isFinite(raw) && raw >= 5 ? raw : 30;

	const g = globalThis as { __prohancePoller?: ReturnType<typeof setInterval> };
	if (g.__prohancePoller) return;

	const tick = () =>
		runProhanceSync('poll').catch((err) => {
			console.error('[prohance] poll failed:', err instanceof Error ? err.message : err);
		});

	// First pull shortly after boot so a deploy doesn't wait a full interval.
	setTimeout(tick, 15_000);
	g.__prohancePoller = setInterval(tick, minutes * 60_000);
	console.log(`[prohance] poller started (every ${minutes}m, window 25th-of-prev-month → today)`);
}

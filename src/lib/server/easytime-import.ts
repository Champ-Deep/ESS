import { createHash, timingSafeEqual } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db/client';
import { attendanceImportTokens } from '$lib/server/db/schema';
import { eq, isNull } from 'drizzle-orm';

export function hashImportToken(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

export const ENV_TOKEN_LABEL = 'Railway variable EASYTIME_IMPORT_TOKEN';
const MIN_ENV_TOKEN_LENGTH = 32;

export function envTokenHash(): string | null {
	const token = (env.EASYTIME_IMPORT_TOKEN ?? '').trim();
	return token.length >= MIN_ENV_TOKEN_LENGTH ? hashImportToken(token) : null;
}

async function registerEnvToken(candidateHash: Buffer): Promise<void> {
	const hash = envTokenHash();
	if (!hash) return;
	const expected = Buffer.from(hash);
	if (expected.length !== candidateHash.length || !timingSafeEqual(expected, candidateHash)) return;

	await db
		.insert(attendanceImportTokens)
		.values({ label: ENV_TOKEN_LABEL, tokenHash: hash })
		.onConflictDoNothing({ target: attendanceImportTokens.tokenHash });
}

/**
 * Validates the shared import token against stored hashes using a constant-time
 * compare per row (SHA-256 hashes are fixed-length, so this is safe).
 */
export async function verifyImportToken(token: string | null): Promise<string | null> {
	if (!token) return null;
	const candidateHash = Buffer.from(hashImportToken(token));
	await registerEnvToken(candidateHash);

	const rows = await db
		.select({ id: attendanceImportTokens.id, tokenHash: attendanceImportTokens.tokenHash })
		.from(attendanceImportTokens)
		.where(isNull(attendanceImportTokens.revokedAt));

	for (const row of rows) {
		const stored = Buffer.from(row.tokenHash);
		if (stored.length === candidateHash.length && timingSafeEqual(stored, candidateHash)) {
			await db
				.update(attendanceImportTokens)
				.set({ lastUsedAt: new Date() })
				.where(eq(attendanceImportTokens.id, row.id));
			return row.id;
		}
	}
	return null;
}

export interface ParsedPunch {
	empCode: string;
	firstName: string | null;
	lastName: string | null;
	deptCode: string | null;
	deptName: string | null;
	punchedAt: Date;
	/**
	 * The device's own {date} field, verbatim. This is the attendance day —
	 * never re-derived from punchedAt, because converting an instant back to a
	 * calendar date depends on the server's timezone and would move an early
	 * night-shift punch onto the previous day.
	 */
	punchDate: string;
	verifyType: string | null;
	punchState: string | null;
	direction: 'in' | 'out' | null;
	workCode: string | null;
	cardNumber: string | null;
	areaName: string | null;
	terminalAlias: string | null;
	terminalSn: string | null;
	temperature: string | null;
	maskFlag: string | null;
	rawLine: string;
}

/**
 * Column order of the EasyTime Pro "Data Template", exactly as configured:
 *
 *   {emp_code}\t{first_name}\t{last_name}\t{dept_code}\t{dept_name}\t{date}
 *   \t{time}\t{verify_type}\t{punch_state}\t{work_code}\t{card_number}
 *   \t{area_name}\t{terminal_alias}\t{terminal_sn}\t{temperature}\t{mask_flag}\r\n
 *
 * Date format yyyy-MM-DD, time format HH:mm. Trailing columns are tolerated as
 * optional so a template with fewer fields still imports; emp_code, date and
 * time are the only hard requirements.
 */
const COLUMNS = [
	'empCode',
	'firstName',
	'lastName',
	'deptCode',
	'deptName',
	'date',
	'time',
	'verifyType',
	'punchState',
	'workCode',
	'cardNumber',
	'areaName',
	'terminalAlias',
	'terminalSn',
	'temperature',
	'maskFlag'
] as const;

function clean(value: string | undefined): string | null {
	if (value === undefined) return null;
	const s = value.trim();
	return s === '' || s === '-' ? null : s;
}

/**
 * The devices report local wall-clock time with no zone, so the offset has to
 * be supplied. Defaults to IST; override with DEVICE_UTC_OFFSET if terminals
 * are ever installed in another zone.
 *
 * Without an explicit offset, `new Date('2026-08-05T01:30:00')` is interpreted
 * in the *server's* zone — which makes the same file import differently on a
 * UTC host (Railway) than on an IST laptop.
 */
const DEFAULT_DEVICE_UTC_OFFSET = '+05:30';

function deviceUtcOffset(): string {
	const raw = (env.DEVICE_UTC_OFFSET ?? '').trim();
	return /^[+-]\d{2}:\d{2}$/.test(raw) ? raw : DEFAULT_DEVICE_UTC_OFFSET;
}

/** The device zone as minutes east of UTC (+05:30 → 330), for building shifts. */
export function deviceUtcOffsetMinutes(): number {
	const [, sign, h, m] = /^([+-])(\d{2}):(\d{2})$/.exec(deviceUtcOffset())!;
	return (sign === '-' ? -1 : 1) * (Number(h) * 60 + Number(m));
}

/**
 * ZKTeco/EasyTime punch_state convention: 0 = check-in, 1 = check-out.
 * Some deployments emit text ("Check In"/"Check Out") or 4/5 for overtime
 * in/out, so both are handled. Anything unrecognised stays null and is
 * resolved by the check-in/check-out application logic rather than guessed.
 */
export function interpretPunchState(raw: string | null): 'in' | 'out' | null {
	if (raw === null) return null;
	const v = raw.trim().toLowerCase();
	if (v === '0' || v === '4' || v.includes('in')) return 'in';
	if (v === '1' || v === '5' || v.includes('out')) return 'out';
	return null;
}

/**
 * Parses an EasyTime Pro scheduled-export file (.txt/.csv, tab-separated).
 * Skips blank lines and a header row if the file happens to carry one.
 */
export function parseEasyTimeExport(body: string): ParsedPunch[] {
	const punches: ParsedPunch[] = [];
	const offset = deviceUtcOffset();

	for (const line of body.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		// Tolerate comma-separated files too — EasyTime allows .csv output.
		const cols = trimmed.includes('\t') ? trimmed.split('\t') : trimmed.split(',');

		const row: Record<string, string | null> = {};
		COLUMNS.forEach((name, i) => {
			row[name] = clean(cols[i]);
		});

		const empCode = row.empCode;
		const date = row.date;
		const time = row.time;
		if (!empCode || !date || !time) continue;

		// Header row (the template field names themselves, or a literal header).
		if (empCode.toLowerCase().includes('emp_code') || date.toLowerCase() === 'date') continue;

		// Pinned to the device's zone so the same file yields the same instant
		// regardless of where the portal runs.
		const clock = time.length === 5 ? `${time}:00` : time;
		const punchedAt = new Date(`${date}T${clock}${offset}`);
		if (Number.isNaN(punchedAt.getTime())) continue;

		punches.push({
			empCode,
			firstName: row.firstName,
			lastName: row.lastName,
			deptCode: row.deptCode,
			deptName: row.deptName,
			punchedAt,
			punchDate: date,
			verifyType: row.verifyType,
			punchState: row.punchState,
			direction: interpretPunchState(row.punchState),
			workCode: row.workCode,
			cardNumber: row.cardNumber,
			areaName: row.areaName,
			terminalAlias: row.terminalAlias,
			terminalSn: row.terminalSn,
			temperature: row.temperature,
			maskFlag: row.maskFlag,
			rawLine: trimmed
		});
	}

	return punches;
}

/** Employee codes are matched case-insensitively with surrounding space trimmed. */
export function normalizeEmpCode(code: string): string {
	return code.trim().toUpperCase();
}

export interface EasyTimeRecord {
	id?: number | string | null;
	emp_code?: string | number | null;
	first_name?: string | null;
	last_name?: string | null;
	dept_code?: string | number | null;
	dept_name?: string | null;
	department?: string | null;
	punch_time?: string | null;
	punch_state?: string | number | null;
	verify_type?: string | number | null;
	work_code?: string | number | null;
	card_number?: string | number | null;
	card_no?: string | number | null;
	area_alias?: string | null;
	area_name?: string | null;
	terminal_alias?: string | null;
	terminal_sn?: string | null;
	temperature?: string | number | null;
	mask_flag?: string | number | boolean | null;
	is_mask?: string | number | boolean | null;
}

const PUNCH_TIME = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/;

function recordField(record: Record<string, unknown>, ...keys: string[]): string | null {
	for (const key of keys) {
		const value = record[key];
		if (value === null || value === undefined || typeof value === 'object') continue;
		const cleaned = clean(String(value));
		if (cleaned !== null) return cleaned;
	}
	return null;
}

export function parseEasyTimeRecords(records: unknown[]): ParsedPunch[] {
	const punches: ParsedPunch[] = [];
	const offset = deviceUtcOffset();

	for (const item of records) {
		if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
		const record = item as Record<string, unknown>;

		const empCode = recordField(record, 'emp_code');
		const match = PUNCH_TIME.exec(recordField(record, 'punch_time') ?? '');
		if (!empCode || !match) continue;

		const [, date, time] = match;
		const clock = time.length === 5 ? `${time}:00` : time;
		const punchedAt = new Date(`${date}T${clock}${offset}`);
		if (Number.isNaN(punchedAt.getTime())) continue;

		const punchState = recordField(record, 'punch_state');

		punches.push({
			empCode,
			firstName: recordField(record, 'first_name'),
			lastName: recordField(record, 'last_name'),
			deptCode: recordField(record, 'dept_code'),
			deptName: recordField(record, 'dept_name', 'department'),
			punchedAt,
			punchDate: date,
			verifyType: recordField(record, 'verify_type'),
			punchState,
			direction: interpretPunchState(punchState),
			workCode: recordField(record, 'work_code'),
			cardNumber: recordField(record, 'card_number', 'card_no'),
			areaName: recordField(record, 'area_alias', 'area_name'),
			terminalAlias: recordField(record, 'terminal_alias'),
			terminalSn: recordField(record, 'terminal_sn'),
			temperature: recordField(record, 'temperature'),
			maskFlag: recordField(record, 'mask_flag', 'is_mask'),
			rawLine: JSON.stringify(record).slice(0, 2000)
		});
	}

	return punches;
}

export function punchDedupeKey(punch: Pick<ParsedPunch, 'empCode' | 'punchedAt'>): string {
	const minute = Math.floor(punch.punchedAt.getTime() / 60_000) * 60_000;
	return `${normalizeEmpCode(punch.empCode)}|${new Date(minute).toISOString().slice(0, 16)}Z`;
}

export interface PunchDay {
	checkInAt: Date | null;
	checkOutAt: Date | null;
}

export interface MergedPunchDay extends PunchDay {
	changed: 'checkInAt' | 'checkOutAt' | null;
}

export function mergePunch(
	day: PunchDay | null,
	punch: Pick<ParsedPunch, 'punchedAt' | 'direction'>
): MergedPunchDay {
	const checkInAt = day?.checkInAt ?? null;
	const checkOutAt = day?.checkOutAt ?? null;

	let isCheckIn: boolean;
	if (punch.direction === 'in') isCheckIn = true;
	else if (punch.direction === 'out') isCheckIn = false;
	else isCheckIn = !checkInAt;

	if (isCheckIn) {
		if (!checkInAt || punch.punchedAt < checkInAt) {
			return { checkInAt: punch.punchedAt, checkOutAt, changed: 'checkInAt' };
		}
	} else if (!checkOutAt || punch.punchedAt > checkOutAt) {
		return { checkInAt, checkOutAt: punch.punchedAt, changed: 'checkOutAt' };
	}

	return { checkInAt, checkOutAt, changed: null };
}

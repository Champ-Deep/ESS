/**
 * Reading the left-employee tracker for the Alumni tracker (Admin Controls ›
 * Alumni). Pure: the server (src/lib/server/alumni.ts) opens the workbook and
 * hands over header and cell values; everything that decides what a column
 * means lives here so it can be tested.
 *
 * The tracker is the master tracker's layout with exit columns added, so the
 * same headers are recognised ("Emp Code", "Name Of the Employee", "Team",
 * "Nature of Exit", "Reason") along with the leaving dates HR trackers use
 * ("Date of Leaving", "LWD", "Relieving Date", "Date of Resignation"…).
 * Columns that aren't recognised are kept verbatim in `details`, except ID
 * and bank numbers, which are never kept.
 */

export const ALUMNI_FIELDS = [
	'employeeCode',
	'fullName',
	'officialEmail',
	'personalEmail',
	'phone',
	'designation',
	'team',
	'department',
	'company',
	'dateOfJoining',
	'resignationDate',
	'lastWorkingDay',
	'natureOfExit',
	'reason',
	'remarks',
	'rehireEligible',
	'fnfStatus'
] as const;

export type AlumniField = (typeof ALUMNI_FIELDS)[number];

export const ALUMNI_DATE_FIELDS: AlumniField[] = ['dateOfJoining', 'resignationDate', 'lastWorkingDay'];

export type AlumniRow = { [K in AlumniField]: string | null } & { details: Record<string, string> };

/** "Official E Mail ", "Sub Process / Department", "F&F Status" → comparable text. */
export function normHeader(value: unknown): string {
	return String(value ?? '')
		.toLowerCase()
		.replace(/&/g, ' and ')
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

const ALIASES: Record<AlumniField, string[]> = {
	employeeCode: ['emp code', 'cipl emp code', 'employee code', 'employee id', 'emp id', 'emp no', 'employee no', 'employee number', 'code'],
	fullName: ['name of the employee', 'name of the champion', 'employee name', 'emp name', 'name', 'full name'],
	officialEmail: ['official e mail', 'official email', 'official mail', 'work email', 'office email', 'office e mail', 'company email'],
	personalEmail: ['personal e mail', 'personal email', 'personal mail'],
	phone: ['contact number', 'contact no', 'mobile', 'mobile number', 'mobile no', 'phone', 'phone number'],
	designation: ['designation', 'title', 'job title', 'role'],
	team: ['team', 'team and floor', 'process'],
	department: ['sub process department', 'department', 'sub process', 'dept'],
	company: ['company', 'entity', 'company name'],
	dateOfJoining: ['date of joining', 'doj', 'joining date', 'date of join'],
	resignationDate: ['date of resignation', 'resignation date', 'resigned on', 'resignation submitted on'],
	lastWorkingDay: [
		'last working day',
		'last working date',
		'lwd',
		'date of leaving',
		'leaving date',
		'dol',
		'relieving date',
		'date of relieving',
		'date of exit',
		'exit date',
		'separation date',
		'date of separation'
	],
	natureOfExit: ['nature of exit', 'exit type', 'type of exit', 'separation type', 'mode of exit', 'exit status', 'type of separation'],
	reason: ['reason', 'reason for leaving', 'reason of leaving', 'reason for exit', 'exit reason', 'reason for separation'],
	remarks: ['remarks', 'remark', 'comments', 'comment', 'notes'],
	rehireEligible: ['rehire', 'eligible for rehire', 'rehire eligibility', 'rehire eligible', 'eligible for re hire', 're hire'],
	fnfStatus: ['f and f', 'f and f status', 'fnf', 'fnf status', 'full and final', 'full and final settlement', 'f and f settlement', 'ff status']
};

const BY_HEADER = new Map<string, AlumniField>();
for (const field of ALUMNI_FIELDS) for (const alias of ALIASES[field]) BY_HEADER.set(alias, field);

export function fieldForHeader(header: unknown): AlumniField | null {
	return BY_HEADER.get(normHeader(header)) ?? null;
}

/** ID and bank columns: never stored, not even in `details`. */
export function isSensitiveHeader(header: unknown): boolean {
	const h = ` ${normHeader(header)} `;
	return /\b(aadh?aa?r|pan|uan|passport|voter|voters|dl|driving|bank|ifsc|account|esic|pf no|pf number)\b/.test(h);
}

/** How many columns a header row has that the tracker is known to use. */
export function headerScore(headers: unknown[]): number {
	return new Set(headers.map(fieldForHeader).filter(Boolean)).size;
}

const PLACEHOLDERS = new Set(['', '-', '--', 'na', 'n/a', 'nil', 'none', 'null', '0']);

/** A cell as text, or null for blank and "NA"-style placeholders. */
export function cellString(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
	const s = String(value).trim().replace(/'+$/, '');
	return PLACEHOLDERS.has(s.toLowerCase()) ? null : s;
}

const MON: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n: number) => String(n).padStart(2, '0');

function realDate(y: number, m: number, d: number): string | null {
	if (y < 100) y += y < 70 ? 2000 : 1900;
	const iso = `${y}-${pad(m)}-${pad(d)}`;
	const t = new Date(`${iso}T00:00:00Z`);
	return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === iso && y >= 1950 && y <= 2100 ? iso : null;
}

/**
 * Any date an HR sheet may hold → 'YYYY-MM-DD', or null. Excel dates, serial
 * numbers, ISO, and the day-first forms HR writes: 12/03/2024, 12-03-2024,
 * 12.03.2024, 12-Mar-2024, 12 March 2024, 12th Mar'24.
 */
export function toIsoDate(value: unknown): string | null {
	if (value === null || value === undefined || value === '') return null;
	if (value instanceof Date) {
		if (Number.isNaN(value.getTime())) return null;
		return realDate(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
	}
	if (typeof value === 'number') {
		if (value > 20000 && value < 80000) return toIsoDate(new Date(Date.UTC(1899, 11, 30) + Math.round(value) * 86_400_000));
		return null;
	}
	const s = String(value).trim().toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, '$1').replace(/['’]/g, ' ');
	let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
	if (m) return realDate(+m[1], +m[2], +m[3]);
	m = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/);
	if (m) return realDate(+m[3], +m[2], +m[1]);
	m = s.match(/^(\d{1,2})[\s\-/.,]*([a-z]{3})[a-z]*[\s\-/.,]*(\d{2,4})$/);
	if (m && MON[m[2]]) return realDate(+m[3], MON[m[2]], +m[1]);
	m = s.match(/^([a-z]{3})[a-z]*[\s\-/.,]+(\d{1,2})[\s,]+(\d{4})$/);
	if (m && MON[m[1]]) return realDate(+m[3], MON[m[1]], +m[2]);
	return null;
}

/**
 * One sheet row → an alumni record, or null when it has no name (a blank or
 * totals row). Repeated headers keep each column ("DOB", "DOB (2)").
 */
export function buildAlumniRow(headers: unknown[], cells: unknown[]): AlumniRow | null {
	const row = Object.fromEntries(ALUMNI_FIELDS.map((f) => [f, null])) as unknown as AlumniRow;
	row.details = {};
	const seen = new Map<string, number>();
	headers.forEach((header, i) => {
		const label = String(header ?? '').trim();
		if (!label || isSensitiveHeader(label)) return;
		const raw = cells[i];
		const field = fieldForHeader(label);
		if (field && row[field] === null) {
			row[field] = ALUMNI_DATE_FIELDS.includes(field) ? toIsoDate(raw) : cellString(raw);
			return;
		}
		const text = cellString(raw);
		if (text === null) return;
		const n = (seen.get(label) ?? 0) + 1;
		seen.set(label, n);
		row.details[n === 1 ? label : `${label} (${n})`] = text;
	});
	if (!row.fullName || /^\d+$/.test(row.fullName)) return null;
	row.fullName = row.fullName.replace(/\s+/g, ' ');
	if (row.employeeCode) row.employeeCode = row.employeeCode.toUpperCase().replace(/\s+/g, '');
	for (const f of ['officialEmail', 'personalEmail'] as const) if (row[f]) row[f] = row[f]!.toLowerCase();
	return row;
}

/** Who a record is, across uploads: the employee code, else name and leaving date. */
export function alumniKey(r: Pick<AlumniRow, 'employeeCode' | 'fullName' | 'lastWorkingDay' | 'dateOfJoining'>): string {
	if (r.employeeCode) return `code:${r.employeeCode}`;
	return `name:${(r.fullName ?? '').toLowerCase().replace(/\s+/g, ' ').trim()}|${r.lastWorkingDay ?? r.dateOfJoining ?? ''}`;
}

/** Years between joining and leaving, one decimal; null without both dates. */
export function tenureYears(dateOfJoining: string | null, lastWorkingDay: string | null): number | null {
	if (!dateOfJoining || !lastWorkingDay) return null;
	const ms = Date.parse(`${lastWorkingDay}T00:00:00Z`) - Date.parse(`${dateOfJoining}T00:00:00Z`);
	if (!Number.isFinite(ms) || ms < 0) return null;
	return Math.round((ms / (365.25 * 86_400_000)) * 10) / 10;
}

/** Picks the header row: the one of the first `scan` rows with the most known columns. */
export function findHeaderRow(rows: unknown[][], scan = 10): { index: number; score: number } {
	let best = { index: -1, score: 0 };
	rows.slice(0, scan).forEach((r, i) => {
		const score = headerScore(r);
		const hasName = r.some((c) => fieldForHeader(c) === 'fullName');
		if (hasName && score > best.score) best = { index: i, score };
	});
	return best;
}

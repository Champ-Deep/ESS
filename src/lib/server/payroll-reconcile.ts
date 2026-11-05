import ExcelJS from 'exceljs';
import { and, desc, eq } from 'drizzle-orm';
import { db } from './db/client';
import { payrollReconciliations, users } from './db/schema';
import { notHidden } from './hidden-users';
import {
	columnId,
	compareSheet,
	isCodeColumn,
	normCode,
	normDate,
	percent,
	type ColumnSpec,
	type Mismatch,
	type SheetComparison,
	type SheetId,
	type SheetRecords
} from '$lib/payroll-reconcile';
import { hhmm } from '$lib/payroll';
import { buildSheet, SHEET_TITLES, SHEETS, type SheetKey } from './payroll-export';
import type { PayrollReport } from './payroll';

/**
 * The A/B check, server side: reads HR's manual report (the salary report
 * workbook, the attendance tracker, or one sheet as CSV), lines it up with
 * the portal's computation for the same month, and records the result.
 */

type Grid = unknown[][];

/* ------------------------------------------------------------- reading */

/** A cell as its plain value: formula results, rich text and links unwrapped. */
function plain(v: unknown): unknown {
	if (v === null || v === undefined) return '';
	if (v instanceof Date) return v;
	if (typeof v === 'object') {
		const o = v as Record<string, unknown>;
		if ('result' in o) return plain(o.result);
		if ('richText' in o) return (o.richText as { text: string }[]).map((t) => t.text).join('');
		if ('text' in o) return plain(o.text);
		if ('error' in o) return '';
		if ('formula' in o || 'sharedFormula' in o) return '';
	}
	return v;
}

function parseCsv(text: string): Grid {
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = '';
	let quoted = false;
	const s = text.replace(/^﻿/, '');
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (quoted) {
			if (ch === '"' && s[i + 1] === '"') {
				cell += '"';
				i++;
			} else if (ch === '"') quoted = false;
			else cell += ch;
		} else if (ch === '"') quoted = true;
		else if (ch === ',') {
			row.push(cell);
			cell = '';
		} else if (ch === '\n' || ch === '\r') {
			if (ch === '\r' && s[i + 1] === '\n') i++;
			row.push(cell);
			rows.push(row);
			row = [];
			cell = '';
		} else cell += ch;
	}
	if (cell || row.length) {
		row.push(cell);
		rows.push(row);
	}
	// A leading apostrophe is how our own CSVs keep formulas inert.
	return rows.map((r) => r.map((c) => (c.startsWith("'") ? c.slice(1) : c)));
}

export async function readGrids(buf: Buffer, fileName: string): Promise<{ name: string; grid: Grid }[]> {
	if (/\.csv$/i.test(fileName)) return [{ name: fileName.replace(/\.csv$/i, ''), grid: parseCsv(buf.toString('utf8')) }];
	const wb = new ExcelJS.Workbook();
	await wb.xlsx.load(buf as unknown as ArrayBuffer);
	return wb.worksheets.map((ws) => {
		const grid: Grid = [];
		for (let r = 1; r <= ws.rowCount; r++) {
			const row = ws.getRow(r);
			const out: unknown[] = [];
			for (let c = 1; c <= ws.columnCount; c++) out.push(plain(row.getCell(c).value));
			grid.push(out);
		}
		return { name: ws.name, grid };
	});
}

/* ------------------------------------------------------------ records */

const WEEKDAYS = new Set(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']);
const MON: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** Column ids for a header row; a repeated header gets 2, 3… ("Comp Off" twice on the tracker). */
function headerIds(headers: unknown[]): string[] {
	const seen = new Map<string, number>();
	return headers.map((h) => {
		const id = columnId(h);
		if (!id) return '';
		const n = (seen.get(id) ?? 0) + 1;
		seen.set(id, n);
		return n === 1 ? id : `${id}${n}`;
	});
}

/** Minutes from a time cell: Excel time (a 1899 date or a day fraction) or "h:mm". */
function minutes(v: unknown): number | null {
	if (v instanceof Date) return v.getUTCHours() * 60 + v.getUTCMinutes();
	if (typeof v === 'number') return v < 2 ? Math.round(v * 1440) : null;
	const m = String(v ?? '').match(/^(\d{1,2}):(\d{2})/);
	return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

interface ParsedSheet {
	name: string;
	sheet: SheetId | null;
	columns: Set<string>;
	records: SheetRecords;
	hours: Map<string, Map<string, { bio: number | null; pro: number | null }>>;
	outsideDates: string[];
}

function guessSheet(name: string, ids: string[], isTracker: boolean): SheetId | null {
	const n = columnId(name);
	if (isTracker || n.includes('attendance') || n.includes('tracker')) return 'tracker';
	if (n.includes('leavebalance')) return 'leave-balance';
	if (n.includes('hrcomment') || n.includes('comment')) return 'hr-comments';
	if (n.includes('tobepaid') || n.includes('topay')) return 'to-be-paid';
	if (n.includes('stopsalary') || n.includes('hold')) return 'stop-salary';
	if (n === 'lop' || n.includes('lossofpay')) return 'lop';
	const has = (id: string) => ids.includes(id);
	if (has('opleavebal') || has('availedleave')) return 'leave-balance';
	if (has('comment')) return 'hr-comments';
	if (has('lop') && !has('doj')) return 'lop';
	if (has('lwd') && has('remarks')) return 'stop-salary';
	if (has('doj') && has('designation')) return 'to-be-paid';
	return null;
}

function parseGrid(name: string, grid: Grid, cycle: { dates: string[]; year: number }): ParsedSheet | null {
	const h = grid.slice(0, 15).findIndex((row) => row.some((c) => isCodeColumn(columnId(c))));
	if (h < 0) return null;
	const raw = grid[h];
	const ids = headerIds(raw);
	const above = grid[h - 1] ?? [];
	const inCycle = new Set(cycle.dates);
	const outside = new Set<string>();

	// Tracker day columns: Book3's "Biometric | Pro | <weekday>" under a date,
	// or the portal's own "7-Oct Biometric | 7-Oct Pro | 7-Oct Wednesday".
	const dayCol = new Map<number, { kind: 'day' | 'bio' | 'pro'; date: string }>();
	raw.forEach((cell, c) => {
		const text = String(cell ?? '').trim();
		const lower = text.toLowerCase();
		let date = '';
		let kind: 'day' | 'bio' | 'pro' | null = null;
		const own = text.match(/^(\d{1,2})-([A-Za-z]{3}) (Biometric|Pro|[A-Za-z]+day)$/);
		if (own && MON[own[2].toLowerCase()]) {
			const month = MON[own[2].toLowerCase()];
			date = cycle.dates.find((d) => Number(d.slice(5, 7)) === month && Number(d.slice(8)) === Number(own[1])) ?? `${cycle.year}-${String(month).padStart(2, '0')}-${own[1].padStart(2, '0')}`;
			kind = own[3] === 'Biometric' ? 'bio' : own[3] === 'Pro' ? 'pro' : 'day';
		} else if (WEEKDAYS.has(lower) || lower === 'biometric' || lower === 'pro') {
			date = normDate(above[c]);
			kind = lower === 'biometric' ? 'bio' : lower === 'pro' ? 'pro' : 'day';
		}
		if (!kind || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
		if (!inCycle.has(date)) {
			outside.add(date);
			return;
		}
		dayCol.set(c, { kind, date });
	});
	const isTracker = [...dayCol.values()].some((d) => d.kind === 'day');

	const codeIdx = ids.findIndex((id) => isCodeColumn(id));
	const nameIdx = ids.findIndex((id) => ['employeename', 'name', 'empname'].includes(id));
	const records: SheetRecords = { rows: new Map(), names: new Map() };
	const hours = new Map<string, Map<string, { bio: number | null; pro: number | null }>>();
	const columns = new Set<string>();
	ids.forEach((id, c) => id && !dayCol.has(c) && columns.add(id));
	for (const d of dayCol.values()) if (d.kind === 'day') columns.add(`day:${d.date}`);

	for (const row of grid.slice(h + 1)) {
		const code = normCode(row[codeIdx]);
		if (!code || isCodeColumn(columnId(code))) continue; // blank or a repeated header row
		if (records.rows.has(code)) continue;
		const rec = new Map<string, unknown>();
		ids.forEach((id, c) => {
			const dc = dayCol.get(c);
			if (dc) {
				if (dc.kind === 'day') rec.set(`day:${dc.date}`, row[c]);
				else {
					const byDate = hours.get(code) ?? new Map();
					const cur = byDate.get(dc.date) ?? { bio: null, pro: null };
					cur[dc.kind] = minutes(row[c]);
					byDate.set(dc.date, cur);
					hours.set(code, byDate);
				}
			} else if (id) rec.set(id, row[c]);
		});
		records.rows.set(code, rec);
		records.names.set(code, nameIdx >= 0 ? String(row[nameIdx] ?? '') : '');
	}
	return { name, sheet: guessSheet(name, ids, isTracker), columns, records, hours, outsideDates: [...outside].sort() };
}

/** What is compared on each sheet: the payroll figures, not names or titles. */
function specsFor(sheet: SheetId, report: PayrollReport): ColumnSpec[] {
	const n = (id: string, label: string): ColumnSpec => ({ id, label, kind: 'number' });
	const d = (id: string, label: string): ColumnSpec => ({ id, label, kind: 'date' });
	const t = (id: string, label: string): ColumnSpec => ({ id, label, kind: 'text' });
	switch (sheet) {
		case 'tracker':
			return [
				...report.dates.map((date): ColumnSpec => ({ id: `day:${date}`, label: date, kind: 'code' })),
				n('present', 'Present'), n('absent', 'Absent'), n('halfday', 'Half Day'), n('weekoff', 'Week Off'),
				n('halfdaycompoff', 'Half day Comp off'), n('compoff', 'Comp Off'), n('pinkleave', 'Pink Leave'), n('holidays', 'Holidays'),
				n('totaldays', 'Total Days'), n('actuallop', 'Actual LOP'), n('compoff2', 'Comp Off (days)'), d('lwd', 'LWD'), d('doj', 'DOJ')
			];
		case 'leave-balance':
			return [n('opleavebal', 'Op Leave Bal'), n('el', 'EL'), n('sl', 'SL'), n('compoff', 'Comp OFF'), n('availedleave', 'Availed Leave'), n('cl', 'CL'), d('lwd', 'LWD'), d('doj', 'DOJ')];
		case 'to-be-paid':
			return [d('doj', 'DOJ'), n('paiddays', 'Paid Days'), n('lopdays', 'LOP Days')];
		case 'lop':
			return [n('lop', 'LOP')];
		case 'stop-salary':
			return [d('lwd', 'LWD'), d('doj', 'DOJ')];
		case 'hr-comments':
			return [t('comment', 'Comment'), t('remarks', 'Remarks')];
	}
}

/** The portal's side, built from the very sheet the downloads start from. */
function portalSide(report: PayrollReport, sheet: SheetKey) {
	const base = buildSheet(report, sheet);
	const grid: Grid = [base.header, ...base.rows];
	const parsed = parseGrid(SHEET_TITLES[sheet], grid, { dates: report.dates, year: Number(report.endDate.slice(0, 4)) })!;
	// Where a mismatch would be written back as a manual edit.
	const ids = headerIds(base.header);
	const labelOf = new Map<string, string>();
	ids.forEach((id, c) => id && labelOf.set(id, base.header[c]));
	base.header.forEach((h) => {
		const m = h.match(/^(\d{1,2})-([A-Za-z]{3}) ([A-Za-z]+day)$/);
		if (!m) return;
		const date = report.dates.find((d) => Number(d.slice(5, 7)) === MON[m[2].toLowerCase()] && Number(d.slice(8)) === Number(m[1]));
		if (date) labelOf.set(`day:${date}`, h);
	});
	const codeIdx = ids.findIndex((id) => isCodeColumn(id));
	const rowKeyOf = new Map<string, string>();
	base.rows.forEach((r, i) => {
		const code = normCode(r[codeIdx]);
		if (code && !base.keys[i].startsWith('__') && !rowKeyOf.has(code)) rowKeyOf.set(code, base.keys[i]);
	});
	return { parsed, labelOf, rowKeyOf };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** A manual value written the way the portal's sheet writes it. */
function asSheetValue(spec: ColumnSpec | undefined, manual: string): string {
	if (spec?.kind === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(manual)) return `${manual.slice(8)}-${MONTHS[Number(manual.slice(5, 7)) - 1]}-${manual.slice(0, 4)}`;
	return manual;
}

export interface ReconSheetResult extends SheetComparison {
	title: string;
	manualSheet: string;
	mismatches: (Mismatch & { rowKey?: string; portalColumn?: string; value?: string })[];
}

export interface ReconResult {
	sheets: ReconSheetResult[];
	compared: number;
	matched: number;
	accuracy: number;
	notes: string[];
}

export async function reconcile(report: PayrollReport, buf: Buffer, fileName: string): Promise<ReconResult> {
	const grids = await readGrids(buf, fileName);
	const parsed = grids.map((g) => parseGrid(g.name, g.grid, { dates: report.dates, year: Number(report.endDate.slice(0, 4)) }));
	const notes: string[] = [];
	const sheets: ReconSheetResult[] = [];
	const used = new Set<SheetId>();

	grids.forEach((g, i) => {
		const p = parsed[i];
		if (!p) {
			if (g.grid.some((r) => r.some((c) => String(c ?? '').trim()))) notes.push(`"${g.name}": no employee code column found, so it was not compared.`);
			return;
		}
		if (!p.sheet) {
			notes.push(`"${g.name}": could not tell which payroll sheet this is, so it was not compared.`);
			return;
		}
		if (used.has(p.sheet)) {
			notes.push(`"${g.name}": a second ${SHEET_TITLES[p.sheet]} sheet; only the first was compared.`);
			return;
		}
		used.add(p.sheet);
		if (p.outsideDates.length) {
			notes.push(
				`"${g.name}" has ${p.outsideDates.length} day${p.outsideDates.length > 1 ? 's' : ''} outside ${report.cycleLabel} (${p.outsideDates.join(', ')}); those days were not compared, and its day counts include them.`
			);
		}

		const portal = portalSide(report, p.sheet);
		const specs = specsFor(p.sheet, report);
		const specById = new Map(specs.map((s) => [s.id, s]));
		const portalHours = new Map(report.employees.map((e) => [normCode(e.empCode), new Map(report.dates.map((d, k) => [d, e.days[k]]))]));
		const result = compareSheet(p.sheet, portal.parsed.records, p.records, specs, p.columns, (code, column) => {
			if (!column.startsWith('day:')) return undefined;
			const date = column.slice(4);
			const mine = portalHours.get(code)?.get(date);
			const theirs = p.hours.get(code)?.get(date);
			const part = (bio: number | null | undefined, pro: number | null | undefined) => `biometric ${hhmm(bio) || '—'}, ProHance ${hhmm(pro) || '—'}`;
			return `Portal: ${part(mine?.bio, mine?.pro)} · Manual: ${part(theirs?.bio, theirs?.pro)}`;
		});
		sheets.push({
			...result,
			title: SHEET_TITLES[p.sheet],
			manualSheet: g.name,
			mismatches: result.mismatches.map((m) => ({
				...m,
				rowKey: portal.rowKeyOf.get(m.code),
				portalColumn: portal.labelOf.get(m.column),
				value: asSheetValue(specById.get(m.column), m.manual)
			}))
		});
	});

	for (const s of SHEETS) if (!used.has(s)) notes.push(`${SHEET_TITLES[s]}: not in the uploaded file, so not compared.`);
	const compared = sheets.reduce((a, s) => a + s.compared, 0);
	const matched = sheets.reduce((a, s) => a + s.matched, 0);
	return { sheets, compared, matched, accuracy: percent(matched, compared), notes };
}

/* ------------------------------------------------------------ history */

export async function saveRun(cycleKey: string, fileName: string, result: ReconResult, userId: string): Promise<string> {
	const [row] = await db
		.insert(payrollReconciliations)
		.values({ cycleKey, fileName: fileName.slice(0, 200), comparedCells: result.compared, matchedCells: result.matched, result, uploadedBy: userId })
		.returning({ id: payrollReconciliations.id });
	return row.id;
}

export async function listRuns(cycleKey?: string) {
	const rows = await db
		.select({
			id: payrollReconciliations.id,
			cycleKey: payrollReconciliations.cycleKey,
			fileName: payrollReconciliations.fileName,
			compared: payrollReconciliations.comparedCells,
			matched: payrollReconciliations.matchedCells,
			createdAt: payrollReconciliations.createdAt,
			by: users.fullName
		})
		.from(payrollReconciliations)
		.leftJoin(users, and(eq(users.id, payrollReconciliations.uploadedBy), notHidden))
		.where(cycleKey ? eq(payrollReconciliations.cycleKey, cycleKey) : undefined)
		.orderBy(desc(payrollReconciliations.createdAt))
		.limit(50);
	return rows.map((r) => ({ ...r, accuracy: percent(r.matched, r.compared), createdAt: r.createdAt.toISOString() }));
}

export async function getRun(id: string) {
	const [row] = await db.select().from(payrollReconciliations).where(eq(payrollReconciliations.id, id)).limit(1);
	return row ? { id: row.id, cycleKey: row.cycleKey, fileName: row.fileName, createdAt: row.createdAt.toISOString(), result: row.result as ReconResult } : null;
}

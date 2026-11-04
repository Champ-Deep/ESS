import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireCap } from '$lib/server/capabilities';
import { loadPayroll } from '$lib/server/payroll';
import { payrollWorkbook, sheetCsv, SHEETS, SHEET_TITLES, type SheetKey } from '$lib/server/payroll-export';
import { logActivity } from '$lib/server/db/mongo';
import { loadOverrides } from '$lib/server/payroll-overrides';

/**
 * Payroll downloads. `?cycle=YYYY-MM` names the payroll month (26th → 25th);
 * `?sheet=` is one of SHEETS for a CSV, or `workbook` for every sheet in one
 * .xlsx — always with Finance's manual edits applied, so the file is exactly
 * what the Preview showed. Needs the "See payroll" privilege; every download
 * is logged.
 */
export const GET: RequestHandler = async (event) => {
	const user = requireCap(event, 'payroll.view');
	const cycle = event.url.searchParams.get('cycle') ?? '';
	if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(cycle)) throw error(400, 'cycle must be YYYY-MM');
	const sheet = event.url.searchParams.get('sheet') ?? 'workbook';
	if (sheet !== 'workbook' && !(SHEETS as readonly string[]).includes(sheet)) throw error(400, 'Unknown sheet');

	const [report, overrides] = await Promise.all([loadPayroll(cycle), loadOverrides(cycle)]);
	await logActivity({
		actorUserId: user.id,
		action: 'payroll.export',
		targetType: 'payroll',
		targetId: cycle,
		details: { sheet, employees: report.employees.length, editedSheets: Object.keys(overrides) }
	});

	if (sheet === 'workbook') {
		const body = await payrollWorkbook(report, overrides);
		return new Response(new Uint8Array(body), {
			headers: {
				'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
				'Content-Disposition': attachment(`CIPL Salary Report ${report.shortLabel}.xlsx`),
				'Cache-Control': 'no-store'
			}
		});
	}
	const key = sheet as SheetKey;
	return new Response(sheetCsv(report, key, overrides[key] ?? []), {
		headers: {
			'Content-Type': 'text/csv; charset=utf-8',
			'Content-Disposition': attachment(`${SHEET_TITLES[key]} ${report.shortLabel}.csv`),
			'Cache-Control': 'no-store'
		}
	});
};

/** A download filename that survives the apostrophe in "Oct'26". */
function attachment(name: string): string {
	const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
	return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireCap } from '$lib/server/capabilities';
import { loadPayroll } from '$lib/server/payroll';
import { getRun, listRuns, reconcile, saveRun } from '$lib/server/payroll-reconcile';
import { logActivity } from '$lib/server/db/mongo';

const CYCLE = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_BYTES = 10 * 1024 * 1024;

/**
 * The payroll A/B check. POST a manually made report (.xlsx or .csv) with
 * `?cycle=YYYY-MM` to compare it with the portal's computation for that
 * month; GET `?cycle=` lists past checks, `?id=` returns one. "See payroll"
 * can run and read checks; writing a manual value back is a sheet edit and
 * needs "Edit payroll" (PUT /api/payroll/sheet).
 */
export const GET: RequestHandler = async (event) => {
	requireCap(event, 'payroll.view');
	const id = event.url.searchParams.get('id');
	if (id) {
		if (!/^[0-9a-f-]{36}$/i.test(id)) throw error(400, 'Bad id');
		const run = await getRun(id);
		if (!run) throw error(404, 'No such check');
		return json(run);
	}
	const cycle = event.url.searchParams.get('cycle') ?? undefined;
	if (cycle && !CYCLE.test(cycle)) throw error(400, 'cycle must be YYYY-MM');
	return json({ runs: await listRuns(cycle) });
};

export const POST: RequestHandler = async (event) => {
	const actor = requireCap(event, 'payroll.view');
	const cycle = event.url.searchParams.get('cycle') ?? '';
	if (!CYCLE.test(cycle)) throw error(400, 'cycle must be YYYY-MM');
	const form = await event.request.formData().catch(() => null);
	const file = form?.get('file');
	if (!(file instanceof File) || file.size === 0) throw error(400, 'Choose the manual report file');
	if (file.size > MAX_BYTES) throw error(413, 'The file is over 10 MB');
	if (!/\.(xlsx|csv)$/i.test(file.name)) throw error(400, 'Upload the report as .xlsx or .csv');

	const report = await loadPayroll(cycle);
	let result;
	try {
		result = await reconcile(report, Buffer.from(await file.arrayBuffer()), file.name);
	} catch (err) {
		console.error('[payroll] reconcile failed', err);
		throw error(400, 'Could not read that file. Save it as .xlsx or .csv and try again.');
	}
	if (result.sheets.length === 0) throw error(400, `Nothing in "${file.name}" could be compared. ${result.notes.slice(0, 3).join(' ')}`);
	const id = await saveRun(cycle, file.name, result, actor.id);
	await logActivity({
		actorUserId: actor.id,
		action: 'payroll.ab_check',
		targetType: 'payroll',
		targetId: cycle,
		details: { file: file.name, compared: result.compared, matched: result.matched, accuracy: result.accuracy }
	});
	return json({ id, cycleKey: cycle, fileName: file.name, createdAt: new Date().toISOString(), result });
};

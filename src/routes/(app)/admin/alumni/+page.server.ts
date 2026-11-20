import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { gateAdminPage } from '$lib/server/capabilities';
import { alumniPageData, closeLeaverLogins, importAlumniTracker, reopenLogin } from '$lib/server/alumni';

/**
 * Alumni: the left-employee tracker, uploaded by HR, kept as one record per
 * former employee (src/lib/server/alumni.ts).
 */
export const load: PageServerLoad = async ({ locals }) => {
	gateAdminPage(locals, ['people.alumni']);
	return alumniPageData();
};

/** The tracker is a few hundred KB; this leaves room for years of leavers. */
const MAX_BYTES = 8 * 1024 * 1024;

export const actions: Actions = {
	upload: async ({ locals, request }) => {
		const actor = gateAdminPage(locals, ['people.alumni']);
		const file = (await request.formData()).get('file');
		if (!(file instanceof File) || file.size === 0) return fail(400, { error: 'Choose the left-employee tracker to upload' });
		if (file.size > MAX_BYTES) return fail(400, { error: 'That file is over 8 MB. Upload just the left-employee sheet.' });
		const r = await importAlumniTracker(actor, { name: file.name, buffer: Buffer.from(await file.arrayBuffer()) });
		if (!r.ok) return fail(400, { error: r.message });
		return { imported: r };
	},
	close: async ({ locals, request }) => {
		const actor = gateAdminPage(locals, ['people.alumni']);
		const r = await closeLeaverLogins(actor, (await request.formData()).getAll('userId').map(String));
		return r.ok ? { message: r.message } : fail(400, { error: r.message });
	},
	reopen: async ({ locals, request }) => {
		const actor = gateAdminPage(locals, ['people.alumni']);
		const r = await reopenLogin(actor, String((await request.formData()).get('userId') ?? ''));
		return r.ok ? { message: r.message } : fail(400, { error: r.message });
	}
};

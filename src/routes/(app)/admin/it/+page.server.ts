import type { PageServerLoad } from './$types';
import { gateAdminPage } from '$lib/server/capabilities';
import { itDashboard, withoutEmployeeCode } from '$lib/server/it-dashboard';

/** The IT team's dashboard (src/lib/server/it-dashboard.ts). */
export const load: PageServerLoad = async ({ locals }) => {
	gateAdminPage(locals, ['it.dashboard']);
	const [dash, noCode] = await Promise.all([itDashboard(), withoutEmployeeCode()]);
	return { ...dash, noCode };
};

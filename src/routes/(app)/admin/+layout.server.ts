import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { loadAdminFacts } from '$lib/server/admin-health';
import { adminStrips, deriveAdminIssues } from '$lib/admin-issues';
import { canOpenAdmin } from '$lib/capabilities';

/**
 * The floor for everything under /admin: anyone holding a privilege that opens
 * an admin tab (src/lib/capabilities.ts) — HR Admins and Super Admins by
 * default, and named roles such as IT Support.
 *
 * Five pages each carried an identical inline copy of this check, which meant
 * a new admin page was one forgotten redirect away from being reachable by an
 * employee. The two pages whose floor this exactly matches (biometric upload,
 * leave balances) now rely on it; the three that are deliberately stricter
 * (data cleanup, publish policies, design tweaks) keep their own Super
 * Admin-only check, because the floor is not the same as their rule.
 *
 * This does not belong in hooks.server.ts: that layer authenticates every
 * request for the whole app, and folding one route subtree's authorisation
 * into it would put the rule at the wrong level and hide it from anyone
 * reading these routes.
 *
 * It also computes what the Admin Controls shell shows on every tab: the
 * attention list, the status dot on each tab and each section's summary.
 */
export const load: LayoutServerLoad = async ({ locals, url }) => {
	// Anyone holding a privilege that opens an admin tab gets in — HR Admins and
	// Super Admins by default, and named roles such as IT Support. Each page
	// then checks its own privilege (gateAdminPage).
	const user = locals.user;
	const caps = user?.capabilities ?? [];
	if (!user || !canOpenAdmin(caps)) {
		throw redirect(303, '/dashboard');
	}
	const role = user.role;

	// Read on purpose: it makes this load re-run on every tab switch, so the
	// tab dots reflect a fix made on the previous tab rather than the state
	// when Admin Controls was first opened.
	void url.pathname;

	const now = new Date();
	const facts = await loadAdminFacts(now);
	const issues = deriveAdminIssues(facts, caps, now);

	return {
		adminRole: role,
		adminCaps: caps,
		adminIssues: issues,
		adminStrips: adminStrips(facts, now, caps),
		// Overrides the (app) layout's figure, so the sidebar badge is fresh here.
		adminIssueCount: issues.filter((i) => i.severity !== 'info').length
	};
};

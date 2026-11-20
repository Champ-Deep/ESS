import type { PageServerLoad } from './$types';
import { actions as teamActions, load as teamLoad } from '../../team/+page.server';
import { gateAdminPage } from '$lib/server/capabilities';
import { PEOPLE_TAB_KEYS } from '$lib/capabilities';

/**
 * People, inside Admin Controls, is the Team page itself — same load, same
 * form actions — so there is one roster implementation, not two drifting
 * copies. Team Leads keep reaching it at /team from the sidebar; admins reach
 * it here with the Admin Controls tab bar around it.
 *
 * The forms on that page post to relative `?/action` URLs, so they land back
 * on this route and keep the tab bar.
 *
 * Gated on the People tab's own privileges, like every admin page: the Team
 * page's wider rule (anyone who reaches other people) let support-team members
 * in by typing the address, though the tab is not theirs.
 */
export const load: PageServerLoad = async (event) => {
	gateAdminPage(event.locals, PEOPLE_TAB_KEYS);
	return teamLoad(event as unknown as Parameters<typeof teamLoad>[0]);
};
export const actions = teamActions;

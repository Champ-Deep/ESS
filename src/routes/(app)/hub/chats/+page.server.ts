import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { hasCap, answerableDesks } from '$lib/server/capabilities';
import { sidebarFor } from '$lib/server/chat/channels';
import { channelCreationScope } from '$lib/server/chat/access';

/** Every conversation, as a list. The live chat stream keeps it current after this first paint. */
export const load: PageServerLoad = async ({ locals }) => {
	const user = locals.user;
	if (!user) throw redirect(303, '/login');
	return {
		sidebar: await sidebarFor(user),
		can: { createChannels: channelCreationScope(user), hrDesk: hasCap(user, 'chat.hr_desk'), desks: answerableDesks(user) }
	};
};

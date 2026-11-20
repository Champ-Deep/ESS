import { redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { hasCap, answerableDesks } from '$lib/server/capabilities';
import { sidebarFor } from '$lib/server/chat/channels';
import { channelCreationScope } from '$lib/server/chat/access';
import { loadFeed } from '$lib/server/announcements';
import { announcementActions, loadAnnouncementAdmin } from '$lib/server/announcement-admin';
import { champConfigured } from '$lib/server/champ/chat';

/**
 * One conversation in Champ Hub, full width. Everything Champ Chat's page
 * did lives here: messages, threads, details, #announcements with its post
 * and manage view (and the form actions it posts to), and Champ itself.
 */
export const load: PageServerLoad = async ({ locals }) => {
	const user = locals.user;
	if (!user) throw redirect(303, '/login');
	const canPost = hasCap(user, 'announcements.post');
	const [sidebar, feed, admin] = await Promise.all([sidebarFor(user), loadFeed(user.id), canPost ? loadAnnouncementAdmin() : Promise.resolve(null)]);
	return {
		me: { id: user.id, fullName: user.fullName, role: user.role, teamId: user.teamId },
		can: {
			postAnnouncements: canPost,
			createChannels: channelCreationScope(user),
			hrDesk: hasCap(user, 'chat.hr_desk'),
			desks: answerableDesks(user),
			moderate: hasCap(user, 'chat.moderate'),
			export: hasCap(user, 'chat.export'),
			mentionAll: hasCap(user, 'chat.mention_all'),
			champ: champConfigured()
		},
		sidebar,
		feed,
		announcementAdmin: admin,
		now: new Date().toISOString()
	};
};

export const actions: Actions = announcementActions as unknown as Actions;

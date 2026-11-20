import { redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { hasCap, answerableDesks } from '$lib/server/capabilities';
import { sidebarFor } from '$lib/server/chat/channels';
import { channelCreationScope } from '$lib/server/chat/access';
import { loadFeed } from '$lib/server/announcements';
import { announcementActions, loadAnnouncementAdmin } from '$lib/server/announcement-admin';
import { champConfigured } from '$lib/server/champ/chat';

/**
 * Champ Chat. The page renders the first sidebar on the server; after that
 * the live stream (/api/chat/stream) and /api/chat/* keep it current.
 *
 * #announcements is part of chat: everyone reads the announcement feed here,
 * and people who may post announcements get the composer and read counts.
 */
export const load: PageServerLoad = async ({ locals, url }) => {
	// Page loads run alongside the (app) layout's, so this cannot rely on the
	// layout's redirect having happened first.
	const user = locals.user;
	if (!user) throw redirect(303, '/login');

	// Champ Chat now lives in Champ Hub (/hub). Old links — ESS notices, push
	// notifications, bookmarks — land on the same conversation there. The
	// previous layout stays reachable with ?classic=1 while people get used to
	// the Hub; drop it, ChatSidebar.svelte and this page together later.
	if (!url.searchParams.has('classic')) {
		const params = new URLSearchParams(url.searchParams);
		const c = params.get('c');
		params.delete('c');
		const rest = params.toString();
		throw redirect(307, c ? `/hub/c/${encodeURIComponent(c)}${rest ? `?${rest}` : ''}` : '/hub/chats');
	}
	const canPost = hasCap(user, 'announcements.post');
	const [sidebar, feed, admin] = await Promise.all([
		sidebarFor(user),
		loadFeed(user.id),
		canPost ? loadAnnouncementAdmin() : Promise.resolve(null)
	]);
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

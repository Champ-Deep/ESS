import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { gateAdminPage } from '$lib/server/capabilities';
import { loadChatPolicy, saveChatPolicy } from '$lib/server/chat/access';
import { logActivity } from '$lib/server/db/mongo';
import type { ChatPolicy } from '$lib/chat/policy';

/**
 * Chat rules: who an Employee may message directly, and who may start group
 * chats. People holding "Message anyone" (Team Leads, HR, Super Admins and any
 * named role given it) are not limited by the message rule.
 */
export const load: PageServerLoad = async ({ locals }) => {
	gateAdminPage(locals, ['chat.manage_rules']);
	return { policy: await loadChatPolicy() };
};

export const actions: Actions = {
	save: async ({ locals, request }) => {
		const actor = gateAdminPage(locals, ['chat.manage_rules']);
		const f = await request.formData();
		const on = (k: string) => f.get(k) === 'on';
		const next: ChatPolicy = {
			dm: {
				team: on('team'),
				managerAndReports: on('managerAndReports'),
				concernedHr: on('concernedHr'),
				allHr: on('allHr'),
				everyone: on('everyone')
			},
			groups: f.get('groups') === 'privileged' ? 'privileged' : 'everyone'
		};
		if (!next.dm.everyone && !next.dm.allHr && !next.dm.concernedHr) {
			return fail(400, { error: 'Keep at least one way to reach HR, so nobody is left without a route to raise a concern.' });
		}
		const before = await loadChatPolicy();
		const saved = await saveChatPolicy(next);
		await logActivity({ actorUserId: actor.id, action: 'chat.rules_update', targetType: 'app_setting', targetId: 'chat_policy', details: { before, after: saved } });
		return { message: 'Chat rules saved. They apply to new conversations straight away.' };
	}
};

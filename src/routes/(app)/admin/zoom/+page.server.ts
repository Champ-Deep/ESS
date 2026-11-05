import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db/client';
import { users } from '$lib/server/db/schema';
import { and, asc, eq } from 'drizzle-orm';
import { notHidden } from '$lib/server/hidden-users';
import { gateAdminPage } from '$lib/server/capabilities';
import { readStatus, zoomConfigured } from '$lib/server/zoom/client';
import { linkZoomUser, reconcileZoom, zoomLinks } from '$lib/server/meetings/service';

/**
 * Admin Controls › Zoom: is the Zoom app connected, has Zoom been sending
 * events, and which Zoom names belong to which login. The credentials live
 * in the server's environment; this page only says which ones are set.
 */
export const load: PageServerLoad = async ({ locals, url }) => {
	gateAdminPage(locals, ['system.zoom']);
	const [status, links, people] = await Promise.all([
		readStatus(),
		zoomLinks(),
		db.select({ id: users.id, fullName: users.fullName }).from(users).where(and(eq(users.isActive, true), notHidden)).orderBy(asc(users.fullName))
	]);
	return {
		configured: zoomConfigured(),
		vars: {
			ZOOM_ACCOUNT_ID: !!env.ZOOM_ACCOUNT_ID,
			ZOOM_CLIENT_ID: !!env.ZOOM_CLIENT_ID,
			ZOOM_CLIENT_SECRET: !!env.ZOOM_CLIENT_SECRET,
			ZOOM_WEBHOOK_SECRET: !!env.ZOOM_WEBHOOK_SECRET,
			ZOOM_DEFAULT_HOST: !!env.ZOOM_DEFAULT_HOST
		},
		defaultHost: env.ZOOM_DEFAULT_HOST?.trim() || null,
		webhookUrl: `${(env.PORTAL_URL || url.origin).replace(/\/+$/, '')}/api/zoom/webhook`,
		status,
		links: links.links.map((l) => ({ ...l, createdAt: l.createdAt.toISOString() })),
		unmatched: links.unmatched,
		people
	};
};

export const actions: Actions = {
	link: async ({ locals, request }) => {
		const actor = gateAdminPage(locals, ['system.zoom']);
		const f = await request.formData();
		const r = await linkZoomUser(actor, String(f.get('zoomKey') ?? ''), String(f.get('userId') ?? '') || null);
		if (!r.ok) return fail(400, { error: r.message });
		return { message: f.get('userId') ? 'Saved. Meetings they host, and meetings they join, use this Zoom account.' : 'Removed.' };
	},
	check: async ({ locals }) => {
		gateAdminPage(locals, ['system.zoom']);
		if (!zoomConfigured()) return fail(400, { error: 'Set the Zoom variables on the server first.' });
		try {
			await reconcileZoom();
			return { message: 'Checked Zoom for summaries from the last three days.' };
		} catch (err) {
			return fail(502, { error: `Zoom did not answer: ${err instanceof Error ? err.message : String(err)}` });
		}
	}
};

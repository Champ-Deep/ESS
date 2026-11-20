import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireCap } from '$lib/server/capabilities';
import { approveLoginEmails, cancelLoginEmails, changeLoginEmail, holdLoginEmails, listLoginEmails, searchLoginPeople, sendLoginEmailsNow, sendLoginEmailsToPeopleNow, setCadence } from '$lib/server/login-emails';

/**
 * The queue of login emails waiting for approval (src/lib/server/
 * login-emails.ts). Everything here needs "Approve login emails".
 */

const UUID = /^[0-9a-f-]{36}$/i;

export const GET: RequestHandler = async (event) => {
	requireCap(event, 'people.send_logins');
	// ?q= finds anyone on the roster (name, email or employee code) to send to.
	const q = event.url.searchParams.get('q');
	if (q !== null) return json({ people: await searchLoginPeople(q) });
	return json(await listLoginEmails());
};

export const POST: RequestHandler = async (event) => {
	const actor = requireCap(event, 'people.send_logins');
	const data = (await event.request.json().catch(() => ({}))) as { action?: string; ids?: unknown; userIds?: unknown; cadenceSeconds?: unknown };
	const ids = Array.isArray(data.ids) ? data.ids.map(String).filter((x) => UUID.test(x)).slice(0, 1000) : [];
	// Change email (a mistyped address from the HR sheet), optionally sending at once.
	if (data.action === 'change_email') {
		const body = data as { userId?: unknown; email?: unknown; sendNow?: unknown };
		const userId = String(body.userId ?? '');
		if (!UUID.test(userId)) return json({ message: 'Pick someone first' }, { status: 400 });
		const changed = await changeLoginEmail(actor, userId, String(body.email ?? ''));
		if (!changed.ok) return json({ message: changed.message }, { status: 400 });
		const sent = body.sendNow === true ? await sendLoginEmailsToPeopleNow(actor, [userId]) : null;
		return json({ ok: true, message: changed.message, clerk: changed.clerk, results: sent && sent.ok ? sent.results : [], sendError: sent && !sent.ok ? sent.message : null });
	}
	// Send now / Resend: at once, not at the queue's cadence.
	if (data.action === 'send_now' || data.action === 'send_now_people') {
		const userIds = Array.isArray(data.userIds) ? data.userIds.map(String).filter((x) => UUID.test(x)) : [];
		const r = data.action === 'send_now' ? await sendLoginEmailsNow(actor, ids) : await sendLoginEmailsToPeopleNow(actor, userIds);
		return r.ok ? json(r) : json({ message: r.message }, { status: 400 });
	}
	const r =
		data.action === 'approve'
			? await approveLoginEmails(actor, ids)
			: data.action === 'approve_all'
				? await approveLoginEmails(actor, [])
				: data.action === 'hold'
					? await holdLoginEmails(actor, ids)
					: data.action === 'cancel'
						? await cancelLoginEmails(actor, ids)
						: data.action === 'cadence'
							? await setCadence(actor, Number(data.cadenceSeconds))
							: null;
	if (!r) throw error(400, 'Unknown action');
	return r.ok ? json(r) : json({ message: r.message }, { status: 400 });
};

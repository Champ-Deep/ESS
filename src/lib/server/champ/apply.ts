import type { RequestEvent } from '@sveltejs/kit';
import { db } from '$lib/server/db/postgres';
import { sql } from 'drizzle-orm';
import { logActivity } from '$lib/server/db/mongo';
import { createLogin } from '$lib/server/logins';
import { saveNamedRole } from '$lib/server/roles';
import { syncMembershipFor } from '$lib/server/chat/sync';
import { decisionEndpoint, type RequestKind } from '$lib/server/chat/cards';
import type { Role, SessionUser } from '$lib/server/auth';
import type { ChampCardKind } from '$lib/champ';

/**
 * What a Champ card's button does. Wherever the portal already has an
 * endpoint for the job, the card calls that endpoint (event.fetch carries the
 * person's session), so a card can never do more than the same person could
 * do on the page itself — the same checks run either way.
 */

export type ApplyResult = { ok: true; message: string } | { ok: false; message: string };

async function viaEndpoint(event: RequestEvent, url: string, method: string, body: unknown): Promise<ApplyResult> {
	const res = await event.fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
	if (res.ok) return { ok: true, message: 'Done' };
	const err = await res.json().catch(() => ({}));
	return { ok: false, message: err.message ?? `That did not work (${res.status})` };
}

export async function applyCard(event: RequestEvent, kind: ChampCardKind, action: string, payload: Record<string, unknown>, note?: string): Promise<ApplyResult> {
	const user = event.locals.user!;
	let result: ApplyResult;

	switch (kind) {
		case 'leave_request':
			result = await viaEndpoint(event, '/api/leave', 'POST', payload);
			break;
		case 'correction':
			result = await viaEndpoint(event, '/api/attendance/deviations', 'POST', payload);
			break;
		case 'comp_off':
			result = await viaEndpoint(event, '/api/attendance/comp-off', 'POST', payload);
			break;
		case 'approve': {
			if (action !== 'approve' && action !== 'reject') return { ok: false, message: 'Approve or reject' };
			const reqKind = String(payload.requestKind) as RequestKind;
			result = await viaEndpoint(event, decisionEndpoint(reqKind, String(payload.id)), 'POST', { decision: action, note: note ?? undefined, via: 'champ' });
			break;
		}
		case 'settings_change':
		case 'role_change':
			result = await viaEndpoint(event, `/api/admin/users/${String(payload.userId)}/settings`, 'PUT', payload.body);
			break;
		case 'create_login': {
			const r = await createLogin(user, payload as never, { source: 'champ' });
			if (!r.success) return { ok: false, message: r.message };
			void syncMembershipFor(r.userId).catch(() => {});
			result = {
				ok: true,
				message: `Created. The welcome email to ${r.email} waits for an admin to approve it in Admin Controls › People. ${r.tempPassword ? `Temporary password: ${r.tempPassword}` : 'No password is set: they sign in with a code sent to their email, then choose their own.'}`
			};
			break;
		}
		case 'named_role': {
			const r = await saveNamedRole(user, payload as { name: string; baseRole: Role; capabilities: string[] });
			result = r.ok ? { ok: true, message: 'Role saved' } : r;
			break;
		}
		case 'task': {
			const toUserId = String(payload.toUserId);
			if (!/^[0-9a-f-]{36}$/i.test(toUserId)) return { ok: false, message: 'That person no longer exists' };
			const { createTask } = await import('$lib/server/tasks/service');
			const due = typeof payload.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(payload.due) ? payload.due : null;
			const r = await createTask(user, { title: String(payload.title ?? ''), assigneeId: toUserId, dueDate: due });
			if (!r.ok) return { ok: false, message: r.message };
			result = { ok: true, message: r.task.requestState === 'pending' ? `Made for ${r.task.assignee?.fullName}. It starts once ${r.task.approver?.fullName ?? 'their lead'} approves.` : `Assigned to ${r.task.assignee?.fullName}` };
			break;
		}
		default:
			return { ok: false, message: 'Nothing to apply for this card' };
	}

	await logActivity({
		actorUserId: user.id,
		action: 'champ.apply',
		targetType: 'champ_card',
		details: { kind, action, ok: result.ok, message: result.ok ? null : result.message }
	}).catch(() => {});
	return result;
}

/**
 * Tasks in Champ's Requests tab: yours to do, and ones you handed out. They
 * are Champ Hub tasks (src/lib/server/tasks/service.ts); this is the short
 * list view of them the panel has always shown.
 */
export async function listTasks(userId: string) {
	const rows = await db.execute(
		sql`
			select t.id, t.title,
				case when t.status = 'done' then 'done' when t.request_state = 'declined' then 'declined' else 'open' end as status,
				t.request_note as note, t.due_date as "dueAt", t.created_at as "createdAt", t.completed_at as "decidedAt",
				t.assignee_id = ${userId} as "mine", f.full_name as "fromName", coalesce(tu.full_name, 'Unassigned') as "toName"
			from tasks t
			join users f on f.id = t.created_by
			left join users tu on tu.id = t.assignee_id
			where (t.assignee_id = ${userId} or t.created_by = ${userId})
				and (t.status <> 'done' or t.completed_at > now() - interval '14 days')
			order by t.created_at desc
			limit 60
		`
	);
	return rows.rows;
}

export async function decideTask(user: SessionUser, taskId: string, action: 'done' | 'decline' | 'withdraw', note: string): Promise<ApplyResult> {
	const svc = await import('$lib/server/tasks/service');
	const r =
		action === 'done'
			? await svc.moveTask(user, taskId, { status: 'done' })
			: action === 'decline'
				? await svc.respondToTask(user, taskId, 'decline', note)
				: await svc.deleteTask(user, taskId);
	if (!r.ok) return { ok: false, message: r.message };
	return { ok: true, message: action === 'done' ? 'Marked done' : action === 'decline' ? 'Declined' : 'Withdrawn' };
}

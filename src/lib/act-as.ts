/**
 * Opening a blue-collar worker's portal.
 *
 * Blue-collar staff (src/lib/no-login.ts) never sign in, so the people who look
 * after them open their portal instead: the whole portal as that worker —
 * apply leave, check attendance, keep their details — with a banner saying
 * whose it is and a way back. What is done there is done as the worker, and
 * goes through the same approvals as if they had signed in themselves.
 *
 * Who may:
 *   Super Admin, HR Admin   any blue-collar worker
 *   their leaders           anyone above them on the solid reporting line, and
 *                           the lead of their team
 *
 * Never anyone with a login of their own: this is standing in for someone who
 * cannot sign in, not a way to read another person's account.
 *
 * Deliberately DB-free, like org-scope.ts, so it unit-tests directly. The
 * cookie and the lookups live in src/lib/server/act-as.ts.
 */

import { isNoLoginEmail } from './no-login';

export interface PortalActor {
	id: string;
	role: 'super_admin' | 'admin' | 'team_lead' | 'employee';
}

export interface PortalTarget {
	id: string;
	email: string;
	isActive: boolean;
}

export interface PortalLeaders {
	/** Everyone above the worker on the solid line, nearest first. */
	chainAbove: readonly string[];
	/** The lead of the worker's team, if it has one. */
	teamLeadId: string | null;
}

export function mayOpenPortal(actor: PortalActor, target: PortalTarget, leaders: PortalLeaders): boolean {
	if (actor.id === target.id || !target.isActive || !isNoLoginEmail(target.email)) return false;
	if (actor.role === 'super_admin' || actor.role === 'admin') return true;
	return leaders.chainAbove.includes(actor.id) || leaders.teamLeadId === actor.id;
}

/**
 * Walks `reportsTo` upward from `personId`. Stops at a loop or after `limit`
 * steps, so bad data can never hang a request.
 */
export function chainAbove(personId: string, reportsToOf: ReadonlyMap<string, string | null>, limit = 20): string[] {
	const out: string[] = [];
	let cursor = reportsToOf.get(personId) ?? null;
	while (cursor && !out.includes(cursor) && cursor !== personId && out.length < limit) {
		out.push(cursor);
		cursor = reportsToOf.get(cursor) ?? null;
	}
	return out;
}

import { db } from '$lib/server/db/client';
import {
	attendanceDeviations,
	chatChannels,
	chatMessages,
	compOffCredits,
	employeeProfiles,
	leaveApplications,
	leaveTypes,
	users
} from '$lib/server/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { inArray } from '$lib/server/db/sql';
import type { SessionUser } from '$lib/server/auth';
import { canReviewStage, managerFor, reportsToChief, assignedHrFor } from '$lib/server/approval-chain';
import { ensureSystemFeed } from './access';
import { publish } from './bus';
import { deliverNotification } from './notify';
import { notHidden } from '$lib/server/hidden-users';

/**
 * ESS cards in Champ Chat. A leave request, attendance correction or comp-off
 * claim appears in each approver's ESS feed as a card with Approve and Reject;
 * a decision updates every copy of the card and tells the requester.
 *
 * The card stores only what it is about ({ type, id }). What it shows — status,
 * dates, who may act — is read fresh each time it is displayed, so a card can
 * never show a stale state or offer a button that would no longer work, and
 * the button itself calls the same endpoint as the Leave page.
 */

export type RequestKind = 'leave' | 'deviation' | 'comp_off';

export type CardRef =
	| { type: RequestKind; id: string }
	| { type: 'notice'; tone: 'ok' | 'bad' | 'info' | 'warn'; title: string; text?: string; href?: string }
	| { type: 'reminder'; text: string; channelId?: string | null }
	| { type: 'poll'; question: string; options: string[] }
	| { type: 'celebration'; kind: 'birthday' | 'anniversary'; userId: string; name: string; years?: number }
	| { type: 'report'; reportId: string; messageId: string; reason: string };

const HR_ROLES = ['admin', 'super_admin'] as const;

async function allHr(exclude: string): Promise<string[]> {
	const rows = await db
		.select({ id: users.id })
		.from(users)
		.where(and(eq(users.isActive, true), inArray(users.role, [...HR_ROLES]), notHidden));
	return rows.map((r) => r.id).filter((id) => id !== exclude);
}

/**
 * The people a request is waiting on at `stage`. The inverse of
 * canReviewStage for the people who should be told, not everyone with an
 * override: a Super Admin can act on anything but is not pinged for all of it.
 */
export async function reviewersFor(requesterId: string, stage: 'manager' | 'hr'): Promise<string[]> {
	if (stage === 'manager') {
		const m = await managerFor(requesterId);
		if (m) return m.userId === requesterId ? [] : [m.userId];
		if (await reportsToChief(requesterId)) {
			const hr = await assignedHrFor(requesterId);
			if (hr && hr !== requesterId) return [hr];
		}
		return allHr(requesterId);
	}
	const hr = await assignedHrFor(requesterId);
	if (hr && hr !== requesterId) return [hr];
	return allHr(requesterId);
}

export async function postToFeed(userId: string, body: string, card: CardRef | null, opts: { urgent?: boolean; notify?: boolean } = {}) {
	const feed = await ensureSystemFeed(userId);
	const [msg] = await db
		.insert(chatMessages)
		.values({ channelId: feed.id, kind: card ? 'card' : 'system', body, card })
		.returning();
	await db.update(chatChannels).set({ lastMessageAt: msg.createdAt }).where(eq(chatChannels.id, feed.id));
	await publish([userId], { type: 'message.created', channelId: feed.id, messageId: msg.id, threadRootId: null });
	if (opts.notify !== false) {
		await deliverNotification([userId], { title: 'ESS', body, url: `/chat?c=${feed.id}`, urgent: !!opts.urgent, kind: 'system' });
	}
	return msg;
}

const KIND_LABEL: Record<RequestKind, string> = {
	leave: 'Leave request',
	deviation: 'Attendance correction',
	comp_off: 'Comp-off claim'
};

async function requester(kind: RequestKind, id: string) {
	if (kind === 'leave') {
		const [r] = await db.select({ userId: leaveApplications.userId, status: leaveApplications.status }).from(leaveApplications).where(eq(leaveApplications.id, id)).limit(1);
		return r;
	}
	if (kind === 'deviation') {
		const [r] = await db.select({ userId: attendanceDeviations.userId, status: attendanceDeviations.status }).from(attendanceDeviations).where(eq(attendanceDeviations.id, id)).limit(1);
		return r;
	}
	const [r] = await db.select({ userId: compOffCredits.userId, status: compOffCredits.status }).from(compOffCredits).where(eq(compOffCredits.id, id)).limit(1);
	return r;
}

async function nameOf(userId: string) {
	const [u] = await db.select({ fullName: users.fullName }).from(users).where(eq(users.id, userId)).limit(1);
	return u?.fullName ?? 'Someone';
}

/** After a request is raised: a card to everyone it is waiting on. */
export async function notifyNewRequest(kind: RequestKind, id: string) {
	const r = await requester(kind, id);
	if (!r) return;
	const who = await nameOf(r.userId);
	for (const reviewer of await reviewersFor(r.userId, 'manager')) {
		await postToFeed(reviewer, `${KIND_LABEL[kind]} from ${who}`, { type: kind, id });
	}
}

const MID_STAGE: Record<RequestKind, string> = { leave: 'escalated', deviation: 'manager_approved', comp_off: 'manager_approved' };
const DONE_OK = new Set(['approved']);
const DONE_BAD = new Set(['rejected']);

/**
 * After a decision: every copy of the card refreshes, the requester hears the
 * outcome, and a request that moved on to HR reaches HR.
 */
export async function notifyDecision(kind: RequestKind, id: string, deciderId: string) {
	const r = await requester(kind, id);
	if (!r) return;
	const holders = await db.all<{ userId: string }>(sql`
		select distinct m.user_id as "userId" from chat_messages msg
		join chat_members m on m.channel_id = msg.channel_id
		where msg.card->>'type' = ${kind} and msg.card->>'id' = ${id}
	`);
	await publish(holders.map((h) => h.userId), { type: 'card.updated', cardType: kind, cardId: id });

	const decider = await nameOf(deciderId);
	if (r.status === MID_STAGE[kind]) {
		const who = await nameOf(r.userId);
		for (const reviewer of await reviewersFor(r.userId, 'hr')) {
			if (reviewer === deciderId) continue;
			await postToFeed(reviewer, `${KIND_LABEL[kind]} from ${who}, signed off by ${decider}`, { type: kind, id });
		}
		await postToFeed(r.userId, `${decider} signed off your ${KIND_LABEL[kind].toLowerCase()}. It is now with HR.`, { type: kind, id }, { notify: true });
	} else if (DONE_OK.has(r.status)) {
		await postToFeed(r.userId, `${decider} approved your ${KIND_LABEL[kind].toLowerCase()}.`, { type: kind, id });
	} else if (DONE_BAD.has(r.status)) {
		await postToFeed(r.userId, `${decider} rejected your ${KIND_LABEL[kind].toLowerCase()}.`, { type: kind, id });
	}
}

/* ---------- reading cards for display ---------- */

export type ResolvedCard = {
	type: RequestKind;
	id: string;
	title: string;
	detail: string;
	reason: string | null;
	status: string;
	statusLabel: string;
	requesterId: string;
	requesterName: string;
	/** Which stage the viewer may decide now, if any. */
	canAct: 'manager' | 'hr' | null;
	decidedBy: string | null;
	href: string;
};

const fmtDay = (d: string) =>
	new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

function statusLabel(kind: RequestKind, s: string) {
	if (s === 'pending' || s === 'needs_manager_approval') return 'Waiting on the manager';
	if (s === MID_STAGE[kind]) return 'Waiting on HR';
	if (s === 'approved') return 'Approved';
	if (s === 'rejected') return 'Rejected';
	if (s === 'cancelled') return 'Withdrawn';
	return s.replace(/_/g, ' ');
}

async function stageFor(viewer: SessionUser, kind: RequestKind, status: string, requesterId: string, prior: string | null) {
	const stage = status === MID_STAGE[kind] ? 'hr' : status === 'pending' || status === 'needs_manager_approval' ? 'manager' : null;
	if (!stage) return null;
	return (await canReviewStage(viewer, requesterId, stage, stage === 'hr' ? prior : null)) ? stage : null;
}

/** Current state of each referenced request, as this viewer should see it. */
export async function resolveCards(viewer: SessionUser, refs: { type: string; id: string }[]): Promise<Map<string, ResolvedCard>> {
	const out = new Map<string, ResolvedCard>();
	const byType = (t: RequestKind) => [...new Set(refs.filter((r) => r.type === t).map((r) => r.id))];

	const leaveIds = byType('leave');
	if (leaveIds.length) {
		const rows = await db
			.select({ a: leaveApplications, t: leaveTypes.name, name: users.fullName })
			.from(leaveApplications)
			.innerJoin(leaveTypes, eq(leaveTypes.id, leaveApplications.leaveTypeId))
			.innerJoin(users, eq(users.id, leaveApplications.userId))
			.where(inArray(leaveApplications.id, leaveIds));
		for (const { a, t, name } of rows) {
			const days = Number(a.days);
			out.set(`leave:${a.id}`, {
				type: 'leave',
				id: a.id,
				title: `${name} · ${t}`,
				detail: `${a.startDate === a.endDate ? fmtDay(a.startDate) : `${fmtDay(a.startDate)} to ${fmtDay(a.endDate)}`} · ${days} ${days === 1 ? 'day' : 'days'}`,
				reason: a.reason,
				status: a.status,
				statusLabel: statusLabel('leave', a.status),
				requesterId: a.userId,
				requesterName: name,
				canAct: await stageFor(viewer, 'leave', a.status, a.userId, a.approverId),
				decidedBy: null,
				href: '/leave'
			});
		}
	}

	const devIds = byType('deviation');
	if (devIds.length) {
		const rows = await db
			.select({ d: attendanceDeviations, name: users.fullName })
			.from(attendanceDeviations)
			.innerJoin(users, eq(users.id, attendanceDeviations.userId))
			.where(inArray(attendanceDeviations.id, devIds));
		for (const { d, name } of rows) {
			const times = [d.claimedCheckIn && `in ${d.claimedCheckIn}`, d.claimedCheckOut && `out ${d.claimedCheckOut}`].filter(Boolean).join(', ');
			out.set(`deviation:${d.id}`, {
				type: 'deviation',
				id: d.id,
				title: `${name} · Attendance correction`,
				detail: `${fmtDay(d.date)}${times ? ` · ${times}` : ''}`,
				reason: d.description,
				status: d.status,
				statusLabel: statusLabel('deviation', d.status),
				requesterId: d.userId,
				requesterName: name,
				canAct: await stageFor(viewer, 'deviation', d.status, d.userId, d.reviewerId),
				decidedBy: null,
				href: '/attendance'
			});
		}
	}

	const coIds = byType('comp_off');
	if (coIds.length) {
		const rows = await db
			.select({ c: compOffCredits, name: users.fullName })
			.from(compOffCredits)
			.innerJoin(users, eq(users.id, compOffCredits.userId))
			.where(inArray(compOffCredits.id, coIds));
		for (const { c, name } of rows) {
			const hrs = c.workedMinutes ? ` · worked ${Math.floor(c.workedMinutes / 60)} h ${c.workedMinutes % 60} m` : '';
			out.set(`comp_off:${c.id}`, {
				type: 'comp_off',
				id: c.id,
				title: `${name} · Comp-off claim`,
				detail: `Worked ${fmtDay(c.workedDate)}${hrs}`,
				reason: c.note,
				status: c.status,
				statusLabel: statusLabel('comp_off', c.status),
				requesterId: c.userId,
				requesterName: name,
				canAct: await stageFor(viewer, 'comp_off', c.status, c.userId, c.approverId),
				decidedBy: null,
				href: '/attendance'
			});
		}
	}
	return out;
}

/** The endpoint a card's Approve / Reject button calls, and the body it sends. */
export function decisionEndpoint(kind: RequestKind, id: string) {
	return kind === 'leave' ? `/api/leave/${id}/approve` : kind === 'deviation' ? `/api/attendance/deviations/${id}/review` : `/api/attendance/comp-off/${id}/review`;
}


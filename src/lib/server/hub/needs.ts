import { db } from '$lib/server/db/client';
import { attendanceDeviations, chatChannels, chatMembers, chatMessages, compOffCredits, hubDismissals, leaveApplications, tasks, users } from '$lib/server/db/schema';
import { and, asc, desc, eq, gt, gte, isNull, lte, or, sql } from 'drizzle-orm';
import { inArray } from '$lib/server/db/sql';
import type { SessionUser } from '$lib/server/auth';
import { reviewableUserIds } from '$lib/server/approval-chain';
import { resolveCards, type RequestKind } from '$lib/server/chat/cards';
import { sidebarFor } from '$lib/server/chat/channels';
import { istDateKey } from '$lib/chat/rules';
import { reachFor, serialize } from '$lib/server/tasks/service';
import { meetingsToday, minutesWaiting } from '$lib/server/meetings/service';
import type { ChatPreview, NeedItem, TaskView, TodayData } from '$lib/tasks/types';

/**
 * Today in Champ Hub: one list of everything waiting on a person, in the
 * order it should be dealt with.
 *
 *   1 approvals   leave, attendance corrections and comp-off they can decide,
 *                 and tasks waiting for them as the assignee's lead
 *   3 minutes     meetings they hosted whose summary is ready to review
 *   4 mentions    unread messages that name them
 *   5 due         their own open tasks due today or overdue
 *   6 blocked     for leads: work below them flagged Blocked
 *
 * Each item has a stable key; dealing with it anywhere (the Leave page, an
 * ESS card, another tab) removes it everywhere, and "Later" hides it until
 * tomorrow morning.
 */

const MANAGER_STAGE: Record<RequestKind, string[]> = { leave: ['pending'], deviation: ['pending', 'needs_manager_approval'], comp_off: ['pending'] };
const HR_STAGE: Record<RequestKind, string[]> = { leave: ['escalated'], deviation: ['manager_approved'], comp_off: ['manager_approved'] };

async function approvals(user: SessionUser): Promise<NeedItem[]> {
	const [mgr, hr] = await Promise.all([reviewableUserIds(user, 'manager'), reviewableUserIds(user, 'hr')]);
	if (mgr.length === 0 && hr.length === 0) return [];
	const refs: { type: RequestKind; id: string; at: Date }[] = [];
	const scoped = <T>(ids: string[], col: T) => (ids.length ? inArray(col as never, ids) : sql`0`);

	const leave = await db
		.select({ id: leaveApplications.id, at: leaveApplications.createdAt })
		.from(leaveApplications)
		.where(or(and(scoped(mgr, leaveApplications.userId), inArray(leaveApplications.status, MANAGER_STAGE.leave as never)), and(scoped(hr, leaveApplications.userId), inArray(leaveApplications.status, HR_STAGE.leave as never))));
	refs.push(...leave.map((r) => ({ type: 'leave' as const, id: r.id, at: r.at })));

	const dev = await db
		.select({ id: attendanceDeviations.id, at: attendanceDeviations.createdAt })
		.from(attendanceDeviations)
		.where(or(and(scoped(mgr, attendanceDeviations.userId), inArray(attendanceDeviations.status, MANAGER_STAGE.deviation as never)), and(scoped(hr, attendanceDeviations.userId), inArray(attendanceDeviations.status, HR_STAGE.deviation as never))));
	refs.push(...dev.map((r) => ({ type: 'deviation' as const, id: r.id, at: r.at })));

	const co = await db
		.select({ id: compOffCredits.id, at: compOffCredits.createdAt })
		.from(compOffCredits)
		.where(or(and(scoped(mgr, compOffCredits.userId), inArray(compOffCredits.status, MANAGER_STAGE.comp_off as never)), and(scoped(hr, compOffCredits.userId), inArray(compOffCredits.status, HR_STAGE.comp_off as never))));
	refs.push(...co.map((r) => ({ type: 'comp_off' as const, id: r.id, at: r.at })));

	if (refs.length === 0) return [];
	// The card resolver is the one place that knows who may act at which stage.
	const resolved = await resolveCards(user, refs.slice(0, 40));
	const out: NeedItem[] = [];
	for (const ref of refs) {
		const r = resolved.get(`${ref.type}:${ref.id}`);
		if (!r?.canAct) continue;
		out.push({
			key: `approval:${ref.type}:${ref.id}`,
			kind: 'approval',
			title: r.title,
			detail: r.detail,
			quote: r.reason,
			approval: { type: ref.type, id: ref.id, stage: r.canAct },
			at: ref.at.toISOString()
		});
	}
	return out.sort((a, b) => a.at.localeCompare(b.at));
}

async function mentions(user: SessionUser): Promise<NeedItem[]> {
	const since = new Date(Date.now() - 7 * 86_400_000);
	const rows = await db
		.select({ id: chatMessages.id, channelId: chatMessages.channelId, body: chatMessages.body, at: chatMessages.createdAt, author: users.fullName, name: chatChannels.name, kind: chatChannels.kind })
		.from(chatMessages)
		.innerJoin(chatMembers, and(eq(chatMembers.channelId, chatMessages.channelId), eq(chatMembers.userId, user.id)))
		.innerJoin(chatChannels, eq(chatChannels.id, chatMessages.channelId))
		.leftJoin(users, eq(users.id, chatMessages.authorId))
		.where(
			and(
				or(sql`exists (select 1 from json_each(${chatMessages.mentions}) where value = ${user.id})`, eq(chatMessages.mentionsAll, true)),
				gt(chatMessages.createdAt, chatMembers.lastReadAt),
				gte(chatMessages.createdAt, since),
				isNull(chatMessages.deletedAt),
				isNull(chatMessages.hiddenAt),
				sql`${chatMessages.authorId} is not ${user.id}`,
				or(isNull(chatMessages.visibleTo), eq(chatMessages.visibleTo, user.id))
			)
		)
		.orderBy(desc(chatMessages.createdAt))
		.limit(10);
	return rows.map((r) => {
		const where = r.kind === 'channel' ? `#${r.name}` : r.kind === 'group' ? 'a group chat' : 'a conversation';
		return {
			key: `mention:${r.id}`,
			kind: 'mention' as const,
			title: `${r.author ?? 'Someone'} mentioned you in ${where}`,
			detail: where,
			quote: r.body.slice(0, 280),
			mention: { channelId: r.channelId, messageId: r.id, channelName: where },
			at: r.at.toISOString()
		};
	});
}

/** Everything that needs `user`, sorted, with "Later" items left out. */
export async function needsFor(user: SessionUser): Promise<NeedItem[]> {
	const today = istDateKey(new Date());
	const reach = await reachFor(user);
	const [appr, ment, waiting, requestRows, dueRows, blockedRows, dismissed] = await Promise.all([
		approvals(user).catch((err) => {
			console.error('[hub] approvals failed:', err);
			return [] as NeedItem[];
		}),
		mentions(user),
		minutesWaiting(user),
		db.select().from(tasks).where(and(eq(tasks.approverId, user.id), eq(tasks.requestState, 'pending'))).orderBy(asc(tasks.createdAt)).limit(30),
		db
			.select()
			.from(tasks)
			.where(and(eq(tasks.assigneeId, user.id), isNull(tasks.requestState), sql`${tasks.status} <> 'done'`, lte(tasks.dueDate, today)))
			.orderBy(asc(tasks.dueDate)),
		reach.treeIds.length
			? db
					.select()
					.from(tasks)
					.where(and(inArray(tasks.assigneeId, reach.treeIds), eq(tasks.blocked, true), sql`${tasks.status} <> 'done'`))
					.orderBy(desc(tasks.updatedAt))
					.limit(10)
			: Promise.resolve([] as (typeof tasks.$inferSelect)[]),
		db.select({ key: hubDismissals.needKey }).from(hubDismissals).where(and(eq(hubDismissals.userId, user.id), gt(hubDismissals.until, new Date())))
	]);
	const views = await serialize(user, [...requestRows, ...dueRows, ...blockedRows], reach);
	const view = new Map(views.map((v) => [v.id, v]));
	const hidden = new Set(dismissed.map((d) => d.key));

	const items: NeedItem[] = [
		...requestRows.map((t) => {
			const v = view.get(t.id)!;
			const forWhom = v.assignee?.id === v.createdBy.id ? `${v.createdBy.fullName} made this for themselves` : `${v.createdBy.fullName} made this for ${v.assignee?.fullName ?? 'someone'}`;
			return {
				key: `approval:task:${t.id}`,
				kind: 'approval' as const,
				title: t.title,
				detail: `${forWhom}. It starts once you approve.`,
				approval: { type: 'task' as const, id: t.id, stage: 'manager' as const },
				task: v,
				at: t.createdAt.toISOString()
			};
		}),
		...appr,
		...waiting.map((m) => ({
			key: `minutes:${m.id}`,
			kind: 'minutes' as const,
			title: `${m.topic}: minutes are ready`,
			detail: `${m.items} action ${m.items === 1 ? 'item' : 'items'}${m.needOwner ? `, ${m.needOwner} without an owner` : ''}`,
			meetingId: m.id,
			at: m.startedAt.toISOString()
		})),
		...ment,
		...dueRows.map((t) => ({
			key: `due:${t.id}`,
			kind: 'due' as const,
			title: t.title,
			detail: t.dueDate! < today ? 'Overdue' : 'Due today',
			task: view.get(t.id),
			at: t.updatedAt.toISOString()
		})),
		...blockedRows.map((t) => ({
			key: `blocked:${t.id}`,
			kind: 'blocked' as const,
			title: t.title,
			detail: `${view.get(t.id)!.assignee?.fullName ?? 'Someone'} is blocked`,
			task: view.get(t.id),
			at: t.updatedAt.toISOString()
		}))
	];
	return items.filter((i) => !hidden.has(i.key));
}

/** "Later": hide an item until 9 am IST tomorrow. */
export async function dismissNeed(user: SessionUser, key: string) {
	const k = key.trim().slice(0, 120);
	if (!k) return;
	const tomorrow = istDateKey(new Date(Date.now() + 86_400_000));
	const until = new Date(`${tomorrow}T09:00:00+05:30`);
	await db.insert(hubDismissals).values({ userId: user.id, needKey: k, until }).onConflictDoUpdate({ target: [hubDismissals.userId, hubDismissals.needKey], set: { until } });
}

async function unreadChats(user: SessionUser): Promise<ChatPreview[]> {
	const { channels } = await sidebarFor(user);
	const unread = channels
		.filter((c) => c.kind !== 'system' && !c.muted && (c.kind === 'channel' ? c.unread > 0 : c.unread > 0))
		.sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt))
		.slice(0, 5);
	if (unread.length === 0) return [];
	const last = await db.all<{ channelId: string; body: string; author: string | null }>(sql`
		select "channelId", body, author from (
			select msg.channel_id as "channelId", msg.body, u.full_name as "author",
				row_number() over (partition by msg.channel_id order by msg.created_at desc) as rn
			from chat_messages msg left join users u on u.id = msg.author_id
			where msg.channel_id in (select value from json_each(${JSON.stringify(unread.map((c) => c.id))}))
				and msg.thread_root_id is null and msg.deleted_at is null and msg.hidden_at is null
				and (msg.visible_to is null or msg.visible_to = ${user.id})
		) where rn = 1
	`);
	const by = new Map(last.map((r) => [r.channelId, r]));
	return unread.map((c) => {
		const l = by.get(c.id);
		const name =
			c.kind === 'channel' ? `#${c.name}` : c.kind === 'dm' ? (c.others[0]?.fullName ?? 'Just you') : c.kind === 'group' ? c.others.map((o) => o.fullName.split(' ')[0]).join(', ') : c.kind === 'announcements' ? 'Announcements' : c.kind === 'desk' ? 'Ask HR' : c.name;
		return { id: c.id, name, kind: c.kind, unread: c.unread, mentions: c.mentions, last: l ? `${l.author ? l.author.split(' ')[0] + ': ' : ''}${l.body.slice(0, 140)}` : null, lastAt: c.lastMessageAt };
	});
}

export async function todayFor(user: SessionUser): Promise<TodayData> {
	const today = istDateKey(new Date());
	const weekEnd = istDateKey(new Date(Date.now() + 7 * 86_400_000));
	const [needs, weekRows, meetings, chats] = await Promise.all([
		needsFor(user),
		db
			.select()
			.from(tasks)
			.where(and(eq(tasks.assigneeId, user.id), isNull(tasks.requestState), sql`${tasks.status} <> 'done'`, gt(tasks.dueDate, today), lte(tasks.dueDate, weekEnd)))
			.orderBy(asc(tasks.dueDate))
			.limit(20),
		meetingsToday(user).catch(() => []),
		unreadChats(user).catch(() => [])
	]);
	const dueThisWeek: TaskView[] = await serialize(user, weekRows);
	return { today, needs, dueThisWeek, meetingsToday: meetings, unreadChats: chats };
}

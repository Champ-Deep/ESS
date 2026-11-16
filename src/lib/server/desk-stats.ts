import { db } from '$lib/server/db/postgres';
import { sql } from 'drizzle-orm';
import type { SupportTeamKey } from '$lib/capabilities';

/**
 * A support desk's numbers (Ask HR, Ask IT, Ask Engagement), for the team's
 * own dashboard: questions waiting, asked and resolved this week, how long
 * the first reply takes, and the questions still open.
 */
export type DeskStats = {
	open: number;
	askedThisWeek: number;
	resolvedThisWeek: number;
	/** Median minutes from a question to the team's first reply, last 30 days. */
	medianReplyMinutes: number | null;
	waiting: { channelId: string; fullName: string; preview: string; since: string }[];
};

export async function deskStats(team: SupportTeamKey): Promise<DeskStats> {
	const teamSql = sql`coalesce(c.desk_team, 'hr') = ${team}`;
	const [counts, reply, waiting] = await Promise.all([
		db.execute(sql`
			select
				count(*) filter (where c.desk_status = 'open' and exists (select 1 from chat_messages m where m.channel_id = c.id))::int as open,
				count(*) filter (where exists (select 1 from chat_messages m where m.channel_id = c.id and m.author_id = c.desk_owner_id and m.created_at > now() - interval '7 days'))::int as asked,
				count(*) filter (where c.desk_status = 'resolved' and c.last_message_at > now() - interval '7 days')::int as resolved
			from chat_channels c
			where c.kind = 'desk' and c.archived_at is null and ${teamSql}
		`),
		db.execute(sql`
			select percentile_cont(0.5) within group (order by extract(epoch from (r.created_at - q.created_at)) / 60) as minutes
			from chat_messages q
			join chat_channels c on c.id = q.channel_id and c.kind = 'desk' and ${teamSql}
			cross join lateral (
				select m.created_at from chat_messages m
				where m.channel_id = q.channel_id and m.created_at > q.created_at
					and m.author_id is not null and m.author_id <> c.desk_owner_id
				order by m.created_at limit 1
			) r
			where q.author_id = c.desk_owner_id and q.created_at > now() - interval '30 days'
		`),
		db.execute(sql`
			select c.id as "channelId", u.full_name as "fullName",
				(select left(m.body, 140) from chat_messages m where m.channel_id = c.id and m.deleted_at is null order by m.created_at desc limit 1) as preview,
				c.last_message_at as since
			from chat_channels c join users u on u.id = c.desk_owner_id
			where c.kind = 'desk' and c.archived_at is null and ${teamSql} and c.desk_status = 'open'
				and exists (select 1 from chat_messages m where m.channel_id = c.id)
			order by c.last_message_at asc
			limit 8
		`)
	]);
	const n = (counts.rows[0] ?? {}) as { open?: number; asked?: number; resolved?: number };
	const minutes = (reply.rows[0] as { minutes?: number | string | null } | undefined)?.minutes;
	return {
		open: n.open ?? 0,
		askedThisWeek: n.asked ?? 0,
		resolvedThisWeek: n.resolved ?? 0,
		medianReplyMinutes: minutes === null || minutes === undefined ? null : Math.round(Number(minutes)),
		waiting: (waiting.rows as { channelId: string; fullName: string; preview: string | null; since: string | Date }[]).map((w) => ({
			channelId: w.channelId,
			fullName: w.fullName,
			preview: w.preview ?? '',
			since: new Date(w.since).toISOString()
		}))
	};
}

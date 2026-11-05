import { db } from '$lib/server/db/client';
import { chatChannels, chatMembers, employeeProfiles, shiftGroups, teams, users } from '$lib/server/db/schema';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { chunksFor, inArray, notInArray } from '$lib/server/db/sql';
import { channelSlug } from '$lib/chat/rules';
import { publish } from './bus';

/**
 * Keeps the automatic channels in step with the roster.
 *
 *   #general         everyone active
 *   #announcements   everyone active, read-only (HR posts from it)
 *   #<team>          one per team, its members
 *   #<shift>         one per shift group, its members
 *
 * Membership the sync added is the sync's to remove: moving someone to
 * another team takes them out of the old team channel. Anyone added by a
 * person stays until a person removes them. A deactivated login leaves every
 * channel; their DMs are kept so conversations still read sensibly.
 */

type Want = { key: string; kind: 'channel' | 'announcements'; name: string; topic: string; source: 'everyone' | 'team' | 'shift'; sourceId: string | null; readOnly: boolean };

async function wantedChannels(): Promise<Want[]> {
	const [teamRows, shiftRows] = await Promise.all([
		db.select({ id: teams.id, name: teams.name }).from(teams),
		db.select({ id: shiftGroups.id, name: shiftGroups.name }).from(shiftGroups)
	]);
	return [
		{ key: 'everyone', kind: 'channel', name: 'general', topic: 'Everyone in the company', source: 'everyone', sourceId: null, readOnly: false },
		{ key: 'announcements', kind: 'announcements', name: 'announcements', topic: 'Notices from HR', source: 'everyone', sourceId: null, readOnly: true },
		...teamRows.map((t) => ({ key: `team:${t.id}`, kind: 'channel' as const, name: channelSlug(t.name), topic: `Team channel for ${t.name}`, source: 'team' as const, sourceId: t.id, readOnly: false })),
		...shiftRows.map((s) => ({ key: `shift:${s.id}`, kind: 'channel' as const, name: channelSlug(s.name), topic: `Everyone on ${s.name}`, source: 'shift' as const, sourceId: s.id, readOnly: false }))
	];
}

/** Creates any automatic channel that is missing and renames any whose team was renamed. */
export async function ensureAutoChannels(): Promise<Map<string, string>> {
	const wanted = await wantedChannels();
	for (const w of wanted) {
		await db
			.insert(chatChannels)
			.values({ kind: w.kind, name: w.name, topic: w.topic, source: w.source, sourceId: w.sourceId, readOnly: w.readOnly, uniqueKey: w.key })
			.onConflictDoUpdate({ target: chatChannels.uniqueKey, set: { name: w.name, archivedAt: null } });
	}
	// A deleted team or shift group archives its channel rather than deleting history.
	const keys = wanted.map((w) => w.key);
	await db
		.update(chatChannels)
		.set({ archivedAt: new Date() })
		.where(and(inArray(chatChannels.source, ['team', 'shift']), notInArray(chatChannels.uniqueKey, keys), isNull(chatChannels.archivedAt)));
	const rows = await db.select({ id: chatChannels.id, key: chatChannels.uniqueKey }).from(chatChannels).where(inArray(chatChannels.uniqueKey, keys));
	return new Map(rows.map((r) => [r.key!, r.id]));
}

type Person = { id: string; teamId: string | null; shiftGroupId: string | null; isActive: boolean };

function channelKeysFor(p: Person): string[] {
	if (!p.isActive) return [];
	return ['everyone', 'announcements', ...(p.teamId ? [`team:${p.teamId}`] : []), ...(p.shiftGroupId ? [`shift:${p.shiftGroupId}`] : [])];
}

async function applyFor(people: Person[], idByKey: Map<string, string>) {
	const autoIds = [...idByKey.values()];
	if (autoIds.length === 0 || people.length === 0) return;
	const current = await db
		.select({ channelId: chatMembers.channelId, userId: chatMembers.userId, addedBy: chatMembers.addedBy })
		.from(chatMembers)
		.where(and(inArray(chatMembers.channelId, autoIds), inArray(chatMembers.userId, people.map((p) => p.id))));
	const have = new Set(current.map((c) => `${c.channelId}|${c.userId}`));

	const toAdd: { channelId: string; userId: string; addedBy: string }[] = [];
	const toRemove: { channelId: string; userId: string }[] = [];
	for (const p of people) {
		const want = new Set(channelKeysFor(p).map((k) => idByKey.get(k)).filter(Boolean) as string[]);
		for (const cid of want) if (!have.has(`${cid}|${p.id}`)) toAdd.push({ channelId: cid, userId: p.id, addedBy: 'sync' });
		for (const c of current.filter((c) => c.userId === p.id)) {
			if (!want.has(c.channelId) && (c.addedBy === 'sync' || !p.isActive)) toRemove.push(c);
		}
	}
	const writes = [
		...chunksFor(toAdd, 9).map((rows) => db.insert(chatMembers).values(rows).onConflictDoNothing()),
		...toRemove.map((r) => db.delete(chatMembers).where(and(eq(chatMembers.channelId, r.channelId), eq(chatMembers.userId, r.userId))))
	];
	if (writes.length) await db.batch(writes as [(typeof writes)[0], ...typeof writes]);
	const touched = [...new Set([...toAdd, ...toRemove].map((x) => x.userId))];
	if (touched.length) await publish(touched, { type: 'channels.changed' });
}

async function loadPeople(ids?: string[]): Promise<Person[]> {
	const rows = await db
		.select({ id: users.id, teamId: users.teamId, shiftGroupId: employeeProfiles.shiftGroupId, isActive: users.isActive })
		.from(users)
		.leftJoin(employeeProfiles, eq(employeeProfiles.userId, users.id))
		.where(ids ? inArray(users.id, ids) : sql`1`);
	return rows;
}

/** Re-checks one person's automatic channels — after a settings change or a new login. */
export async function syncMembershipFor(userId: string) {
	const idByKey = await ensureAutoChannels();
	await applyFor(await loadPeople([userId]), idByKey);
}

/** The whole roster. Run at start-up and every few minutes, which also catches bulk imports. */
export async function syncAll() {
	const idByKey = await ensureAutoChannels();
	const people = await loadPeople();
	for (let i = 0; i < people.length; i += 200) await applyFor(people.slice(i, i + 200), idByKey);

	// A deactivated login also leaves the channels people added them to. DMs
	// stay, read-only, so the other person's history still makes sense.
	const inactive = people.filter((p) => !p.isActive).map((p) => p.id);
	if (inactive.length) {
		await db.run(sql`
			delete from chat_members
			where channel_id in (select id from chat_channels where kind in ('channel', 'group'))
				and user_id in (select value from json_each(${JSON.stringify(inactive)}))
		`);
	}
}

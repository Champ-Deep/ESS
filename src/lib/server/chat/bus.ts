import Redis from 'ioredis';
import { env } from '$env/dynamic/private';

/**
 * Delivers Champ Chat events to the right open browser tabs.
 *
 * Each browser tab holds one Server-Sent Events stream (/api/chat/stream).
 * This process keeps a registry of those streams by user id. An event is
 * published once to Redis with the list of people it is for; every server
 * process receives it and writes it to the streams it holds for those people.
 * With one process that is a round trip to itself, and it is what lets the app
 * run as several processes later without changing any caller.
 *
 * If Redis is unreachable, events are delivered in-process only, so a single
 * instance keeps working.
 */

export type ChatEvent = { type: string; [key: string]: unknown };

type Stream = { send: (event: ChatEvent) => void };

const CHANNEL = 'chat:events';

const g = globalThis as {
	__chatStreams?: Map<string, Set<Stream>>;
	__chatPub?: Redis;
	__chatSub?: Redis;
	__chatSubReady?: boolean;
};

const streams: Map<string, Set<Stream>> = (g.__chatStreams ??= new Map());

function deliverLocal(userIds: string[], event: ChatEvent) {
	for (const id of userIds) {
		const set = streams.get(id);
		if (!set) continue;
		for (const s of set) {
			try {
				s.send(event);
			} catch {
				set.delete(s);
			}
		}
	}
}

function redisOptions() {
	return { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false } as const;
}

function publisher(): Redis {
	return (g.__chatPub ??= new Redis(env.REDIS_URL ?? 'redis://localhost:6379', redisOptions()));
}

async function ensureSubscriber() {
	if (g.__chatSubReady) return;
	g.__chatSubReady = true;
	try {
		const sub = (g.__chatSub ??= new Redis(env.REDIS_URL ?? 'redis://localhost:6379', {
			lazyConnect: true,
			maxRetriesPerRequest: null
		}));
		await sub.connect().catch(() => {});
		await sub.subscribe(CHANNEL);
		sub.on('message', (_chan, raw) => {
			try {
				const { u, e } = JSON.parse(raw) as { u: string[]; e: ChatEvent };
				deliverLocal(u, e);
			} catch {
				/* a malformed event is dropped */
			}
		});
	} catch (err) {
		g.__chatSubReady = false;
		console.warn('[chat] Redis subscribe failed, delivering in-process only:', err instanceof Error ? err.message : err);
	}
}

/** Send `event` to every open tab of each of `userIds`. */
export async function publish(userIds: string[], event: ChatEvent) {
	const ids = [...new Set(userIds)];
	if (ids.length === 0) return;
	await ensureSubscriber();
	const pub = publisher();
	try {
		if (pub.status !== 'ready') await pub.connect().catch(() => {});
		if (pub.status === 'ready' && g.__chatSubReady) {
			await pub.publish(CHANNEL, JSON.stringify({ u: ids, e: event }));
			return;
		}
	} catch {
		/* fall through to local delivery */
	}
	deliverLocal(ids, event);
}

/** Register a tab's stream. Returns the function that unregisters it. */
export function register(userId: string, stream: Stream): () => void {
	void ensureSubscriber();
	let set = streams.get(userId);
	if (!set) streams.set(userId, (set = new Set()));
	set.add(stream);
	return () => {
		set!.delete(stream);
		if (set!.size === 0) streams.delete(userId);
	};
}

/** True if this process holds an open tab for the person. */
export function hasLocalStream(userId: string): boolean {
	return (streams.get(userId)?.size ?? 0) > 0;
}

/** A shared key-value handle for presence and rate limits. */
export function kv(): Redis {
	return publisher();
}

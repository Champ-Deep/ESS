import { bindings } from '$lib/server/platform';
import { kv as sharedKv, type KeyValue } from '$lib/server/kv';

/**
 * Delivers Champ Chat events to the right open browser tabs.
 *
 * Each browser tab holds one Server-Sent Events stream (/api/chat/stream).
 *
 *   Cloudflare  the streams live in one Durable Object (cloudflare/chat-hub.ts).
 *               A Worker request is short-lived and may run in any data
 *               centre, so the object is the one place every tab's stream and
 *               every publish meet.
 *   Node        the streams live in this process, as before.
 */

export type ChatEvent = { type: string; [key: string]: unknown };

type Stream = { send: (event: ChatEvent) => void };

/** The RPC surface of the ChatHub Durable Object. */
interface HubStub {
	publish(userIds: string[], event: ChatEvent): Promise<void>;
	hasStreams(userIds: string[]): Promise<string[]>;
	fetch(request: Request): Promise<Response>;
}

export function chatHub(): HubStub | null {
	const ns = bindings().CHAT_HUB;
	if (!ns) return null;
	return ns.get(ns.idFromName('global')) as HubStub;
}

const g = globalThis as { __chatStreams?: Map<string, Set<Stream>> };
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

/** Send `event` to every open tab of each of `userIds`. */
export async function publish(userIds: string[], event: ChatEvent) {
	const ids = [...new Set(userIds)];
	if (ids.length === 0) return;
	const hub = chatHub();
	if (hub) {
		try {
			await hub.publish(ids, event);
		} catch (err) {
			console.warn('[chat] hub publish failed:', err instanceof Error ? err.message : err);
		}
		return;
	}
	deliverLocal(ids, event);
}

/** Register a tab's stream (Node only). Returns the function that unregisters it. */
export function register(userId: string, stream: Stream): () => void {
	let set = streams.get(userId);
	if (!set) streams.set(userId, (set = new Set()));
	set.add(stream);
	return () => {
		set!.delete(stream);
		if (set!.size === 0) streams.delete(userId);
	};
}

/** True if the person has a tab open with a live stream. */
export async function hasOpenStream(userId: string): Promise<boolean> {
	const hub = chatHub();
	if (hub) {
		try {
			return (await hub.hasStreams([userId])).length > 0;
		} catch {
			return false;
		}
	}
	return (streams.get(userId)?.size ?? 0) > 0;
}

/** A shared key-value handle for presence and rate limits. */
export function kv(): KeyValue {
	return sharedKv();
}

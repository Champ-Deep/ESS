import { DurableObject } from 'cloudflare:workers';

type ChatEvent = { type: string; [key: string]: unknown };

/**
 * Champ Chat's live delivery on Cloudflare.
 *
 * Every open browser tab's Server-Sent Events stream terminates here (the
 * /api/chat/stream route authenticates the person, then forwards the request
 * with their id). Anything in the portal that publishes a chat event calls
 * `publish` over RPC and this object writes it to that person's open tabs.
 *
 * One instance ("global"). A tab that has gone away is noticed on the next
 * write (the keep-alive ping every 25 s) and dropped.
 */
export class ChatHub extends DurableObject {
	private streams = new Map<string, Set<WritableStreamDefaultWriter<Uint8Array>>>();
	private enc = new TextEncoder();
	private pinger: ReturnType<typeof setInterval> | null = null;

	async fetch(request: Request): Promise<Response> {
		const userId = new URL(request.url).searchParams.get('u');
		if (!userId) return new Response('missing user', { status: 400 });

		const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
		const writer = writable.getWriter();
		let set = this.streams.get(userId);
		if (!set) this.streams.set(userId, (set = new Set()));
		set.add(writer);
		void this.write(userId, writer, `retry: 3000\ndata: ${JSON.stringify({ type: 'hello' })}\n\n`);
		request.signal?.addEventListener('abort', () => this.drop(userId, writer));
		this.pinger ??= setInterval(() => this.ping(), 25_000);

		return new Response(readable, {
			headers: {
				'Content-Type': 'text/event-stream; charset=utf-8',
				'Cache-Control': 'no-cache, no-transform',
				'X-Accel-Buffering': 'no'
			}
		});
	}

	private drop(userId: string, writer: WritableStreamDefaultWriter<Uint8Array>) {
		const set = this.streams.get(userId);
		if (!set) return;
		set.delete(writer);
		if (set.size === 0) this.streams.delete(userId);
		writer.close().catch(() => {});
		if (this.streams.size === 0 && this.pinger) {
			clearInterval(this.pinger);
			this.pinger = null;
		}
	}

	private async write(userId: string, writer: WritableStreamDefaultWriter<Uint8Array>, chunk: string) {
		try {
			await writer.write(this.enc.encode(chunk));
		} catch {
			this.drop(userId, writer);
		}
	}

	private ping() {
		for (const [userId, set] of this.streams) for (const w of set) void this.write(userId, w, ': ping\n\n');
	}

	async publish(userIds: string[], event: ChatEvent): Promise<void> {
		const chunk = `data: ${JSON.stringify(event)}\n\n`;
		const writes: Promise<void>[] = [];
		for (const id of userIds) {
			const set = this.streams.get(id);
			if (!set) continue;
			for (const w of set) writes.push(this.write(id, w, chunk));
		}
		await Promise.all(writes);
	}

	hasStreams(userIds: string[]): string[] {
		return userIds.filter((id) => (this.streams.get(id)?.size ?? 0) > 0);
	}
}

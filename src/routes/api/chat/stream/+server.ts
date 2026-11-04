import type { RequestHandler } from './$types';
import { error } from '@sveltejs/kit';
import { chatHub, register } from '$lib/server/chat/bus';
import { heartbeat } from '$lib/server/chat/presence';

/**
 * The live stream for one browser tab: Server-Sent Events.
 *
 * SSE rather than WebSockets because it is an ordinary HTTP response — it
 * works through Cloudflare, proxies and office firewalls — and chat traffic
 * is almost all server-to-browser. The browser reconnects by itself; on
 * reconnect the page re-reads its sidebar and open conversation, so nothing
 * sent in between is missed.
 *
 * On Cloudflare the stream itself is held by the ChatHub Durable Object
 * (cloudflare/chat-hub.ts); this route signs the person in and hands the
 * connection over. Under Node it is held here.
 */
export const GET: RequestHandler = async ({ locals, request }) => {
	const user = locals.user;
	if (!user) throw error(401, 'Sign in again to continue');

	const hub = chatHub();
	if (hub) {
		await heartbeat(user.id);
		return hub.fetch(new Request(`https://chat-hub/stream?u=${encodeURIComponent(user.id)}`, { signal: request.signal }));
	}

	let unregister: (() => void) | null = null;
	let keepAlive: ReturnType<typeof setInterval> | null = null;
	const enc = new TextEncoder();

	const stream = new ReadableStream({
		start(controller) {
			const write = (chunk: string) => {
				try {
					controller.enqueue(enc.encode(chunk));
				} catch {
					cleanup();
				}
			};
			const cleanup = () => {
				unregister?.();
				unregister = null;
				if (keepAlive) clearInterval(keepAlive);
				keepAlive = null;
			};
			unregister = register(user.id, { send: (event) => write(`data: ${JSON.stringify(event)}\n\n`) });
			write(`retry: 3000\ndata: ${JSON.stringify({ type: 'hello' })}\n\n`);
			void heartbeat(user.id);
			// Proxies drop idle connections; a comment line every 25 s keeps it open.
			keepAlive = setInterval(() => write(`: ping\n\n`), 25_000);
			request.signal.addEventListener('abort', () => {
				cleanup();
				try {
					controller.close();
				} catch {
					/* already closed */
				}
			});
		},
		cancel() {
			unregister?.();
			if (keepAlive) clearInterval(keepAlive);
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream; charset=utf-8',
			'Cache-Control': 'no-cache, no-transform',
			Connection: 'keep-alive',
			'X-Accel-Buffering': 'no'
		}
	});
};

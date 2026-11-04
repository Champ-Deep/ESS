import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Where the portal is running, and the per-request handles that come with it.
 *
 * On Cloudflare Workers every request gets its own `env` (bindings: Hyperdrive,
 * R2, Durable Objects) and `ctx` (waitUntil). Deep library code — the database
 * pool, the chat bus, file storage — needs them without every caller threading
 * them through, so hooks.server.ts runs each request inside `runWithPlatform`
 * and anything below can read `currentPlatform()`.
 *
 * Under Node (adapter-node / Docker / `vite dev`) there is no store: callers
 * fall back to their long-lived, process-wide behaviour.
 */

export interface CloudflareBindings {
	HYPERDRIVE?: { connectionString: string };
	FILES?: R2BucketLike;
	CHAT_HUB?: DurableObjectNamespaceLike;
	KV_STORE?: DurableObjectNamespaceLike;
	/** Set only on the synthetic request the cron trigger sends (cloudflare/worker.ts). */
	__CRON?: boolean;
	[key: string]: unknown;
}

/* Minimal structural types so this module does not depend on workers-types. */
export interface R2ObjectLike {
	arrayBuffer(): Promise<ArrayBuffer>;
	httpMetadata?: { contentType?: string };
}
export interface R2BucketLike {
	get(key: string): Promise<R2ObjectLike | null>;
	put(key: string, value: ArrayBuffer | Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
	delete(keys: string | string[]): Promise<void>;
	head(key: string): Promise<unknown | null>;
}
export interface DurableObjectNamespaceLike {
	idFromName(name: string): unknown;
	get(id: unknown): any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

interface WaitUntilContext {
	waitUntil(promise: Promise<unknown>): void;
}

interface RequestScope {
	env: CloudflareBindings;
	ctx: WaitUntilContext | null;
	/** Background work started during this request (see `background`). */
	pending: Set<Promise<unknown>>;
	/** Run once the request and all of its background work are done. */
	finalizers: (() => Promise<void> | void)[];
	/** Per-request memo (the Postgres pool, Durable Object stubs). */
	memo: Map<string, unknown>;
}

const storage = new AsyncLocalStorage<RequestScope>();

/** True inside the Cloudflare Workers runtime. */
export const onCloudflare =
	typeof navigator !== 'undefined' && (navigator as { userAgent?: string }).userAgent === 'Cloudflare-Workers';

export function currentPlatform(): RequestScope | undefined {
	return storage.getStore();
}

/** The request's bindings, or an empty object under Node. */
export function bindings(): CloudflareBindings {
	return storage.getStore()?.env ?? {};
}

/** A per-request value, created once on first use. */
export function requestMemo<T>(key: string, create: () => T): T | undefined {
	const scope = storage.getStore();
	if (!scope) return undefined;
	if (!scope.memo.has(key)) scope.memo.set(key, create());
	return scope.memo.get(key) as T;
}

/** Register cleanup for the current request (e.g. closing its database pool). */
export function onRequestDone(fn: () => Promise<void> | void) {
	storage.getStore()?.finalizers.push(fn);
}

/**
 * Work that should finish even though the response does not wait for it
 * (chat notifications, cards, webhooks follow-ups). Under Node a floating
 * promise simply keeps running; on Workers it would be cut off once the
 * response is sent, so it is handed to `ctx.waitUntil` through the request's
 * settle step.
 */
export function background(work: Promise<unknown>): void {
	const p = work.catch((err) => {
		console.error('[background]', err instanceof Error ? (err.stack ?? err.message) : err);
	});
	const scope = storage.getStore();
	if (!scope) return;
	scope.pending.add(p);
	void p.finally(() => scope.pending.delete(p));
}

/**
 * Runs `fn` (one request) with the platform available to everything below it.
 * Once it returns, background work is drained and finalizers run — inside
 * waitUntil, so the response is not held up.
 */
export async function runWithPlatform<T>(
	env: CloudflareBindings,
	ctx: WaitUntilContext | null,
	fn: () => Promise<T>
): Promise<T> {
	const scope: RequestScope = { env, ctx, pending: new Set(), finalizers: [], memo: new Map() };
	return storage.run(scope, async () => {
		try {
			return await fn();
		} finally {
			const settle = (async () => {
				// Background work may start more background work; drain until quiet.
				while (scope.pending.size) await Promise.allSettled([...scope.pending]);
				for (const f of scope.finalizers) {
					try {
						await f();
					} catch (err) {
						console.error('[platform] cleanup failed:', err);
					}
				}
			})();
			if (ctx) ctx.waitUntil(settle);
			else void settle;
		}
	});
}

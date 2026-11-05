import { bindings } from './platform';

/**
 * The small shared key-value store the portal used Redis for: login rate
 * limits, refresh tokens, chat presence, Zoom token and caches.
 *
 * On Cloudflare it is one Durable Object (cloudflare/kv-store.ts): strongly
 * consistent, so counters and token revocation behave exactly like Redis did.
 * Under Node it is an in-process map, which is what a single process needs.
 *
 * The method names and the `set(key, value, 'EX', seconds)` form mirror
 * ioredis so call sites read the same as before.
 */
export interface KeyValue {
	get(key: string): Promise<string | null>;
	mget(keys: string[]): Promise<(string | null)[]>;
	set(key: string, value: string, mode?: 'EX', ttlSeconds?: number): Promise<'OK'>;
	del(key: string): Promise<number>;
	incr(key: string): Promise<number>;
	expire(key: string, ttlSeconds: number): Promise<number>;
}

/** The RPC surface of the KvStore Durable Object. */
interface KvStub {
	get(key: string): Promise<string | null>;
	mget(keys: string[]): Promise<(string | null)[]>;
	set(key: string, value: string, ttlSeconds: number | null): Promise<void>;
	del(key: string): Promise<number>;
	incr(key: string): Promise<number>;
	expire(key: string, ttlSeconds: number): Promise<number>;
}

function durable(stub: KvStub): KeyValue {
	return {
		get: (k) => stub.get(k),
		mget: (ks) => (ks.length ? stub.mget(ks) : Promise.resolve([])),
		set: async (k, v, _mode, ttl) => {
			await stub.set(k, v, ttl ?? null);
			return 'OK';
		},
		del: (k) => stub.del(k),
		incr: (k) => stub.incr(k),
		expire: (k, ttl) => stub.expire(k, ttl)
	};
}

const mem = new Map<string, { v: string; exp: number | null }>();

function live(key: string) {
	const e = mem.get(key);
	if (!e) return null;
	if (e.exp !== null && e.exp <= Date.now()) {
		mem.delete(key);
		return null;
	}
	return e;
}

const memory: KeyValue = {
	async get(k) {
		return live(k)?.v ?? null;
	},
	async mget(ks) {
		return ks.map((k) => live(k)?.v ?? null);
	},
	async set(k, v, _mode, ttl) {
		mem.set(k, { v, exp: ttl ? Date.now() + ttl * 1000 : null });
		return 'OK';
	},
	async del(k) {
		return mem.delete(k) ? 1 : 0;
	},
	async incr(k) {
		const e = live(k);
		const n = (e ? Number(e.v) || 0 : 0) + 1;
		mem.set(k, { v: String(n), exp: e?.exp ?? null });
		return n;
	},
	async expire(k, ttl) {
		const e = live(k);
		if (!e) return 0;
		e.exp = Date.now() + ttl * 1000;
		return 1;
	}
};

export function kv(): KeyValue {
	const ns = bindings().KV_STORE;
	if (!ns) return memory;
	return durable(ns.get(ns.idFromName('global')) as KvStub);
}

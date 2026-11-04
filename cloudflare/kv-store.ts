import { DurableObject } from 'cloudflare:workers';

/**
 * The portal's shared key-value store (what Redis used to hold): login rate
 * limits, refresh tokens, chat presence, Zoom tokens and caches.
 *
 * One instance ("global"), SQLite-backed, so every read sees every write —
 * counters are atomic and a revoked refresh token is gone everywhere at once.
 * Expired keys are ignored on read and swept by an hourly alarm.
 *
 * Called over RPC from src/lib/server/kv.ts.
 */
export class KvStore extends DurableObject {
	private sql: SqlStorage;

	constructor(ctx: DurableObjectState, env: unknown) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		this.sql.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, exp INTEGER)');
		void ctx.blockConcurrencyWhile(async () => {
			if ((await ctx.storage.getAlarm()) === null) await ctx.storage.setAlarm(Date.now() + 3_600_000);
		});
	}

	private row(k: string): { v: string; exp: number | null } | null {
		const rows = this.sql.exec<{ v: string; exp: number | null }>('SELECT v, exp FROM kv WHERE k = ?', k).toArray();
		const r = rows[0];
		if (!r) return null;
		if (r.exp !== null && r.exp <= Date.now()) {
			this.sql.exec('DELETE FROM kv WHERE k = ?', k);
			return null;
		}
		return r;
	}

	get(k: string): string | null {
		return this.row(k)?.v ?? null;
	}

	mget(keys: string[]): (string | null)[] {
		return keys.map((k) => this.get(k));
	}

	set(k: string, v: string, ttlSeconds: number | null): void {
		const exp = ttlSeconds ? Date.now() + ttlSeconds * 1000 : null;
		this.sql.exec('INSERT INTO kv (k, v, exp) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, exp = excluded.exp', k, v, exp);
	}

	del(k: string): number {
		const existed = this.row(k) !== null;
		this.sql.exec('DELETE FROM kv WHERE k = ?', k);
		return existed ? 1 : 0;
	}

	incr(k: string): number {
		const r = this.row(k);
		const n = (r ? Number(r.v) || 0 : 0) + 1;
		this.sql.exec('INSERT INTO kv (k, v, exp) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, String(n), r?.exp ?? null);
		return n;
	}

	expire(k: string, ttlSeconds: number): number {
		if (!this.row(k)) return 0;
		this.sql.exec('UPDATE kv SET exp = ? WHERE k = ?', Date.now() + ttlSeconds * 1000, k);
		return 1;
	}

	async alarm() {
		this.sql.exec('DELETE FROM kv WHERE exp IS NOT NULL AND exp <= ?', Date.now());
		await this.ctx.storage.setAlarm(Date.now() + 3_600_000);
	}
}

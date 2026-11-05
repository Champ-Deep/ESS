import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from './schema';
import { bindings, requestMemo, type D1DatabaseLike } from '../platform';

export type Db = DrizzleD1Database<typeof schema>;

/*
 * The portal's database is Cloudflare D1 (the DB binding in wrangler.jsonc).
 * Each request gets its own `env`, so `db` forwards to the drizzle instance
 * for the current request (see platform.ts). Standalone scripts (seed,
 * migrations from the old databases) call `useDatabase` once with a binding
 * from wrangler's getPlatformProxy.
 */

let scriptDb: Db | null = null;

/** For scripts running outside a request: use this D1 binding for `db`. */
export function useDatabase(d1: D1DatabaseLike): Db {
	scriptDb = drizzle(d1 as never, { schema });
	return scriptDb;
}

function current(): Db {
	const d1 = bindings().DB;
	if (d1) return requestMemo('db', () => drizzle(d1 as never, { schema }))!;
	if (scriptDb) return scriptDb;
	throw new Error('No database: the D1 binding "DB" is missing (see wrangler.jsonc).');
}

export const db: Db = new Proxy({} as Db, {
	get(_target, prop) {
		const real = current();
		const value = Reflect.get(real as object, prop, real);
		return typeof value === 'function' ? value.bind(real) : value;
	}
});

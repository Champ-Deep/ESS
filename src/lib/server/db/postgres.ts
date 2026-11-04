import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { env } from '$env/dynamic/private';
import * as schema from './schema';
import { bindings, onRequestDone, requestMemo } from '../platform';

type Db = NodePgDatabase<typeof schema>;

/*
 * Two ways to reach Postgres:
 *
 *   Cloudflare Workers  one small pool per request, through Hyperdrive (the
 *                       HYPERDRIVE binding). A Worker may not reuse a socket
 *                       opened by another request, and Hyperdrive does the real
 *                       connection pooling at the edge, so this is cheap.
 *   Node                one pool for the life of the process (Docker, vite dev,
 *                       scripts), exactly as before.
 *
 * `db` keeps the same shape for every caller: it forwards to whichever
 * instance belongs to the current request.
 */

let processDb: Db | null = null;

function nodeDb(): Db {
	return (processDb ??= drizzle(new Pool({ connectionString: env.DATABASE_URL }), { schema }));
}

function requestDb(): Db | undefined {
	const hyperdrive = bindings().HYPERDRIVE;
	if (!hyperdrive) return undefined;
	return requestMemo('db', () => {
		const pool = new Pool({ connectionString: hyperdrive.connectionString, max: 5 });
		onRequestDone(() => pool.end());
		return drizzle(pool, { schema });
	});
}

function current(): Db {
	return requestDb() ?? nodeDb();
}

export const db: Db = new Proxy({} as Db, {
	get(_target, prop) {
		const real = current();
		const value = Reflect.get(real as object, prop, real);
		return typeof value === 'function' ? value.bind(real) : value;
	}
});

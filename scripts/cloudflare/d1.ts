/**
 * Gives standalone scripts (seed, data import, diagnostics) the same D1
 * database and R2 bucket the Worker uses, through wrangler's getPlatformProxy.
 *
 *   default     the local copy that `npm run dev` / `npm run cf:dev` use
 *               (.wrangler/state)
 *   --remote    the real Cloudflare D1 and R2 (needs `npx wrangler login`)
 *
 * After `openCloudflare()`, `db` from src/lib/server/db/client works as it
 * does inside a request.
 */
import { getPlatformProxy } from 'wrangler';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { useDatabase } from '../../src/lib/server/db/client';
import type { D1DatabaseLike, R2BucketLike } from '../../src/lib/server/platform';

export const remote = process.argv.includes('--remote');

/** The D1 database id from wrangler.jsonc. */
function databaseId(): string {
	const text = readFileSync('wrangler.jsonc', 'utf8');
	const id = text.match(/"database_id"\s*:\s*"([^"]+)"/)?.[1];
	if (!id) throw new Error('wrangler.jsonc has no d1 database_id');
	if (remote && id.startsWith('REPLACE_')) {
		throw new Error('Put the D1 database id in wrangler.jsonc first (npx wrangler d1 create champ-hr).');
	}
	return id;
}

export async function openCloudflare() {
	// A config with only the storage bindings: the full wrangler.jsonc also
	// declares Durable Objects, which need the built Worker.
	const config = {
		name: 'champ-hr-ess-scripts',
		compatibility_date: '2026-10-01',
		compatibility_flags: ['nodejs_compat'],
		d1_databases: [{ binding: 'DB', database_name: 'champ-hr', database_id: databaseId(), remote }],
		r2_buckets: [{ binding: 'FILES', bucket_name: 'champ-hr-files', remote }]
	};
	mkdirSync('.wrangler', { recursive: true });
	const configPath = join('.wrangler', 'scripts.wrangler.json');
	writeFileSync(configPath, JSON.stringify(config, null, 2));

	const proxy = await getPlatformProxy<{ DB: D1DatabaseLike; FILES: R2BucketLike }>({
		configPath,
		persist: { path: '.wrangler/state/v3' },
		remoteBindings: remote
	});
	const db = useDatabase(proxy.env.DB);
	console.log(`[cloudflare] using the ${remote ? 'REMOTE (live)' : 'local'} D1 database and R2 bucket`);
	return { db, d1: proxy.env.DB, files: proxy.env.FILES, env: proxy.env, close: () => proxy.dispose() };
}

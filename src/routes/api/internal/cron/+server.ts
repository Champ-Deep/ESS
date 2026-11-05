import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { runCronTick } from '$lib/server/cron';

/**
 * The minute tick from Cloudflare's cron trigger (cloudflare/worker.ts). The
 * worker calls the app in-process with `__CRON` added to the bindings; a
 * request from the internet never has it, so it is refused.
 */
export const POST: RequestHandler = async ({ platform, url }) => {
	if (!(platform?.env as { __CRON?: boolean } | undefined)?.__CRON) throw error(404, 'Not found');
	const t = Number(url.searchParams.get('t'));
	const results = await runCronTick(Number.isFinite(t) && t > 0 ? new Date(t) : new Date());
	return json({ ok: true, results });
};

import { env } from '$env/dynamic/private';
import { istMinutes } from '$lib/chat/rules';

/**
 * Every background job, driven by one tick a minute.
 *
 * On Cloudflare the cron trigger in wrangler.jsonc calls this through
 * /api/internal/cron (cloudflare/worker.ts). Under Node the old setInterval
 * schedulers still run instead (hooks.server.ts), so this is not used there.
 *
 *   every minute     reminders, scheduled announcement emails, login emails,
 *                    stuck-send recovery
 *   every 5 min      shift alerts (punch-out reminder, missed punch)
 *   every 10 min     chat roster sync, unread digests
 *   every 30 min     celebrations (from 9 am IST), Zoom summaries reconcile
 *   PROHANCE_POLL_MINUTES (default 30)   ProHance attendance pull
 *   hourly           Clerk account sync
 *   every 6 h        chat retention
 *
 * Jobs are independent: one failing is logged and the others still run.
 */

type Job = { name: string; every: number; run: () => Promise<unknown> };

function prohanceEvery(): number {
	const raw = Number(env.PROHANCE_POLL_MINUTES ?? '30');
	if (raw === 0) return 0;
	return Number.isFinite(raw) && raw >= 5 ? Math.round(raw) : 30;
}

const jobs = (now: Date): Job[] => [
	{ name: 'reminders', every: 1, run: async () => (await import('./chat/notify')).fireReminders(now) },
	{ name: 'announcement emails', every: 1, run: async () => (await import('./announcements')).dispatchDueEmails(now) },
	{
		name: 'login emails',
		every: 1,
		run: async () => {
			const m = await import('./login-emails');
			await m.recoverStuckSends();
			// Kept well inside the 30 s a minute-frequency cron invocation may run.
			await sendLoginEmailsFor(25_000, m.sendNextLoginEmail);
		}
	},
	{ name: 'shift alerts', every: 5, run: async () => (await import('./shift-alerts')).sendShiftAlerts(now) },
	{ name: 'roster sync', every: 10, run: async () => (await import('./chat/sync')).syncAll() },
	{ name: 'digest', every: 10, run: async () => (await import('./chat/notify')).sendDigests(now) },
	{
		name: 'celebrations',
		every: 30,
		run: async () => {
			if (istMinutes(now) >= 9 * 60) await (await import('./chat/notify')).postCelebrations(now);
		}
	},
	{ name: 'zoom reconcile', every: 30, run: async () => (await import('./meetings/service')).reconcileZoom(now) },
	{
		name: 'prohance',
		every: prohanceEvery(),
		run: async () => {
			const p = await import('./prohance');
			if (p.isProhanceConfigured()) await p.runProhanceSync('poll');
		}
	},
	{
		name: 'clerk sync',
		every: 60,
		run: async () => {
			const { clerkConfigured } = await import('./clerk');
			if (clerkConfigured()) await (await import('./clerk-sync')).syncClerkAccounts();
		}
	},
	{ name: 'retention', every: 360, run: async () => (await import('./chat/notify')).applyRetention(now) }
];

/**
 * Login emails go out one at a time at the cadence HR set (seconds apart), so
 * within one tick keep sending until the time budget runs out or the queue is empty.
 */
async function sendLoginEmailsFor(budgetMs: number, sendNext: () => Promise<string>) {
	const until = Date.now() + budgetMs;
	while (Date.now() < until) {
		const r = await sendNext();
		if (r === 'idle') return;
		if (r === 'waiting') await new Promise((res) => setTimeout(res, 2_000));
	}
}

export async function runCronTick(now = new Date()) {
	const minuteOfDay = now.getUTCHours() * 60 + now.getUTCMinutes();
	const due = jobs(now).filter((j) => j.every > 0 && minuteOfDay % j.every === 0);
	const results = await Promise.allSettled(
		due.map(async (j) => {
			const started = Date.now();
			try {
				await j.run();
			} catch (err) {
				console.error(`[cron] ${j.name} failed:`, err instanceof Error ? (err.stack ?? err.message) : err);
				throw err;
			} finally {
				const took = Date.now() - started;
				if (took > 5_000) console.log(`[cron] ${j.name} took ${took} ms`);
			}
		})
	);
	return due.map((j, i) => ({ job: j.name, ok: results[i].status === 'fulfilled' }));
}

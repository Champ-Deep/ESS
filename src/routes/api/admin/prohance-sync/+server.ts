import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/client';
import { prohanceSyncs } from '$lib/server/db/schema';
import { isProhanceConfigured, runProhanceSync, syncWindow } from '$lib/server/prohance';
import { desc } from 'drizzle-orm';
import { requireCap } from '$lib/server/capabilities';

/** Sync status + recent runs, for the admin UI and for functional testing. */
export const GET: RequestHandler = async (event) => {
	requireCap(event, 'attendance.device_sync');

	const syncs = await db
		.select()
		.from(prohanceSyncs)
		.orderBy(desc(prohanceSyncs.startedAt))
		.limit(10);

	return json({
		configured: isProhanceConfigured(),
		window: syncWindow(),
		syncs
	});
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BACKFILL_DAYS = 190;

/**
 * Trigger a pull right now (same code path as the poller). An optional JSON
 * body {fromDate, toDate} backfills an explicit window instead of the default
 * one — pulled in ≤28-day chunks because ProHance caps a report at 31 days.
 * Failures come back as 502 with ProHance's reason so a bad key /
 * unauthorized IP is diagnosable from the response alone.
 */
export const POST: RequestHandler = async (event) => {
	requireCap(event, 'attendance.device_sync');

	if (!isProhanceConfigured()) {
		throw error(400, 'ProHance is not configured — set PROHANCE_BASE_URL and the credentials');
	}

	let window: { fromDate: string; toDate: string } | undefined;
	const body = await event.request.json().catch(() => null);
	if (body && (body.fromDate || body.toDate)) {
		const { fromDate, toDate } = body;
		if (!DATE_RE.test(fromDate ?? '') || !DATE_RE.test(toDate ?? '') || fromDate > toDate) {
			throw error(400, 'fromDate/toDate must be YYYY-MM-DD with fromDate <= toDate');
		}
		const span =
			(new Date(`${toDate}T00:00:00Z`).getTime() - new Date(`${fromDate}T00:00:00Z`).getTime()) /
				86_400_000 +
			1;
		if (span > MAX_BACKFILL_DAYS) {
			throw error(400, `Backfill window too large (max ${MAX_BACKFILL_DAYS} days)`);
		}
		window = { fromDate, toDate };
	}

	try {
		const result = await runProhanceSync('manual', window);
		return json(result);
	} catch (err) {
		throw error(502, err instanceof Error ? err.message : 'ProHance sync failed');
	}
};

import { env } from '$env/dynamic/private';
import { kv } from '$lib/server/chat/bus';
import { db } from '$lib/server/db/client';
import { appSettings } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { encodeMeetingUuid } from './webhook';

/**
 * The Zoom API, through one internal Server-to-Server OAuth app on the
 * company account. One install covers every host in the account, and no lead
 * signs in to Zoom from ESS.
 *
 *   ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET   the app's credentials
 *   ZOOM_WEBHOOK_SECRET                                    the app's secret token
 *   ZOOM_DEFAULT_HOST                                      a licensed Zoom user's email that hosts
 *                                                          meetings scheduled by people without
 *                                                          their own Zoom account
 *
 * The app needs the meeting summary, past participants and user read scopes
 * (admin-level), and event subscriptions for meeting.summary_completed and
 * meeting.ended pointing at /api/zoom/webhook. Without the variables every
 * call here is a no-op and Meetings offers pasted notes instead.
 */

const API = 'https://api.zoom.us/v2';

export function zoomConfigured(): boolean {
	return !!(env.ZOOM_ACCOUNT_ID && env.ZOOM_CLIENT_ID && env.ZOOM_CLIENT_SECRET);
}

export function webhookSecret(): string | null {
	return env.ZOOM_WEBHOOK_SECRET || null;
}

let memToken: { value: string; until: number } | null = null;

async function token(): Promise<string> {
	if (memToken && memToken.until > Date.now()) return memToken.value;
	try {
		const cached = await kv().get('zoom:token');
		if (cached) {
			memToken = { value: cached, until: Date.now() + 60_000 };
			return cached;
		}
	} catch {
		/* Redis down: fall through to a fresh token */
	}
	const basic = Buffer.from(`${env.ZOOM_CLIENT_ID}:${env.ZOOM_CLIENT_SECRET}`).toString('base64');
	const res = await fetch(`https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(env.ZOOM_ACCOUNT_ID ?? '')}`, {
		method: 'POST',
		headers: { Authorization: `Basic ${basic}` }
	});
	if (!res.ok) {
		const text = await res.text().catch(() => '');
		await recordStatus({ lastError: `Zoom refused the app credentials (${res.status}). Check ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID and ZOOM_CLIENT_SECRET. ${text.slice(0, 200)}` });
		throw new Error(`Zoom token request failed (${res.status})`);
	}
	const data = (await res.json()) as { access_token: string; expires_in: number };
	// Renew five minutes early so a call never starts with a token about to lapse.
	const ttl = Math.max(60, (data.expires_in ?? 3600) - 300);
	memToken = { value: data.access_token, until: Date.now() + ttl * 1000 };
	try {
		await kv().set('zoom:token', data.access_token, 'EX', ttl);
	} catch {
		/* kept in memory only */
	}
	return data.access_token;
}

export class ZoomError extends Error {
	constructor(
		message: string,
		public status: number,
		/** Zoom's own error code, e.g. 1001 "user does not exist". */
		public code?: number
	) {
		super(message);
	}
}

async function call<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
	if (!zoomConfigured()) throw new ZoomError('Zoom is not connected', 503);
	const send = async () =>
		fetch(API + path, {
			method,
			headers: { Authorization: `Bearer ${await token()}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
			body: body === undefined ? undefined : JSON.stringify(body)
		});
	let res = await send();
	if (res.status === 401) {
		// Token revoked or rotated early: one retry with a fresh one.
		memToken = null;
		await kv().del('zoom:token').catch(() => {});
		res = await send();
	}
	if (!res.ok) {
		const text = (await res.text().catch(() => '')).slice(0, 300);
		let code: number | undefined;
		try {
			code = JSON.parse(text).code;
		} catch {
			/* not JSON */
		}
		throw new ZoomError(`Zoom ${method} ${path.split('?')[0]} answered ${res.status}: ${text}`, res.status, code);
	}
	if (res.status === 204) return undefined as T;
	const raw = await res.text();
	return (raw ? JSON.parse(raw) : undefined) as T;
}

const get = <T>(path: string) => call<T>('GET', path);

/* ---------- what ESS reads ---------- */

export type ZoomSummary = {
	meeting_uuid?: string;
	meeting_id?: number | string;
	meeting_host_id?: string;
	meeting_host_email?: string;
	meeting_topic?: string;
	meeting_start_time?: string;
	meeting_end_time?: string;
	summary_title?: string;
	summary_overview?: string;
	summary_details?: { label?: string; summary?: string }[];
	next_steps?: string[];
	/** Present when the host edited the summary in Zoom; it wins over the original. */
	edited_summary?: { summary_overview?: string; summary_details?: { label?: string; summary?: string }[]; next_steps?: string[] };
};

export function meetingSummary(uuid: string) {
	return get<ZoomSummary>(`/meetings/${encodeMeetingUuid(uuid)}/meeting_summary`);
}

export type ZoomParticipant = { id?: string; user_id?: string; name?: string; user_email?: string };

export async function pastParticipants(uuid: string): Promise<ZoomParticipant[]> {
	const out: ZoomParticipant[] = [];
	let next = '';
	for (let page = 0; page < 5; page++) {
		const r = await get<{ participants?: ZoomParticipant[]; next_page_token?: string }>(
			`/past_meetings/${encodeMeetingUuid(uuid)}/participants?page_size=300${next ? `&next_page_token=${encodeURIComponent(next)}` : ''}`
		);
		out.push(...(r.participants ?? []));
		if (!r.next_page_token) break;
		next = r.next_page_token;
	}
	return out;
}

export type ZoomSummaryListItem = { meeting_uuid: string; meeting_id?: number | string; meeting_host_email?: string; meeting_topic?: string; meeting_start_time?: string };

/** Summaries created in the account between two dates, to catch missed webhooks. */
export async function listSummaries(from: string, to: string): Promise<ZoomSummaryListItem[]> {
	const out: ZoomSummaryListItem[] = [];
	let next = '';
	for (let page = 0; page < 10; page++) {
		const r = await get<{ summaries?: ZoomSummaryListItem[]; next_page_token?: string }>(
			`/meetings/meeting_summaries?page_size=300&from=${from}&to=${to}${next ? `&next_page_token=${encodeURIComponent(next)}` : ''}`
		);
		out.push(...(r.summaries ?? []));
		if (!r.next_page_token) break;
		next = r.next_page_token;
	}
	return out;
}

export type ZoomUpcoming = { uuid?: string; id: number | string; topic: string; start_time: string; duration?: number; join_url?: string };

/** A host's meetings still to come, for the day strip. Empty when Zoom can't say. */
export async function upcomingFor(email: string): Promise<ZoomUpcoming[]> {
	if (!zoomConfigured()) return [];
	const key = `zoom:upcoming:${email.toLowerCase()}`;
	try {
		const hit = await kv().get(key);
		if (hit) return JSON.parse(hit);
	} catch {
		/* no cache */
	}
	try {
		const r = await get<{ meetings?: ZoomUpcoming[] }>(`/users/${encodeURIComponent(email)}/meetings?type=upcoming&page_size=30`);
		const list = r.meetings ?? [];
		await kv().set(key, JSON.stringify(list), 'EX', 600).catch(() => {});
		return list;
	} catch {
		return [];
	}
}

/* ---------- what Admin Controls shows ---------- */

export type ZoomStatus = { lastEvent?: string; lastEventAt?: string; lastError?: string | null; lastErrorAt?: string; lastReconcileAt?: string };

export async function readStatus(): Promise<ZoomStatus> {
	const [row] = await db.select().from(appSettings).where(eq(appSettings.key, 'zoom_status')).limit(1);
	return (row?.value as ZoomStatus) ?? {};
}

export async function recordStatus(patch: ZoomStatus) {
	const next = { ...(await readStatus()), ...patch, ...(patch.lastError ? { lastErrorAt: new Date().toISOString() } : {}) };
	await db
		.insert(appSettings)
		.values({ key: 'zoom_status', value: next })
		.onConflictDoUpdate({ target: appSettings.key, set: { value: next, updatedAt: new Date() } });
}

/* ---------- scheduling from ESS ---------- */

export type ZoomUserCheck = { exists: boolean; licensed: boolean };

/**
 * Whether `key` (a Zoom email or user id) is a user in the company Zoom
 * account, and licensed. Only those are offered as hosts. Cached for a day,
 * since licences rarely change and the schedule dialog asks on every open.
 */
export async function zoomUserCheck(key: string): Promise<ZoomUserCheck> {
	const cacheKey = `zoom:user:${key.toLowerCase()}`;
	try {
		const hit = await kv().get(cacheKey);
		if (hit) return JSON.parse(hit);
	} catch {
		/* no cache */
	}
	let result: ZoomUserCheck = { exists: false, licensed: false };
	try {
		const u = await get<{ type?: number; status?: string }>(`/users/${encodeURIComponent(key)}`);
		result = { exists: u.status !== 'inactive', licensed: u.type === 2 && u.status !== 'inactive' };
	} catch (err) {
		// Anything but "no such user" (a Zoom outage, a missing scope) is not
		// cached, so it is asked again next time.
		if (!(err instanceof ZoomError && (err.status === 404 || err.code === 1001))) return result;
	}
	await kv().set(cacheKey, JSON.stringify(result), 'EX', 24 * 3600).catch(() => {});
	return result;
}

export type CreatedMeeting = { id: number | string; uuid?: string; join_url: string; start_url?: string; start_time?: string; duration?: number };

/**
 * A meeting scheduled in ESS. It is created under the scheduler's own Zoom
 * user when they have one in the company account, otherwise under
 * ZOOM_DEFAULT_HOST; either way ESS records the scheduler as the host. The
 * AI summary starts by itself so the minutes come back to ESS.
 */
/**
 * The company account that hosts when nobody else's Zoom account is picked:
 * ZOOM_DEFAULT_HOST when set, otherwise found in the Zoom account itself —
 * the licensed owner, else a licensed admin, else any licensed user. The
 * lookup is cached for a day, so a missing variable never leaves scheduling
 * without a host.
 */
export async function defaultZoomHost(): Promise<string | null> {
	const set = env.ZOOM_DEFAULT_HOST?.trim();
	if (set) return set;
	if (!zoomConfigured()) return null;
	try {
		const hit = await kv().get('zoom:default-host');
		if (hit) return hit;
	} catch {
		/* no cache */
	}
	try {
		const r = await get<{ users?: { email: string; type?: number; role_id?: string; role_name?: string; status?: string }[] }>('/users?status=active&page_size=300');
		const licensed = (r.users ?? []).filter((u) => u.type === 2 && u.email);
		const rank = (u: (typeof licensed)[number]) => (u.role_id === '0' || /owner/i.test(u.role_name ?? '') ? 0 : u.role_id === '1' || /admin/i.test(u.role_name ?? '') ? 1 : 2);
		const pick = licensed.sort((a, b) => rank(a) - rank(b))[0]?.email ?? null;
		if (pick) await kv().set('zoom:default-host', pick, 'EX', 24 * 3600).catch(() => {});
		return pick;
	} catch (err) {
		console.error('[zoom] could not find a default host:', err);
		return null;
	}
}

/**
 * Creates the call under the first of `hosts` (Zoom emails or Zoom user ids)
 * that Zoom accepts, falling back to the company default host last.
 */
export async function createZoomMeeting(input: { hosts: string[]; topic: string; startLocal: string; durationMin: number; agenda?: string | null }): Promise<CreatedMeeting & { hostedBy: string }> {
	const body = {
		topic: input.topic.slice(0, 200),
		type: 2,
		start_time: input.startLocal,
		timezone: 'Asia/Kolkata',
		duration: input.durationMin,
		agenda: input.agenda?.slice(0, 2000) ?? undefined,
		settings: {
			join_before_host: true,
			waiting_room: false,
			mute_upon_entry: true,
			auto_start_meeting_summary: true
		}
	};
	const hosts = [...input.hosts, await defaultZoomHost()].filter((h, i, a): h is string => !!h && a.indexOf(h) === i);
	let last: unknown = null;
	for (const host of hosts) {
		try {
			const m = await call<CreatedMeeting>('POST', `/users/${encodeURIComponent(host)}/meetings`, body);
			return { ...m, hostedBy: host };
		} catch (err) {
			last = err;
			// Not a Zoom user in this account: try the next host, ending with the company one.
			if (err instanceof ZoomError && (err.status === 404 || err.code === 1001 || err.code === 1120)) continue;
			throw err;
		}
	}
	throw hosts.length === 0 || (last instanceof ZoomError && (last.status === 404 || last.code === 1001 || last.code === 1120))
		? new ZoomError('Video meetings need a host account. Ask HR to set this person\'s Zoom account in Admin Controls › Zoom, or set ZOOM_DEFAULT_HOST.', 400)
		: (last as Error);
}

export async function deleteZoomMeeting(meetingId: string) {
	try {
		await call('DELETE', `/meetings/${encodeURIComponent(meetingId)}?schedule_for_reminder=false`);
	} catch (err) {
		// Already gone in Zoom is fine.
		if (!(err instanceof ZoomError && (err.status === 404 || err.code === 3001))) throw err;
	}
}

/** A fresh start link for the host; Zoom's start links expire after two hours. */
export async function zoomStartUrl(meetingId: string): Promise<string | null> {
	const m = await get<{ start_url?: string }>(`/meetings/${encodeURIComponent(meetingId)}`);
	return m.start_url ?? null;
}

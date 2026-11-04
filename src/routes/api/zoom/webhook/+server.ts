import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { urlValidationResponse, verifyZoomSignature } from '$lib/server/zoom/webhook';
import { recordStatus, webhookSecret } from '$lib/server/zoom/client';
import { ingestSummary, meetingEnded } from '$lib/server/meetings/service';

/**
 * Zoom events for Champ Hub. Signed by Zoom (src/lib/server/zoom/webhook.ts);
 * anything unsigned is refused. Zoom wants an answer within three seconds, so
 * the work after "summary completed" runs after the reply. A repeat delivery
 * is harmless: ingesting the same meeting twice never rewrites published
 * minutes.
 */
export const POST: RequestHandler = async ({ request }) => {
	const secret = webhookSecret();
	if (!secret) return json({ message: 'Zoom is not connected' }, { status: 503 });
	const raw = await request.text();
	const ok = verifyZoomSignature({
		secret,
		timestamp: request.headers.get('x-zm-request-timestamp'),
		signature: request.headers.get('x-zm-signature'),
		rawBody: raw
	});
	let body: { event?: string; payload?: { plainToken?: string; object?: Record<string, unknown> } };
	try {
		body = JSON.parse(raw);
	} catch {
		return json({ message: 'Not JSON' }, { status: 400 });
	}

	// Checked before anything, the URL check included: answering an unsigned one
	// would sign any string a caller chose, which is exactly how a forged event
	// signature would be made.
	if (!ok) return json({ message: 'Signature did not match' }, { status: 401 });

	// Zoom checks the endpoint when it is saved in the app.
	if (body.event === 'endpoint.url_validation' && typeof body.payload?.plainToken === 'string') {
		return json(urlValidationResponse(secret, body.payload.plainToken));
	}

	const obj = body.payload?.object ?? {};
	if (body.event === 'meeting.summary_completed' || body.event === 'meeting.summary_updated') {
		const uuid = String(obj.meeting_uuid ?? obj.uuid ?? '');
		if (uuid) {
			const meetingId = obj.meeting_id ?? obj.id;
			void ingestSummary(uuid, meetingId != null ? String(meetingId) : null).catch((err) => {
				console.error('[zoom] summary ingest failed:', err);
				void recordStatus({ lastError: err instanceof Error ? err.message : String(err) }).catch(() => {});
			});
		}
	} else if (body.event === 'meeting.ended') {
		void meetingEnded(obj as Parameters<typeof meetingEnded>[0]).catch((err) => console.error('[zoom] meeting.ended failed:', err));
	}
	void recordStatus({ lastEvent: body.event ?? 'unknown', lastEventAt: new Date().toISOString() }).catch(() => {});
	return json({ ok: true });
};

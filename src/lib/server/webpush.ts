/**
 * Web Push (RFC 8030) with message encryption (RFC 8291, aes128gcm) and VAPID
 * (RFC 8292), on Web Crypto only.
 *
 * Replaces the `web-push` package, which depends on Node's https and ECDH
 * APIs that Cloudflare Workers does not provide. Keys use the same format
 * web-push did (base64url: 65-byte uncompressed public key, 32-byte private
 * scalar), so VAPID keys already stored in app_settings keep working and
 * existing browser subscriptions stay valid.
 */

export interface PushSubscriptionKeys {
	endpoint: string;
	keys: { p256dh: string; auth: string };
}

export interface VapidKeys {
	publicKey: string;
	privateKey: string;
}

export class PushError extends Error {
	constructor(
		message: string,
		readonly statusCode: number
	) {
		super(message);
	}
}

const enc = new TextEncoder();

export function b64url(bytes: Uint8Array): string {
	let s = '';
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64url(text: string): Uint8Array {
	const t = text.replace(/-/g, '+').replace(/_/g, '/');
	const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

const buf = (u: Uint8Array) => u as unknown as BufferSource;

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey('raw', buf(ikm), 'HKDF', false, ['deriveBits']);
	const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: buf(salt), info: buf(info) }, key, bytes * 8);
	return new Uint8Array(bits);
}

/** New VAPID keys, in web-push's format. */
export async function generateVAPIDKeys(): Promise<VapidKeys> {
	const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
	const pub = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer);
	const jwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
	return { publicKey: b64url(pub), privateKey: jwk.d! };
}

/** The encrypted request body for one subscription (RFC 8291 §4, single record). */
export async function encryptPayload(sub: PushSubscriptionKeys, payload: string, salt = crypto.getRandomValues(new Uint8Array(16))) {
	const uaPublic = unb64url(sub.keys.p256dh);
	const authSecret = unb64url(sub.keys.auth);

	const local = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
	const asPublic = new Uint8Array((await crypto.subtle.exportKey('raw', local.publicKey)) as ArrayBuffer);
	const uaKey = await crypto.subtle.importKey('raw', buf(uaPublic), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
	const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));

	const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic);
	const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
	const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
	const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

	// Payload followed by the 0x02 "last record" delimiter, no padding.
	const plain = concat(enc.encode(payload), new Uint8Array([2]));
	const aes = await crypto.subtle.importKey('raw', buf(cek), 'AES-GCM', false, ['encrypt']);
	const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(nonce) }, aes, buf(plain)));

	const rs = new Uint8Array(4);
	new DataView(rs.buffer).setUint32(0, 4096);
	return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

/** The VAPID Authorization header value for the push service at `endpoint`. */
export async function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string): Promise<string> {
	const pub = unb64url(keys.publicKey);
	const jwk: JsonWebKey = {
		kty: 'EC',
		crv: 'P-256',
		x: b64url(pub.slice(1, 33)),
		y: b64url(pub.slice(33, 65)),
		d: keys.privateKey,
		ext: true
	};
	const signingKey = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
	const header = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
	const claims = b64url(
		enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }))
	);
	const unsigned = `${header}.${claims}`;
	// Web Crypto's ECDSA signature is already the raw r||s form JWS wants.
	const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signingKey, buf(enc.encode(unsigned))));
	return `vapid t=${unsigned}.${b64url(sig)}, k=${keys.publicKey}`;
}

/** Sends one push message. Throws PushError with the push service's status on failure. */
export async function sendNotification(
	sub: PushSubscriptionKeys,
	payload: string,
	opts: { vapid: VapidKeys; subject: string; TTL?: number; urgency?: 'very-low' | 'low' | 'normal' | 'high' }
) {
	const body = await encryptPayload(sub, payload);
	const res = await fetch(sub.endpoint, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/octet-stream',
			'Content-Encoding': 'aes128gcm',
			TTL: String(opts.TTL ?? 3600),
			Urgency: opts.urgency ?? 'normal',
			Authorization: await vapidAuthorization(sub.endpoint, opts.vapid, opts.subject)
		},
		body: body as unknown as BodyInit
	});
	if (!res.ok) throw new PushError(`Push service returned ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`, res.status);
	return res.status;
}

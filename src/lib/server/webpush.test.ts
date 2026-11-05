import { describe, expect, it } from 'vitest';
import { createECDH, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { importJWK, jwtVerify } from 'jose';
import { b64url, encryptPayload, generateVAPIDKeys, unb64url, vapidAuthorization } from './webpush';

// The reference implementation web-push itself uses, kept only to check ours.
const ece = createRequire(import.meta.url)('http_ece') as {
	decrypt(buf: Buffer, params: { version: string; privateKey: unknown; dh?: string; authSecret: string }): Buffer;
};

function browserSubscription() {
	const ua = createECDH('prime256v1');
	ua.generateKeys();
	const auth = randomBytes(16);
	return {
		ua,
		auth,
		sub: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: b64url(ua.getPublicKey()), auth: b64url(auth) } }
	};
}

describe('web push (RFC 8291)', () => {
	it('encrypts a payload the reference decrypter reads back', async () => {
		const { ua, auth, sub } = browserSubscription();
		const body = await encryptPayload(sub, JSON.stringify({ title: 'Hi', body: 'Leave approved' }));
		const plain = ece.decrypt(Buffer.from(body), { version: 'aes128gcm', privateKey: ua, authSecret: b64url(auth) });
		expect(JSON.parse(plain.toString('utf8'))).toEqual({ title: 'Hi', body: 'Leave approved' });
	});

	it('signs a VAPID token the public key verifies, for the push origin', async () => {
		const keys = await generateVAPIDKeys();
		expect(unb64url(keys.publicKey)).toHaveLength(65);
		expect(unb64url(keys.privateKey)).toHaveLength(32);
		const header = await vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', keys, 'mailto:hr@champ-hr.com');
		const m = header.match(/^vapid t=([^,]+), k=(.+)$/)!;
		expect(m[2]).toBe(keys.publicKey);
		const pub = unb64url(keys.publicKey);
		const key = await importJWK({ kty: 'EC', crv: 'P-256', x: b64url(pub.slice(1, 33)), y: b64url(pub.slice(33)) }, 'ES256');
		const { payload } = await jwtVerify(m[1], key);
		expect(payload.aud).toBe('https://fcm.googleapis.com');
		expect(payload.sub).toBe('mailto:hr@champ-hr.com');
	});

	it('keeps working with keys made by the old web-push package', async () => {
		// web-push stored raw P-256 keys: 65-byte public, 32-byte private, base64url.
		const old = createECDH('prime256v1');
		old.generateKeys();
		const keys = { publicKey: b64url(old.getPublicKey()), privateKey: b64url(old.getPrivateKey()) };
		await expect(vapidAuthorization('https://updates.push.services.mozilla.com/wpush/v2/x', keys, 'mailto:a@b.c')).resolves.toMatch(/^vapid t=/);
	});
});

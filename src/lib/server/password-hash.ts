import { argon2d, argon2i, argon2id } from '@noble/hashes/argon2.js';

/**
 * Argon2 password hashing in plain JavaScript.
 *
 * The portal used @node-rs/argon2, a native Node addon that cannot load on
 * Cloudflare Workers. This produces and checks the same PHC strings
 * ($argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>), so every password already in
 * the database keeps working, and hashes made here still verify under Node.
 *
 * No SvelteKit imports: the seed scripts use it under plain Node too.
 */

export const ARGON2_PARAMS = { m: 19456, t: 2, p: 1 } as const;
const SALT_BYTES = 16;
const HASH_BYTES = 32;

function b64(bytes: Uint8Array): string {
	let s = '';
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/=+$/, '');
}

function unb64(text: string): Uint8Array {
	const padded = text + '='.repeat((4 - (text.length % 4)) % 4);
	const bin = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

const VARIANTS = { argon2id, argon2i, argon2d } as const;

export async function hashPassword(password: string): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
	const { m, t, p } = ARGON2_PARAMS;
	const out = argon2id(password, salt, { m, t, p, dkLen: HASH_BYTES });
	return `$argon2id$v=19$m=${m},t=${t},p=${p}$${b64(salt)}$${b64(out)}`;
}

/** Checks a password against a PHC-format argon2 hash. Malformed hashes never match. */
export async function verifyPasswordHash(encoded: string, password: string): Promise<boolean> {
	const parts = encoded.split('$');
	// ['', 'argon2id', 'v=19', 'm=..,t=..,p=..', salt, hash]
	if (parts.length !== 6) return false;
	const variant = VARIANTS[parts[1] as keyof typeof VARIANTS];
	if (!variant) return false;
	const version = Number(parts[2].replace('v=', ''));
	const params = Object.fromEntries(parts[3].split(',').map((kv) => kv.split('=') as [string, string]));
	const m = Number(params.m);
	const t = Number(params.t);
	const p = Number(params.p);
	if (![m, t, p, version].every((n) => Number.isInteger(n) && n > 0)) return false;
	// Refuse absurd costs rather than exhausting the Worker's memory.
	if (m > 256 * 1024 || t > 10 || p > 8) return false;
	let salt: Uint8Array;
	let expected: Uint8Array;
	try {
		salt = unb64(parts[4]);
		expected = unb64(parts[5]);
	} catch {
		return false;
	}
	const actual = variant(password, salt, { m, t, p, version, dkLen: expected.length });
	if (actual.length !== expected.length) return false;
	let diff = 0;
	for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
	return diff === 0;
}

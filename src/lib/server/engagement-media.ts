import { GridFSBucket, ObjectId } from 'mongodb';
import { Readable } from 'node:stream';
import { getMongo } from '$lib/server/db/mongo';

/**
 * Engagement videos (celebration templates and Home reels), kept in the
 * portal's own MongoDB as GridFS chunks and served by the portal itself: no
 * CDN, no third party. GridFS rather than one document because a document
 * stops at 16 MB, and because chunks let a player ask for a byte range
 * (seeking, and Safari, which will not play video without ranges).
 */

const BUCKET = 'engagement_media';

async function bucket() {
	return new GridFSBucket(await getMongo(), { bucketName: BUCKET });
}

export async function saveMedia(file: { name: string; type: string; bytes: Uint8Array }, uploadedBy: string): Promise<string> {
	const b = await bucket();
	const upload = b.openUploadStream(file.name.slice(0, 200), { metadata: { contentType: file.type, uploadedBy } });
	await new Promise<void>((resolve, reject) => {
		Readable.from(Buffer.from(file.bytes)).pipe(upload).on('finish', () => resolve()).on('error', reject);
	});
	return upload.id.toString();
}

export async function deleteMedia(id: string | null | undefined): Promise<void> {
	if (!id || !ObjectId.isValid(id)) return;
	await (await bucket()).delete(new ObjectId(id)).catch(() => {
		/* already gone */
	});
}

export type MediaInfo = { length: number; contentType: string };

export async function mediaInfo(id: string): Promise<MediaInfo | null> {
	if (!ObjectId.isValid(id)) return null;
	const [f] = await (await bucket()).find({ _id: new ObjectId(id) }).limit(1).toArray();
	if (!f) return null;
	return { length: f.length, contentType: String((f.metadata as { contentType?: string } | undefined)?.contentType ?? 'video/mp4') };
}

/** The bytes [start, end] inclusive, as a web stream for a Response body. */
export async function mediaStream(id: string, start: number, end: number): Promise<ReadableStream<Uint8Array>> {
	const node = (await bucket()).openDownloadStream(new ObjectId(id), { start, end: end + 1 });
	return Readable.toWeb(node) as unknown as ReadableStream<Uint8Array>;
}

/** Parses "bytes=0-1023" against a file of `length` bytes; null for no or a bad range. */
export function parseRange(header: string | null, length: number): { start: number; end: number } | null {
	if (!header) return null;
	const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!m || (m[1] === '' && m[2] === '')) return null;
	let start: number;
	let end: number;
	if (m[1] === '') {
		// "bytes=-500": the last 500 bytes.
		start = Math.max(0, length - Number(m[2]));
		end = length - 1;
	} else {
		start = Number(m[1]);
		end = m[2] === '' ? length - 1 : Math.min(Number(m[2]), length - 1);
	}
	if (start > end || start >= length) return null;
	return { start, end };
}

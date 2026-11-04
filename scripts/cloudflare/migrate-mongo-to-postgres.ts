/**
 * One-off copy of everything the portal kept in MongoDB into Postgres, for the
 * move to Cloudflare (docs/cloudflare-deployment.md, step 6).
 *
 *   activity_log         → activity_log
 *   policy_documents     → policy_documents + stored_files (kind 'policy')
 *   profile_pictures     → stored_files (kind 'avatar', id 'avatar-<userId>')
 *   announcement_files   → stored_files (kind 'announcement')
 *   chat_files           → stored_files (kind 'chat')
 *
 * File bytes land in stored_files.data; once the portal runs on Cloudflare the
 * minute cron moves them into R2 (25 a minute) and any file opened before then
 * is moved on first read. Ids are kept (Mongo ObjectId strings), so
 * chat_messages.file_id, announcements.attachment_id and the policy
 * source_document_id columns keep pointing at the right file.
 *
 * Safe to run more than once: rows already copied are skipped.
 *
 *   MONGO_URL=mongodb://... DATABASE_URL=postgres://... npm run migrate:mongo
 *   (add -- --dry-run to only count)
 */
import { existsSync } from 'node:fs';
import { MongoClient, type Document } from 'mongodb';
import pg from 'pg';

if (existsSync('.env')) process.loadEnvFile?.('.env');

const DRY = process.argv.includes('--dry-run');
const MONGO_URL = process.env.MONGO_URL;
const DATABASE_URL = process.env.DATABASE_URL;
if (!MONGO_URL || !DATABASE_URL) {
	console.error('Set MONGO_URL (source) and DATABASE_URL (target Postgres).');
	process.exit(1);
}

/** ObjectId (24 hex) → a stable uuid, so a re-run recognises rows it already copied. */
function oidToUuid(oid: string) {
	const h = ('00000000' + oid).padStart(32, '0');
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

const bytesOf = (doc: Document) => Buffer.from(String(doc.fileBase64 ?? ''), 'base64');
const date = (v: unknown) => (v instanceof Date ? v : v ? new Date(String(v)) : new Date());

async function main() {
	const mongo = await new MongoClient(MONGO_URL!).connect();
	const mdb = mongo.db();
	const pool = new pg.Pool({ connectionString: DATABASE_URL });
	const ready = await pool.query(`select to_regclass('public.stored_files') as t`);
	if (!ready.rows[0].t) {
		console.error('Postgres has no stored_files table yet. Run `npm run db:migrate` against DATABASE_URL first.');
		process.exit(1);
	}

	const counts: Record<string, { seen: number; copied: number }> = {};
	const tally = (k: string, copied: boolean) => {
		counts[k] ??= { seen: 0, copied: 0 };
		counts[k].seen++;
		if (copied) counts[k].copied++;
	};

	async function file(id: string, kind: string, ownerId: string | null, doc: Document, filename: string) {
		const bytes = bytesOf(doc);
		if (DRY) return true;
		const r = await pool.query(
			`insert into stored_files (id, kind, owner_id, filename, mime_type, byte_size, uploaded_by, data, created_at, updated_at)
			 values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) on conflict do nothing`,
			[id, kind, ownerId, filename, String(doc.mimeType ?? 'application/octet-stream'), Number(doc.byteSize ?? bytes.length), doc.uploadedBy ? String(doc.uploadedBy) : ownerId, bytes, date(doc.createdAt ?? doc.updatedAt)]
		);
		return (r.rowCount ?? 0) > 0;
	}

	// --- activity log, in batches ---
	const BATCH = 500;
	let batch: Document[] = [];
	const flush = async () => {
		if (!batch.length) return;
		if (!DRY) {
			const values: unknown[] = [];
			const rows = batch.map((d, i) => {
				values.push(oidToUuid(String(d._id)), String(d.actorUserId ?? 'system'), String(d.action ?? 'unknown'), String(d.targetType ?? ''), d.targetId != null ? String(d.targetId) : null, d.details ? JSON.stringify(d.details) : null, date(d.createdAt));
				const b = i * 7;
				return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6}::jsonb,$${b + 7})`;
			});
			const r = await pool.query(
				`insert into activity_log (id, actor_user_id, action, target_type, target_id, details, created_at) values ${rows.join(',')} on conflict do nothing`,
				values
			);
			counts.activity_log ??= { seen: 0, copied: 0 };
			counts.activity_log.copied += r.rowCount ?? 0;
		}
		counts.activity_log ??= { seen: 0, copied: 0 };
		counts.activity_log.seen += batch.length;
		batch = [];
	};
	for await (const d of mdb.collection('activity_log').find({})) {
		batch.push(d);
		if (batch.length >= BATCH) await flush();
	}
	await flush();

	// --- policy documents ---
	for await (const d of mdb.collection('policy_documents').find({})) {
		const id = String(d._id);
		const copied = await file(id, 'policy', null, d, String(d.filename ?? 'document'));
		if (!DRY)
			await pool.query(
				`insert into policy_documents (id, kind, file_id, uploaded_by, extracted_json, extraction_model, status, created_at, published_at)
				 values ($1,$2,$1,$3,$4::jsonb,$5,$6,$7,$8) on conflict do nothing`,
				[id, String(d.kind), String(d.uploadedBy ?? ''), d.extractedJson != null ? JSON.stringify(d.extractedJson) : null, d.extractionModel ?? null, String(d.status ?? 'uploaded'), date(d.createdAt), d.publishedAt ? date(d.publishedAt) : null]
			);
		tally('policy_documents', copied);
	}

	// --- profile pictures ---
	for await (const d of mdb.collection('profile_pictures').find({})) {
		const userId = String(d.userId);
		tally('profile_pictures', await file(`avatar-${userId}`, 'avatar', userId, d, 'avatar'));
	}

	// --- announcement and chat files ---
	for await (const d of mdb.collection('announcement_files').find({})) {
		tally('announcement_files', await file(String(d._id), 'announcement', null, d, String(d.filename ?? 'attachment')));
	}
	for await (const d of mdb.collection('chat_files').find({})) {
		tally('chat_files', await file(String(d._id), 'chat', null, d, String(d.filename ?? 'file')));
	}

	console.log(DRY ? 'Dry run — nothing written.' : 'Done.');
	console.table(counts);
	await mongo.close();
	await pool.end();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});

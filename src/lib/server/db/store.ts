import { and, desc, eq, gte, ilike, inArray, isNotNull, type SQL } from 'drizzle-orm';
import { db } from './postgres';
import { activityLog, policyDocuments, storedFiles } from './schema';
import { background, bindings } from '../platform';

/*
 * The activity log and uploaded files. These lived in MongoDB until the move
 * to Cloudflare; the function names and return shapes are unchanged so every
 * caller reads the same. Rows are in Postgres; file bytes are in R2 (the FILES
 * binding) under `files/<id>`, or in stored_files.data where there is no R2
 * (Node) or for rows copied from Mongo that the cron job has not moved yet.
 *
 * Files are still handed to callers as base64 (`fileBase64`), as Mongo did.
 */

/* ======================= activity log ======================= */

export interface ActivityLogEntry {
	actorUserId: string;
	action: string;
	targetType: string;
	targetId?: string;
	details?: Record<string, unknown>;
	createdAt: Date;
}

function toEntry(r: typeof activityLog.$inferSelect): ActivityLogEntry {
	return {
		actorUserId: r.actorUserId,
		action: r.action,
		targetType: r.targetType,
		targetId: r.targetId ?? undefined,
		details: (r.details as Record<string, unknown> | null) ?? undefined,
		createdAt: r.createdAt
	};
}

export async function logActivity(entry: Omit<ActivityLogEntry, 'createdAt'>) {
	await db.insert(activityLog).values({
		actorUserId: entry.actorUserId,
		action: entry.action,
		targetType: entry.targetType,
		targetId: entry.targetId ?? null,
		details: entry.details ?? null
	});
}

/** Newest entries whose action is one of `actions`. */
export async function recentActivity(actions: string[], limit: number): Promise<ActivityLogEntry[]> {
	if (actions.length === 0) return [];
	const rows = await db.select().from(activityLog).where(inArray(activityLog.action, actions)).orderBy(desc(activityLog.createdAt)).limit(limit);
	return rows.map(toEntry);
}

const PASSWORD_ACTIONS = ['password.change', 'user.password_reset', 'user.bulk_create', 'user.bulk_reissue'];

// Audit trail of who changed/reset whose password and when — never the password
// value itself, which isn't recoverable from a one-way hash by design.
export async function getPasswordActivity(limit = 200): Promise<ActivityLogEntry[]> {
	return recentActivity(PASSWORD_ACTIONS, limit);
}

/** Champ's audit search: by actor, by subject, by a word in the action. */
export async function searchActivity(q: { since: Date; actorUserId?: string; targetId?: string; actionLike?: string; limit: number }) {
	const where: SQL[] = [gte(activityLog.createdAt, q.since)];
	if (q.actorUserId) where.push(eq(activityLog.actorUserId, q.actorUserId));
	if (q.targetId) where.push(eq(activityLog.targetId, q.targetId));
	if (q.actionLike) where.push(ilike(activityLog.action, `%${q.actionLike.replace(/[%_\\]/g, '')}%`));
	const rows = await db.select().from(activityLog).where(and(...where)).orderBy(desc(activityLog.createdAt)).limit(q.limit);
	return rows.map(toEntry);
}

/* ======================= file bytes ======================= */

const r2Key = (id: string) => `files/${id}`;

function newId() {
	return crypto.randomUUID();
}

type FileRow = typeof storedFiles.$inferSelect;

async function saveFile(row: Omit<FileRow, 'data' | 'createdAt' | 'updatedAt'>, bytes: Buffer) {
	const r2 = bindings().FILES;
	if (r2) await r2.put(r2Key(row.id), bytes, { httpMetadata: { contentType: row.mimeType } });
	const values = { ...row, data: r2 ? null : bytes, updatedAt: new Date() };
	await db
		.insert(storedFiles)
		.values(values)
		.onConflictDoUpdate({ target: storedFiles.id, set: values });
}

async function readBytes(row: FileRow): Promise<Buffer | null> {
	const r2 = bindings().FILES;
	if (row.data) {
		// Copied from Mongo and not yet in R2: move it now, serve it either way.
		if (r2) background(moveToR2(row));
		return row.data;
	}
	if (!r2) return null;
	const obj = await r2.get(r2Key(row.id));
	return obj ? Buffer.from(await obj.arrayBuffer()) : null;
}

async function moveToR2(row: Pick<FileRow, 'id' | 'mimeType' | 'data'>) {
	const r2 = bindings().FILES;
	if (!r2 || !row.data) return;
	await r2.put(r2Key(row.id), row.data, { httpMetadata: { contentType: row.mimeType } });
	await db.update(storedFiles).set({ data: null }).where(eq(storedFiles.id, row.id));
}

/** Cron: moves up to `limit` files still held in Postgres into R2. */
export async function drainFilesToR2(limit = 25): Promise<number> {
	if (!bindings().FILES) return 0;
	const rows = await db
		.select({ id: storedFiles.id, mimeType: storedFiles.mimeType, data: storedFiles.data })
		.from(storedFiles)
		.where(isNotNull(storedFiles.data))
		.limit(limit);
	for (const r of rows) await moveToR2(r);
	return rows.length;
}

async function deleteFiles(ids: string[]) {
	if (ids.length === 0) return;
	const r2 = bindings().FILES;
	if (r2) await r2.delete(ids.map(r2Key));
	await db.delete(storedFiles).where(inArray(storedFiles.id, ids));
}

async function fileById(id: string, kind: string): Promise<FileRow | null> {
	const [row] = await db
		.select()
		.from(storedFiles)
		.where(and(eq(storedFiles.id, id), eq(storedFiles.kind, kind)))
		.limit(1);
	return row ?? null;
}

/* ======================= policy documents ======================= */
// Postgres holds the structured rows extracted from these uploads (PRD §6.2);
// this is the uploaded original and its extraction.

export type PolicyDocumentKind = 'holiday_calendar' | 'leave_policy';

export interface PolicyDocumentEntry {
	kind: PolicyDocumentKind;
	filename: string;
	mimeType: string;
	fileBase64: string;
	uploadedBy: string;
	extractedJson?: unknown;
	extractionModel?: string;
	status: 'uploaded' | 'extracted' | 'extraction_failed' | 'published';
	createdAt: Date;
	publishedAt?: Date;
}

export async function insertPolicyDocument(entry: Omit<PolicyDocumentEntry, 'createdAt'>): Promise<string> {
	const id = newId();
	const bytes = Buffer.from(entry.fileBase64, 'base64');
	await saveFile({ id, kind: 'policy', ownerId: null, filename: entry.filename, mimeType: entry.mimeType, byteSize: bytes.length, uploadedBy: entry.uploadedBy }, bytes);
	await db.insert(policyDocuments).values({
		id,
		kind: entry.kind,
		fileId: id,
		uploadedBy: entry.uploadedBy,
		extractedJson: entry.extractedJson ?? null,
		extractionModel: entry.extractionModel ?? null,
		status: entry.status,
		publishedAt: entry.publishedAt ?? null
	});
	return id;
}

export async function updatePolicyDocument(
	id: string,
	update: Partial<Pick<PolicyDocumentEntry, 'extractedJson' | 'extractionModel' | 'status' | 'publishedAt'>>
) {
	if (Object.keys(update).length === 0) return;
	await db.update(policyDocuments).set(update).where(eq(policyDocuments.id, id));
}

export async function getPolicyDocument(id: string): Promise<PolicyDocumentEntry | null> {
	const [doc] = await db.select().from(policyDocuments).where(eq(policyDocuments.id, id)).limit(1);
	if (!doc) return null;
	const file = await fileById(doc.fileId, 'policy');
	const bytes = file ? await readBytes(file) : null;
	return {
		kind: doc.kind as PolicyDocumentKind,
		filename: file?.filename ?? 'document',
		mimeType: file?.mimeType ?? 'application/octet-stream',
		fileBase64: bytes ? bytes.toString('base64') : '',
		uploadedBy: doc.uploadedBy,
		extractedJson: doc.extractedJson ?? undefined,
		extractionModel: doc.extractionModel ?? undefined,
		status: doc.status as PolicyDocumentEntry['status'],
		createdAt: doc.createdAt,
		publishedAt: doc.publishedAt ?? undefined
	};
}

/** Uploaded policy documents, newest first, without the file bytes. */
export async function listPolicyDocuments(limit = 100) {
	const rows = await db
		.select({
			id: policyDocuments.id,
			kind: policyDocuments.kind,
			filename: storedFiles.filename,
			mimeType: storedFiles.mimeType,
			status: policyDocuments.status,
			uploadedBy: policyDocuments.uploadedBy,
			createdAt: policyDocuments.createdAt,
			publishedAt: policyDocuments.publishedAt
		})
		.from(policyDocuments)
		.leftJoin(storedFiles, eq(storedFiles.id, policyDocuments.fileId))
		.orderBy(desc(policyDocuments.createdAt))
		.limit(limit);
	return rows.map((r) => ({
		...r,
		kind: r.kind as PolicyDocumentKind,
		status: r.status as PolicyDocumentEntry['status'],
		filename: r.filename ?? 'document',
		mimeType: r.mimeType ?? 'application/octet-stream'
	}));
}

/** Removes an uploaded policy document. Returns false when there was none. */
export async function deletePolicyDocument(id: string): Promise<boolean> {
	const [doc] = await db.delete(policyDocuments).where(eq(policyDocuments.id, id)).returning({ fileId: policyDocuments.fileId });
	if (!doc) return false;
	await deleteFiles([doc.fileId]);
	return true;
}

/* ======================= profile pictures ======================= */
// One per user; uploading again replaces it. Images are resized client-side
// before upload, so these are small square JPEGs (see AvatarUpload.svelte).

export interface ProfilePictureEntry {
	userId: string;
	mimeType: string;
	fileBase64: string;
	byteSize: number;
	updatedAt: Date;
}

const avatarId = (userId: string) => `avatar-${userId}`;

export async function upsertProfilePicture(entry: Omit<ProfilePictureEntry, 'updatedAt'>): Promise<void> {
	const bytes = Buffer.from(entry.fileBase64, 'base64');
	await saveFile(
		{ id: avatarId(entry.userId), kind: 'avatar', ownerId: entry.userId, filename: 'avatar', mimeType: entry.mimeType, byteSize: entry.byteSize, uploadedBy: entry.userId },
		bytes
	);
}

export async function getProfilePicture(userId: string): Promise<ProfilePictureEntry | null> {
	const [row] = await db
		.select()
		.from(storedFiles)
		.where(and(eq(storedFiles.kind, 'avatar'), eq(storedFiles.ownerId, userId)))
		.limit(1);
	if (!row) return null;
	const bytes = await readBytes(row);
	if (!bytes) return null;
	return { userId, mimeType: row.mimeType, fileBase64: bytes.toString('base64'), byteSize: row.byteSize, updatedAt: row.updatedAt };
}

export async function deleteProfilePicture(userId: string): Promise<void> {
	const rows = await db
		.select({ id: storedFiles.id })
		.from(storedFiles)
		.where(and(eq(storedFiles.kind, 'avatar'), eq(storedFiles.ownerId, userId)));
	await deleteFiles(rows.map((r) => r.id));
}

/**
 * Which of the given users have a picture. Used by list views (roster,
 * approvals) so they can render <img> only where one exists, without pulling
 * every image's bytes into the page payload.
 */
export async function getUsersWithProfilePicture(userIds: string[]): Promise<Set<string>> {
	if (userIds.length === 0) return new Set();
	const rows = await db
		.select({ ownerId: storedFiles.ownerId })
		.from(storedFiles)
		.where(and(eq(storedFiles.kind, 'avatar'), inArray(storedFiles.ownerId, userIds)));
	return new Set(rows.map((r) => r.ownerId!).filter(Boolean));
}

/* ======================= announcement attachments ======================= */

export interface AnnouncementFileEntry {
	filename: string;
	mimeType: string;
	fileBase64: string;
	byteSize: number;
	uploadedBy: string;
	createdAt: Date;
}

export async function insertAnnouncementFile(entry: Omit<AnnouncementFileEntry, 'createdAt'>): Promise<string> {
	const id = newId();
	await saveFile(
		{ id, kind: 'announcement', ownerId: null, filename: entry.filename, mimeType: entry.mimeType, byteSize: entry.byteSize, uploadedBy: entry.uploadedBy },
		Buffer.from(entry.fileBase64, 'base64')
	);
	return id;
}

export async function getAnnouncementFile(id: string): Promise<AnnouncementFileEntry | null> {
	const row = await fileById(id, 'announcement');
	if (!row) return null;
	const bytes = await readBytes(row);
	if (!bytes) return null;
	return { filename: row.filename, mimeType: row.mimeType, fileBase64: bytes.toString('base64'), byteSize: row.byteSize, uploadedBy: row.uploadedBy ?? '', createdAt: row.createdAt };
}

/* ======================= chat files ======================= */

export interface ChatFileEntry {
	filename: string;
	mimeType: string;
	fileBase64: string;
	byteSize: number;
	uploadedBy: string;
}

export async function insertChatFile(entry: { filename: string; mimeType: string; bytes: Buffer; uploadedBy: string }): Promise<string> {
	const id = newId();
	await saveFile({ id, kind: 'chat', ownerId: null, filename: entry.filename, mimeType: entry.mimeType, byteSize: entry.bytes.length, uploadedBy: entry.uploadedBy }, entry.bytes);
	return id;
}

/** A chat file; with `uploadedBy`, only if that person uploaded it. */
export async function getChatFile(id: string, uploadedBy?: string): Promise<ChatFileEntry | null> {
	const row = await fileById(id, 'chat');
	if (!row || (uploadedBy && row.uploadedBy !== uploadedBy)) return null;
	const bytes = await readBytes(row);
	if (!bytes) return null;
	return { filename: row.filename, mimeType: row.mimeType, fileBase64: bytes.toString('base64'), byteSize: row.byteSize, uploadedBy: row.uploadedBy ?? '' };
}

/** Metadata only (no bytes): does this chat file exist and who uploaded it. */
export async function chatFileInfo(id: string) {
	const [row] = await db
		.select({ id: storedFiles.id, filename: storedFiles.filename, mimeType: storedFiles.mimeType, byteSize: storedFiles.byteSize, uploadedBy: storedFiles.uploadedBy })
		.from(storedFiles)
		.where(and(eq(storedFiles.id, id), eq(storedFiles.kind, 'chat')))
		.limit(1);
	return row ?? null;
}

export async function deleteChatFiles(ids: string[]) {
	if (ids.length === 0) return;
	const rows = await db
		.select({ id: storedFiles.id })
		.from(storedFiles)
		.where(and(inArray(storedFiles.id, ids), eq(storedFiles.kind, 'chat')));
	await deleteFiles(rows.map((r) => r.id));
}

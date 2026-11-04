import { MongoClient } from 'mongodb';
import { env } from '$env/dynamic/private';

const client = new MongoClient(env.MONGO_URL ?? 'mongodb://localhost:27017/champ_hr');

// Connected on first use, not on import: the build's route analysis imports
// this module with no database around, and an import-time connect that later
// fails is an unhandled rejection that kills the build. A failed attempt is
// forgotten so the next call tries again instead of failing forever.
let clientPromise: Promise<MongoClient> | null = null;

export async function getMongo() {
	clientPromise ??= client.connect().catch((err) => {
		clientPromise = null;
		throw err;
	});
	const c = await clientPromise;
	return c.db();
}

export interface ActivityLogEntry {
	actorUserId: string;
	action: string;
	targetType: string;
	targetId?: string;
	details?: Record<string, unknown>;
	createdAt: Date;
}

export async function logActivity(entry: Omit<ActivityLogEntry, 'createdAt'>) {
	const db = await getMongo();
	await db.collection<ActivityLogEntry>('activity_log').insertOne({
		...entry,
		createdAt: new Date()
	});
}

const PASSWORD_ACTIONS = [
	'password.change',
	'user.password_reset',
	'user.bulk_create',
	'user.bulk_reissue'
];

// Audit trail of who changed/reset whose password and when — never the password
// value itself, which isn't recoverable from a one-way hash by design.
export async function getPasswordActivity(limit = 200): Promise<ActivityLogEntry[]> {
	const db = await getMongo();
	return db
		.collection<ActivityLogEntry>('activity_log')
		.find({ action: { $in: PASSWORD_ACTIONS } })
		.sort({ createdAt: -1 })
		.limit(limit)
		.toArray();
}

// --- Policy documents (PRD §6.2: Mongo is system of record for versioned/rich-content
// policy uploads; Postgres holds the structured rows extracted from them) ---

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

export async function insertPolicyDocument(
	entry: Omit<PolicyDocumentEntry, 'createdAt'>
): Promise<string> {
	const db = await getMongo();
	const result = await db.collection<PolicyDocumentEntry>('policy_documents').insertOne({
		...entry,
		createdAt: new Date()
	});
	return result.insertedId.toString();
}

export async function updatePolicyDocument(
	id: string,
	update: Partial<Pick<PolicyDocumentEntry, 'extractedJson' | 'extractionModel' | 'status' | 'publishedAt'>>
) {
	const { ObjectId } = await import('mongodb');
	const db = await getMongo();
	await db
		.collection<PolicyDocumentEntry>('policy_documents')
		.updateOne({ _id: new ObjectId(id) } as never, { $set: update });
}

export async function getPolicyDocument(id: string) {
	const { ObjectId } = await import('mongodb');
	const db = await getMongo();
	return db.collection<PolicyDocumentEntry>('policy_documents').findOne({ _id: new ObjectId(id) } as never);
}

/** Uploaded policy documents, newest first, without the file bytes. */
export async function listPolicyDocuments(limit = 100) {
	const db = await getMongo();
	const rows = await db
		.collection<PolicyDocumentEntry>('policy_documents')
		.find({}, { projection: { fileBase64: 0, extractedJson: 0 } })
		.sort({ createdAt: -1 })
		.limit(limit)
		.toArray();
	return rows.map((r) => ({
		id: String((r as unknown as { _id: unknown })._id),
		kind: r.kind,
		filename: r.filename,
		mimeType: r.mimeType,
		status: r.status,
		uploadedBy: r.uploadedBy,
		createdAt: r.createdAt,
		publishedAt: r.publishedAt ?? null
	}));
}

/** Removes an uploaded policy document. Returns false when there was none. */
export async function deletePolicyDocument(id: string): Promise<boolean> {
	const { ObjectId } = await import('mongodb');
	if (!ObjectId.isValid(id)) return false;
	const db = await getMongo();
	const result = await db.collection<PolicyDocumentEntry>('policy_documents').deleteOne({ _id: new ObjectId(id) } as never);
	return result.deletedCount > 0;
}

// --- Profile pictures ---
// Stored here rather than on employee_profiles so the Postgres row that every
// roster and profile query reads stays small. One document per user; uploading
// again replaces it. Images are resized client-side before upload, so these are
// small square JPEGs (see AvatarUpload.svelte).

export interface ProfilePictureEntry {
	userId: string;
	mimeType: string;
	fileBase64: string;
	byteSize: number;
	updatedAt: Date;
}

export async function upsertProfilePicture(
	entry: Omit<ProfilePictureEntry, 'updatedAt'>
): Promise<void> {
	const db = await getMongo();
	await db
		.collection<ProfilePictureEntry>('profile_pictures')
		.updateOne(
			{ userId: entry.userId },
			{ $set: { ...entry, updatedAt: new Date() } },
			{ upsert: true }
		);
}

export async function getProfilePicture(userId: string): Promise<ProfilePictureEntry | null> {
	const db = await getMongo();
	return db.collection<ProfilePictureEntry>('profile_pictures').findOne({ userId });
}

export async function deleteProfilePicture(userId: string): Promise<void> {
	const db = await getMongo();
	await db.collection<ProfilePictureEntry>('profile_pictures').deleteOne({ userId });
}

/**
 * Which of the given users have a picture. Used by list views (roster,
 * approvals) so they can render <img> only where one exists, without pulling
 * every image's bytes into the page payload.
 */
export async function getUsersWithProfilePicture(userIds: string[]): Promise<Set<string>> {
	if (userIds.length === 0) return new Set();
	const db = await getMongo();
	const rows = await db
		.collection<ProfilePictureEntry>('profile_pictures')
		.find({ userId: { $in: userIds } }, { projection: { userId: 1 } })
		.toArray();
	return new Set(rows.map((r) => r.userId));
}

// --- Announcement attachments ---
// One file per announcement (a circular, a poster). Kept here beside the policy
// documents for the same reason: the Postgres row stays small and only the
// download reads the bytes.

export interface AnnouncementFileEntry {
	filename: string;
	mimeType: string;
	fileBase64: string;
	byteSize: number;
	uploadedBy: string;
	createdAt: Date;
}

export async function insertAnnouncementFile(entry: Omit<AnnouncementFileEntry, 'createdAt'>): Promise<string> {
	const db = await getMongo();
	const result = await db
		.collection<AnnouncementFileEntry>('announcement_files')
		.insertOne({ ...entry, createdAt: new Date() });
	return result.insertedId.toString();
}

export async function getAnnouncementFile(id: string): Promise<AnnouncementFileEntry | null> {
	const { ObjectId } = await import('mongodb');
	if (!ObjectId.isValid(id)) return null;
	const db = await getMongo();
	return db.collection<AnnouncementFileEntry>('announcement_files').findOne({ _id: new ObjectId(id) } as never);
}

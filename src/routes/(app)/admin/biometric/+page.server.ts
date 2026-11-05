import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db/client';
import {
	attendanceImportTokens,
	attendanceImports,
	devicePunches,
	users
} from '$lib/server/db/schema';
import { and, count, desc, eq, gte, isNotNull, isNull, max, min, sql } from 'drizzle-orm';
import { gateAdminPage } from '$lib/server/capabilities';
import { notHidden } from '$lib/server/hidden-users';

/**
 * Manual biometric report upload — Super Admin and Admin (HR).
 *
 * The device's own scheduled export already posts to
 * /api/attendance/easytime-import; this screen is for the days that never
 * arrived, when HR has the machine's report as a spreadsheet and needs it in the
 * portal. Listing past manual uploads here makes a re-upload obvious rather than
 * something to guess at.
 */
export const load: PageServerLoad = async ({ locals }) => {
	gateAdminPage(locals, ['attendance.biometric_upload']);
	// Role is enforced by (app)/admin/+layout.server.ts — Super Admin and Admin
	// (HR), which is exactly this page's rule.

	const unmatchedSince = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

	const [recentUploads, feedImports, feedTokens, feedUnmatched] = await Promise.all([
		// Manual uploads only — the device job's imports carry a token instead of an
		// uploader, and they have their own volume.
		db
			.select({
				id: attendanceImports.id,
				filename: attendanceImports.filename,
				rowCount: attendanceImports.rowCount,
				matchedCount: attendanceImports.matchedCount,
				unmatchedCount: attendanceImports.unmatchedCount,
				createdAt: attendanceImports.createdAt,
				uploadedByName: users.fullName
			})
			.from(attendanceImports)
			.leftJoin(users, and(eq(attendanceImports.uploadedBy, users.id), notHidden))
			.where(isNotNull(attendanceImports.uploadedBy))
			.orderBy(desc(attendanceImports.createdAt))
			.limit(15),
		db
			.select({
				id: attendanceImports.id,
				filename: attendanceImports.filename,
				rowCount: attendanceImports.rowCount,
				matchedCount: attendanceImports.matchedCount,
				unmatchedCount: attendanceImports.unmatchedCount,
				duplicateCount: attendanceImports.duplicateCount,
				createdAt: attendanceImports.createdAt,
				tokenLabel: attendanceImportTokens.label
			})
			.from(attendanceImports)
			.leftJoin(attendanceImportTokens, eq(attendanceImports.tokenId, attendanceImportTokens.id))
			.where(isNotNull(attendanceImports.tokenId))
			.orderBy(desc(attendanceImports.createdAt))
			.limit(15),
		db
			.select({
				id: attendanceImportTokens.id,
				label: attendanceImportTokens.label,
				lastUsedAt: attendanceImportTokens.lastUsedAt
			})
			.from(attendanceImportTokens)
			.where(isNull(attendanceImportTokens.revokedAt))
			.orderBy(sql`${attendanceImportTokens.lastUsedAt} desc nulls last`),
		db
			.select({
				empCode: devicePunches.empCode,
				punches: count(),
				firstAt: min(devicePunches.punchedAt),
				lastAt: max(devicePunches.punchedAt)
			})
			.from(devicePunches)
			.innerJoin(attendanceImports, eq(devicePunches.importId, attendanceImports.id))
			.where(
				and(
					isNotNull(attendanceImports.tokenId),
					isNull(devicePunches.matchedUserId),
					gte(devicePunches.receivedAt, unmatchedSince)
				)
			)
			.groupBy(devicePunches.empCode)
			.orderBy(desc(max(devicePunches.punchedAt)))
			.limit(30)
	]);

	return { recentUploads, feedImports, feedTokens, feedUnmatched };
};

import type { PageServerLoad } from './$types';
import { getMongo, type ActivityLogEntry } from '$lib/server/db/mongo';
import { db } from '$lib/server/db/postgres';
import { users } from '$lib/server/db/schema';
import { inArray } from 'drizzle-orm';
import { hiddenFrom } from '$lib/server/hidden-users';

/**
 * The overview's "Recent admin activity": the last few things administrators
 * did, straight from the activity log. Only actions taken from Admin Controls
 * (and the approvals that live next to it) are listed — a person updating
 * their own profile is not admin activity.
 */
const ADMIN_ACTIONS = [
	'user.create',
	'user.delete',
	'user.password_reset',
	'user.named_role',
	'user.settings_update',
	'user.bulk_create',
	'user.bulk_reissue',
	'bulk_import.upload',
	'bulk_import.apply',
	'bulk_import.reissue',
	'login_email.send',
	'login_email.approve',
	'login_email.cancel',
	'login_email.cadence',
	'attendance.biometric_upload',
	'leave.balances_uploaded',
	'policy_document.upload_and_extract',
	'policy_document.extraction_failed',
	'holiday_calendar.publish',
	'holiday_calendar.archive',
	'leave_policy.publish',
	'leave_type.archive',
	'leave_type.delete',
	'leave_type.set_monthly_cap',
	'week_off_roster.create',
	'week_off_roster.update',
	'week_off_roster.publish',
	'week_off_roster.unpublish',
	'week_off_roster.delete',
	'role.create',
	'role.update',
	'role.delete',
	'chat.rules_update',
	'zoom.link',
	'admin.cleanup',
	'employee_profile.set_employee_code'
];

/** A plain sentence for each action, with what the details say when useful. */
function describe(e: ActivityLogEntry): { title: string; meta: string } {
	const d = (e.details ?? {}) as Record<string, unknown>;
	const str = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : null);
	const num = (k: string) => (typeof d[k] === 'number' ? (d[k] as number) : null);
	switch (e.action) {
		case 'user.create':
			return { title: 'Login created', meta: str('email') ?? str('fullName') ?? 'One person' };
		case 'user.delete':
			return { title: 'Login deleted', meta: str('email') ?? '' };
		case 'user.password_reset':
			return { title: 'Temporary password issued', meta: str('email') ?? '' };
		case 'user.named_role':
			return { title: 'Role changed', meta: str('role') ?? str('roleName') ?? '' };
		case 'user.settings_update':
			return { title: 'Reporting line or shift updated', meta: str('email') ?? '' };
		case 'user.bulk_create':
		case 'bulk_import.apply':
			return { title: 'Logins created from a spreadsheet', meta: num('created') != null ? `${num('created')} people` : (str('filename') ?? '') };
		case 'user.bulk_reissue':
		case 'bulk_import.reissue':
			return { title: 'Temporary passwords reissued', meta: num('count') != null ? `${num('count')} people` : '' };
		case 'bulk_import.upload':
			return { title: 'Spreadsheet uploaded for review', meta: str('filename') ?? '' };
		case 'login_email.send':
			return { title: 'Login emails sent', meta: num('count') != null ? `${num('count')} people` : '' };
		case 'login_email.approve':
			return { title: 'Login emails approved', meta: num('count') != null ? `${num('count')} people` : '' };
		case 'login_email.cancel':
			return { title: 'Login email cancelled', meta: '' };
		case 'login_email.cadence':
			return { title: 'Login email schedule changed', meta: '' };
		case 'attendance.biometric_upload':
			return { title: 'Attendance file imported', meta: [str('filename'), num('matchedCount') != null ? `${num('matchedCount')} rows applied` : null].filter(Boolean).join(' · ') };
		case 'leave.balances_uploaded':
			return { title: 'Leave balances set', meta: [num('year') != null ? String(num('year')) : null, num('updated') != null ? `${(num('created') ?? 0) + (num('updated') ?? 0)} balances` : null].filter(Boolean).join(' · ') };
		case 'policy_document.upload_and_extract':
			return { title: 'Policy document read', meta: str('filename') ?? str('kind') ?? '' };
		case 'policy_document.extraction_failed':
			return { title: 'Policy document could not be read', meta: str('filename') ?? '' };
		case 'holiday_calendar.publish':
			return { title: 'Holiday calendar published', meta: num('year') != null ? String(num('year')) : '' };
		case 'holiday_calendar.archive':
			return { title: 'Holiday calendar archived', meta: '' };
		case 'leave_policy.publish':
			return { title: 'Leave policy published', meta: num('count') != null ? `${num('count')} leave types` : '' };
		case 'leave_type.archive':
			return { title: 'Leave type archived', meta: str('code') ?? str('name') ?? '' };
		case 'leave_type.delete':
			return { title: 'Leave type deleted', meta: str('code') ?? str('name') ?? '' };
		case 'leave_type.set_monthly_cap':
			return { title: 'Monthly leave limit changed', meta: str('code') ?? '' };
		case 'week_off_roster.create':
			return { title: 'Week-off roster created', meta: str('name') ?? '' };
		case 'week_off_roster.update':
			return { title: 'Week-off roster changed', meta: str('name') ?? '' };
		case 'week_off_roster.publish':
			return { title: 'Week-off roster published', meta: str('name') ?? '' };
		case 'week_off_roster.unpublish':
			return { title: 'Week-off roster unpublished', meta: str('name') ?? '' };
		case 'week_off_roster.delete':
			return { title: 'Week-off roster deleted', meta: str('name') ?? '' };
		case 'role.create':
			return { title: 'Named role created', meta: str('name') ?? '' };
		case 'role.update':
			return { title: 'Named role changed', meta: str('name') ?? '' };
		case 'role.delete':
			return { title: 'Named role deleted', meta: str('name') ?? '' };
		case 'chat.rules_update':
			return { title: 'Chat rules changed', meta: '' };
		case 'zoom.link':
			return { title: 'Zoom account linked to a login', meta: '' };
		case 'admin.cleanup':
			return { title: 'Data cleanup run', meta: '' };
		case 'employee_profile.set_employee_code':
			return { title: 'Employee code set', meta: str('employeeCode') ?? '' };
		default:
			return { title: e.action.replace(/[._]/g, ' '), meta: '' };
	}
}

export const load: PageServerLoad = async ({ locals }) => {
	let entries: ActivityLogEntry[] = [];
	try {
		const mongo = await getMongo();
		entries = await mongo
			.collection<ActivityLogEntry>('activity_log')
			.find({ action: { $in: ADMIN_ACTIONS } })
			.sort({ createdAt: -1 })
			.limit(8)
			.toArray();
	} catch {
		// Mongo down: the overview still works, just without the activity list.
	}

	const actorIds = [...new Set(entries.map((e) => e.actorUserId).filter(Boolean))];
	const actors = actorIds.length ? await db.select({ id: users.id, fullName: users.fullName, email: users.email, hidden: users.hidden }).from(users).where(inArray(users.id, actorIds)) : [];
	const byId = new Map(actors.map((a) => [a.id, a]));

	return {
		recentActivity: entries.filter((e) => !hiddenFrom(locals.user!.id, byId.get(e.actorUserId))).map((e, i) => {
			const who = byId.get(e.actorUserId);
			const { title, meta } = describe(e);
			return {
				id: `${e.createdAt.getTime()}-${i}`,
				at: e.createdAt.toISOString(),
				action: e.action,
				title,
				meta,
				actorName: who?.fullName ?? 'Someone no longer on file',
				actorEmail: who?.email ?? ''
			};
		})
	};
};

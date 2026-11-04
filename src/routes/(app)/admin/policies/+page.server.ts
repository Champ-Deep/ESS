import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db/postgres';
import { shiftGroups, holidayCalendars, holidays, leaveTypes } from '$lib/server/db/schema';
import { desc } from 'drizzle-orm';
import { gateAdminPage } from '$lib/server/capabilities';
import { listPolicyDocuments } from '$lib/server/db/mongo';

export const load: PageServerLoad = async ({ locals }) => {
	gateAdminPage(locals, ['policies.publish']);

	const groups = await db.select().from(shiftGroups);
	const groupById = new Map(groups.map((g) => [g.id, g]));
	// Every calendar and leave type, archived included, so an archived one can
	// be restored or deleted rather than vanishing from the admin's view.
	const [calendars, holidayRows, types, documents] = await Promise.all([
		db.select().from(holidayCalendars).orderBy(desc(holidayCalendars.year), desc(holidayCalendars.version)),
		db.select().from(holidays),
		db.select().from(leaveTypes),
		listPolicyDocuments().catch(() => [])
	]);

	const withDetail = calendars.map((c) => ({
		...c,
		shiftGroupName: groupById.get(c.shiftGroupId)?.name ?? 'Unknown shift group',
		holidays: holidayRows.filter((h) => h.calendarId === c.id)
	}));

	return {
		shiftGroups: groups,
		publishedCalendars: withDetail.filter((c) => c.status === 'published'),
		otherCalendars: withDetail.filter((c) => c.status !== 'published'),
		leaveTypes: types.filter((t) => t.isActive),
		archivedLeaveTypes: types.filter((t) => !t.isActive),
		documents: documents.map((d) => ({ ...d, createdAt: d.createdAt.toISOString(), publishedAt: d.publishedAt?.toISOString() ?? null }))
	};
};

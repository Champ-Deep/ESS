import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db/postgres';
import { users } from '$lib/server/db/schema';
import { and, asc, eq, sql } from 'drizzle-orm';
import { gateAdminPage, hasCap } from '$lib/server/capabilities';
import { notHidden } from '$lib/server/hidden-users';
import { addToSupportTeam, removeFromSupportTeam, supportTeamRoster } from '$lib/server/support-teams';
import { isNoLoginEmail } from '$lib/no-login';
import { deskTeamOf } from '$lib/support-desk';
import type { SupportTeamKey } from '$lib/capabilities';

/**
 * HR, Employee Engagement and IT: who is in each (src/lib/capabilities.ts
 * SUPPORT_TEAMS). Anyone who can see roles and access may look; only a
 * Super Admin changes membership (re-checked in src/lib/server/support-teams.ts).
 */
export const load: PageServerLoad = async ({ locals }) => {
	const viewer = gateAdminPage(locals, ['access.view', 'system.roles']);

	const [roster, people, open] = await Promise.all([
		supportTeamRoster(),
		db
			.select({ id: users.id, fullName: users.fullName, email: users.email })
			.from(users)
			.where(and(eq(users.isActive, true), notHidden))
			.orderBy(asc(users.fullName)),
		// Desk questions still open (with at least one message), per team.
		db.execute(sql`
			select coalesce(c.desk_team, 'hr') as team, count(*)::int as n
			from chat_channels c
			where c.kind = 'desk' and c.desk_status = 'open' and c.archived_at is null
				and exists (select 1 from chat_messages m where m.channel_id = c.id)
			group by 1
		`)
	]);

	const openByTeam: Record<SupportTeamKey, number> = { hr: 0, engagement: 0, it: 0 };
	for (const r of open.rows as { team: string; n: number }[]) openByTeam[deskTeamOf(r.team)] += r.n;

	return {
		canManage: hasCap(viewer, 'people.assign_roles'),
		roster,
		openByTeam,
		// Only logins can be in a team: blue-collar staff can't answer anything.
		people: people.filter((p) => !isNoLoginEmail(p.email)).map((p) => ({ id: p.id, fullName: p.fullName, email: p.email }))
	};
};

export const actions: Actions = {
	add: async ({ locals, request }) => {
		const f = await request.formData();
		const r = await addToSupportTeam(locals.user!, String(f.get('team') ?? ''), f.getAll('userId').map(String));
		return r.ok ? { message: r.message } : fail(400, { error: r.message });
	},
	remove: async ({ locals, request }) => {
		const f = await request.formData();
		const r = await removeFromSupportTeam(locals.user!, String(f.get('team') ?? ''), String(f.get('userId') ?? ''));
		return r.ok ? { message: r.message } : fail(400, { error: r.message });
	}
};

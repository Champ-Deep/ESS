import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { and, eq } from 'drizzle-orm';
import { requireCap } from '$lib/server/capabilities';
import { db } from '$lib/server/db/postgres';
import { employeeProfiles, payrollAdjustments, users } from '$lib/server/db/schema';
import { logActivity } from '$lib/server/db/mongo';
import { hiddenFrom } from '$lib/server/hidden-users';

const ACTIONS = ['pay', 'stop', 'hold', 'sabbatical'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Finance's entries for one person in one payroll month: the salary action,
 * the HR comment, an opening-balance correction, and the person's last
 * working day (kept on their profile, since it is a fact about them, not the
 * month). Needs the "Edit payroll" privilege.
 *
 * Body: { cycleKey, userId, salaryAction?, comment?, remarks?, openingBalance?, lastWorkingDay? }
 * — a field left out is left as it is; null clears it.
 */
export const PUT: RequestHandler = async (event) => {
	const actor = requireCap(event, 'payroll.manage');
	const body = await event.request.json().catch(() => null);
	if (!body || typeof body !== 'object') throw error(400, 'Expected a JSON body');

	const { cycleKey, userId } = body as { cycleKey?: string; userId?: string };
	if (!cycleKey || !/^\d{4}-(0[1-9]|1[0-2])$/.test(cycleKey)) throw error(400, 'cycleKey must be YYYY-MM');
	if (!userId || !/^[0-9a-f-]{36}$/i.test(userId)) throw error(400, 'userId is required');
	const [person] = await db.select({ id: users.id, hidden: users.hidden }).from(users).where(eq(users.id, userId)).limit(1);
	if (!person || hiddenFrom(actor.id, person)) throw error(404, 'No such person');

	const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
	const text = (k: string, max: number) => {
		const v = (body as Record<string, unknown>)[k];
		if (v === null || v === '') return null;
		if (typeof v !== 'string') throw error(400, `${k} must be text`);
		return v.trim().slice(0, max) || null;
	};

	const set: Partial<typeof payrollAdjustments.$inferInsert> = {};
	if (has('salaryAction')) {
		const v = (body as Record<string, unknown>).salaryAction;
		if (v !== null && v !== '' && !ACTIONS.includes(String(v))) throw error(400, 'salaryAction must be pay, stop, hold or sabbatical');
		set.salaryAction = v ? String(v) : null;
	}
	if (has('comment')) set.comment = text('comment', 120);
	if (has('remarks')) set.remarks = text('remarks', 500);
	if (has('openingBalance')) {
		const v = (body as Record<string, unknown>).openingBalance;
		if (v === null || v === '') set.openingBalance = null;
		else {
			const n = Number(v);
			if (!Number.isFinite(n) || Math.abs(n) > 9999) throw error(400, 'openingBalance must be a number of days');
			set.openingBalance = String(Math.round(n * 100) / 100);
		}
	}

	let lwd: string | null | undefined;
	if (has('lastWorkingDay')) {
		const v = (body as Record<string, unknown>).lastWorkingDay;
		if (v === null || v === '') lwd = null;
		else if (typeof v === 'string' && DATE.test(v)) lwd = v;
		else throw error(400, 'lastWorkingDay must be YYYY-MM-DD');
	}

	if (Object.keys(set).length) {
		const [existing] = await db
			.select({ id: payrollAdjustments.id })
			.from(payrollAdjustments)
			.where(and(eq(payrollAdjustments.userId, userId), eq(payrollAdjustments.cycleKey, cycleKey)))
			.limit(1);
		if (existing) {
			await db.update(payrollAdjustments).set({ ...set, updatedBy: actor.id, updatedAt: new Date() }).where(eq(payrollAdjustments.id, existing.id));
		} else {
			await db.insert(payrollAdjustments).values({ userId, cycleKey, ...set, updatedBy: actor.id });
		}
	}
	if (lwd !== undefined) {
		const [profile] = await db.select({ id: employeeProfiles.id }).from(employeeProfiles).where(eq(employeeProfiles.userId, userId)).limit(1);
		if (profile) await db.update(employeeProfiles).set({ lastWorkingDay: lwd, updatedAt: new Date() }).where(eq(employeeProfiles.id, profile.id));
		else await db.insert(employeeProfiles).values({ userId, lastWorkingDay: lwd });
	}

	await logActivity({
		actorUserId: actor.id,
		action: 'payroll.adjust',
		targetType: 'user',
		targetId: userId,
		details: { cycleKey, ...set, ...(lwd !== undefined ? { lastWorkingDay: lwd } : {}) }
	});
	return json({ ok: true });
};

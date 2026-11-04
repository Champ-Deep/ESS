import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/postgres';
import { compOffCredits } from '$lib/server/db/schema';
import { desc, eq } from 'drizzle-orm';
import { logActivity } from '$lib/server/db/mongo';
import {
	evaluateCompOffEligibility,
	compOffExpiryFor,
	lapseExpiredCompOffs
} from '$lib/server/comp-off';
import { notifyNewRequest, notifyDecision } from '$lib/server/chat/cards';

/** The employee's own comp-off credits, with expired ones lapsed first (SOP §1). */
export const GET: RequestHandler = async ({ locals, url }) => {
	const user = locals.user;
	if (!user) throw error(401, 'Not signed in');

	// A "check this date" probe, used by the claim form before submitting.
	const probe = url.searchParams.get('check');
	if (probe) {
		if (!/^\d{4}-\d{2}-\d{2}$/.test(probe)) throw error(400, 'check must be YYYY-MM-DD');
		return json({ eligibility: await evaluateCompOffEligibility(user.id, probe) });
	}

	await lapseExpiredCompOffs(user.id);
	const credits = await db
		.select()
		.from(compOffCredits)
		.where(eq(compOffCredits.userId, user.id))
		.orderBy(desc(compOffCredits.workedDate));

	return json({
		credits,
		available: credits.filter((c) => c.status === 'approved').length
	});
};

export const POST: RequestHandler = async ({ locals, request }) => {
	const user = locals.user;
	if (!user) throw error(401, 'Not signed in');

	const { workedDate, note } = (await request.json()) ?? {};
	if (typeof workedDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(workedDate)) {
		throw error(400, 'A valid workedDate (YYYY-MM-DD) is required');
	}
	if (workedDate > new Date().toISOString().slice(0, 10)) {
		throw error(400, 'You cannot claim a comp-off for a future date');
	}

	// SOP §1 is enforced server-side, not just in the form: the same rules decide
	// what the UI shows and what the database will accept.
	const eligibility = await evaluateCompOffEligibility(user.id, workedDate);
	if (!eligibility.eligible) {
		throw error(422, eligibility.reasons[0] ?? 'This date is not eligible for a comp-off');
	}

	const [created] = await db
		.insert(compOffCredits)
		.values({
			userId: user.id,
			workedDate,
			workedMinutes: eligibility.workedMinutes,
			status: 'pending', // SOP §1: HR verifies and credits; never auto-granted
			expiresOn: compOffExpiryFor(workedDate),
			evidenceSnapshot: eligibility.evidence,
			note: typeof note === 'string' && note.trim() ? note.trim().slice(0, 500) : null
		})
		.returning();

	await logActivity({
		actorUserId: user.id,
		action: 'comp_off.claimed',
		targetType: 'comp_off_credit',
		targetId: created.id,
		details: { workedDate, workedMinutes: eligibility.workedMinutes, dayBasis: eligibility.dayBasis }
	});

	// Champ Chat: a card in each approver's ESS feed, and every copy kept current.
	void notifyNewRequest('comp_off', created.id).catch((err) => console.error('[chat] card failed:', err));
	return json({ credit: created });
};

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/postgres';
import { leaveTypes } from '$lib/server/db/schema';
import { updatePolicyDocument, logActivity } from '$lib/server/db/mongo';
import { eq } from 'drizzle-orm';
import { requireCap } from '$lib/server/capabilities';

interface PublishLeaveType {
	code: string;
	name: string;
	accrual_per_month: number | null;
	eligibility: string | null;
	carry_forward_cap_days: number | null;
	requires_documentation: boolean;
	documentation_note: string | null;
	fixed_days: number | null;
	/** Refreshes monthly and lapses — pink leave. Not an accruing balance. */
	monthly_quota_days?: number | null;
	/** Restricts who may apply at all; 'female' for pink leave. */
	gender_eligibility?: 'female' | 'male' | null;
	notes: string | null;
}

/**
 * Super Admin confirms the (possibly hand-edited) extracted leave policy and publishes
 * it. Upserts leave_types by `code` so re-publishing a corrected policy document
 * updates existing rows instead of duplicating them, and bumps policyVersion.
 */
export const POST: RequestHandler = async (event) => {
	const user = requireCap(event, 'policies.publish');
	const documentId = event.params.id;

	const body = await event.request.json();
	const { effectiveFrom, leaveTypes: incoming } = body as {
		effectiveFrom: string;
		leaveTypes: PublishLeaveType[];
	};

	if (!effectiveFrom || !Array.isArray(incoming) || incoming.length === 0) {
		throw error(400, 'effectiveFrom and leaveTypes[] are required');
	}

	const published = [];

	for (const lt of incoming) {
		if (!lt.code || !lt.name) continue;

		const [existing] = await db.select().from(leaveTypes).where(eq(leaveTypes.code, lt.code)).limit(1);

		const values = {
			code: lt.code,
			name: lt.name,
			accrualPerMonth: String(lt.accrual_per_month ?? 0),
			carryForwardCap: lt.carry_forward_cap_days ?? 0,
			encashmentEligible: false,
			eligibility: lt.eligibility,
			requiresDocumentation: lt.requires_documentation ?? false,
			documentationNote: lt.documentation_note,
			fixedDays: lt.fixed_days,
			// A monthly quota refreshes and lapses rather than building a balance,
			// and a gender restriction decides who may apply at all. Both were
			// extracted but never persisted, so a published pink-leave policy
			// arrived as an ordinary accrual leave open to everyone.
			monthlyQuotaDays:
				lt.monthly_quota_days != null ? String(lt.monthly_quota_days) : null,
			genderEligibility: lt.gender_eligibility ?? null,
			notes: lt.notes,
			sourceDocumentId: documentId,
			effectiveFrom
		};

		if (existing) {
			const [updated] = await db
				.update(leaveTypes)
				// Re-uploading a policy brings an archived type back: publishing it is
				// the admin saying it applies again.
				.set({ ...values, isActive: true, policyVersion: existing.policyVersion + 1 })
				.where(eq(leaveTypes.id, existing.id))
				.returning();
			published.push(updated);
		} else {
			const [created] = await db
				.insert(leaveTypes)
				.values({ ...values, policyVersion: 1 })
				.returning();
			published.push(created);
		}
	}

	await updatePolicyDocument(documentId, { status: 'published', publishedAt: new Date() });

	await logActivity({
		actorUserId: user.id,
		action: 'leave_policy.publish',
		targetType: 'policy_document',
		targetId: documentId,
		details: { effectiveFrom, publishedCodes: published.map((p) => p.code) }
	});

	return json({ leaveTypes: published }, { status: 201 });
};

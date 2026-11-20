/**
 * "Leave balance", wherever the portal shows a single figure, means Earned
 * Leave only: what has accrued up to this month (1.5 days a month by policy,
 * src/lib/server/leave-accrual.ts) less what has been taken. Sick, pink and
 * comp-off leave keep their own figures on the Leave page.
 *
 * The leave types come from the uploaded policy, so Earned Leave is
 * recognised by its code (EL, or PL for "privilege leave") or by its name.
 */
export function isEarnedLeave(type: { code?: string | null; name?: string | null } | null | undefined): boolean {
	if (!type) return false;
	const code = (type.code ?? '').trim().toUpperCase();
	if (code === 'EL' || code === 'PL' || code === 'EARNED' || code === 'EARNED_LEAVE') return true;
	return /\b(earned|privilege)\b/i.test(type.name ?? '');
}

/**
 * Which shift group an imported person belongs to. A person's holiday
 * calendar, week-off holidays and payroll holidays all hang off their shift
 * group, and an import that left it empty meant nobody saw a holiday
 * calendar at all.
 *
 * The sheet's "Type of shift" text picks the group when it names one (by
 * name or key; a partial match only when exactly one group fits). With no
 * usable text, a company with a single shift group puts everyone in it.
 * Otherwise null: HR assigns it (Admin Controls flags who is missing one).
 */
export type ShiftGroupRef = { id: string; key: string; name: string };

const norm = (s: string) =>
	s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();

export function matchShiftGroup(text: string | null | undefined, groups: ShiftGroupRef[]): string | null {
	const t = text ? norm(text) : '';
	if (t) {
		const exact = groups.find((g) => norm(g.name) === t || norm(g.key) === t);
		if (exact) return exact.id;
		const partial = groups.filter((g) => {
			const n = norm(g.name);
			return n.includes(t) || t.includes(n);
		});
		if (partial.length === 1) return partial[0].id;
	}
	return groups.length === 1 ? groups[0].id : null;
}

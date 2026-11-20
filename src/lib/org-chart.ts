/**
 * Builds the reporting hierarchy from flat user rows.
 *
 * Deliberately DB-free so it unit-tests directly, the same way the spreadsheet
 * parsers do. The route hands it plain rows; it hands back trees.
 *
 * The hard requirement is that nobody disappears. `users.reports_to` is NULL
 * for most accounts today, points outside the set whenever the caller filters
 * to one team, and — if a row were ever written directly to the database —
 * could close a loop. Each of those is a shape this has to render, not an
 * error case: an org chart that silently drops the people it cannot place is
 * worse than no org chart, because nothing tells you they are missing.
 */

export type OrgRole = "super_admin" | "admin" | "team_lead" | "employee";

export interface OrgPerson {
	id: string;
	fullName: string;
	role: OrgRole;
	reportsTo: string | null;
	teamId: string | null;
	employeeCode?: string | null;
	/** Reports to a top-level position (Chief or Mam), which has no login. */
	reportsToChief?: boolean;
	/** Which top position, when reportsToChief is set: 'chief' (default) or 'mam'. */
	topPosition?: string | null;
}

export interface OrgNode {
	person: OrgPerson;
	children: OrgNode[];
	/** 0 for a root, incrementing down each branch. Drives the indent. */
	depth: number;
}

export interface OrgChartResult {
	/**
	 * Trees grown from people who report to Chief. Chief is drawn above them
	 * as a position with no account (src/lib/chief.ts).
	 */
	underChief: OrgNode[];
	/** The same for Mam, Chief's equal, drawn as a second head beside Chief. */
	underMam: OrgNode[];
	/** Trees grown from everyone else with no manager inside this set. */
	roots: OrgNode[];
	/**
	 * People no root could reach — only possible when their chain loops. Shown
	 * as their own trees so the chart stays complete.
	 */
	orphans: OrgNode[];
	/** Ids that sit on an actual loop, so the page can warn about them. */
	cycleMemberIds: string[];
	/** Everyone placed, for a headline count. */
	totalPeople: number;
}

function byName(a: OrgNode, b: OrgNode): number {
	return a.person.fullName.localeCompare(b.person.fullName);
}

export function buildOrgTree(people: OrgPerson[]): OrgChartResult {
	const byId = new Map(people.map((p) => [p.id, p]));

	/**
	 * The manager this person actually hangs from *within this set*. Self-
	 * reference and a manager outside the set both resolve to null, which makes
	 * the person a root here rather than an error.
	 */
	const managerOf = (p: OrgPerson): string | null => {
		const m = p.reportsTo;
		if (!m || m === p.id || !byId.has(m)) return null;
		return m;
	};

	const childrenOf = new Map<string, string[]>();
	for (const p of people) {
		const m = managerOf(p);
		if (!m) continue;
		const kids = childrenOf.get(m);
		if (kids) kids.push(p.id);
		else childrenOf.set(m, [p.id]);
	}

	const visited = new Set<string>();

	const grow = (id: string, depth: number): OrgNode => {
		visited.add(id);
		// A child already visited can only be an ancestor looping back; cutting
		// the edge here is what stops the recursion. The loop is reported
		// separately rather than silently repaired — this module never writes.
		const children = (childrenOf.get(id) ?? [])
			.filter((childId) => !visited.has(childId))
			.map((childId) => grow(childId, depth + 1))
			.sort(byName);
		return { person: byId.get(id) as OrgPerson, children, depth };
	};

	const tops = people
		.filter((p) => managerOf(p) === null)
		.map((p) => grow(p.id, 0))
		.sort(byName);
	// Only someone with no manager at all hangs from Chief or Mam: a real
	// manager in the set always wins over a stale flag.
	const underTop = tops.filter((n) => n.person.reportsToChief && !n.person.reportsTo);
	const underMam = underTop.filter((n) => n.person.topPosition === 'mam');
	const underChief = underTop.filter((n) => !underMam.includes(n));
	const roots = tops.filter((n) => !underTop.includes(n));

	// Whatever is still unvisited could not be reached from any root, which
	// means its chain closes on itself. Walk each one up to name the members.
	const cycleMemberIds = new Set<string>();
	for (const p of people) {
		if (visited.has(p.id)) continue;
		const seen: string[] = [];
		let cursor: string | null = p.id;
		while (cursor && !seen.includes(cursor)) {
			seen.push(cursor);
			const node: OrgPerson | undefined = byId.get(cursor);
			cursor = node ? managerOf(node) : null;
		}
		if (cursor) {
			// Everything from where the walk rejoined itself onward is the loop.
			for (const id of seen.slice(seen.indexOf(cursor))) cycleMemberIds.add(id);
		}
	}

	// Grown in a loop, not filter().map(): the filter would run to completion
	// before a single tree was grown, so both halves of a two-person loop would
	// pass it and the second would be rendered twice. `visited` has to be
	// consulted as each person is reached, not all at once up front.
	const orphans: OrgNode[] = [];
	for (const person of people) {
		if (visited.has(person.id)) continue;
		orphans.push(grow(person.id, 0));
	}
	orphans.sort(byName);

	return {
		underChief,
		underMam,
		roots,
		orphans,
		cycleMemberIds: [...cycleMemberIds],
		totalPeople: people.length,
	};
}

/** Depth-first, root-first — the order the chart renders in. */
export function flattenDepthFirst(nodes: OrgNode[]): OrgNode[] {
	const out: OrgNode[] = [];
	const walk = (node: OrgNode) => {
		out.push(node);
		for (const child of node.children) walk(child);
	};
	for (const node of nodes) walk(node);
	return out;
}

/** How many people hang below this node, not counting the node itself. */
export function reportCount(node: OrgNode): number {
	return node.children.reduce((sum, child) => sum + 1 + reportCount(child), 0);
}

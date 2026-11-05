import { inArray as drizzleInArray, notInArray as drizzleNotInArray, sql, type Column, type SQL, type SQLWrapper } from 'drizzle-orm';

/*
 * D1 (SQLite) versions of a few query operators. Import these instead of the
 * ones from 'drizzle-orm':
 *
 *   inArray / notInArray  D1 allows at most 100 bound values per query, and
 *                         drizzle binds one per list item. These bind the whole
 *                         list as ONE JSON value and expand it with json_each,
 *                         so a list of any length works.
 *   ilike                 SQLite has no ILIKE; its LIKE already ignores case
 *                         for ASCII letters.
 */

type Operand = Column | SQL | SQLWrapper;

export function inArray(column: Operand, values: readonly unknown[] | SQLWrapper): SQL {
	if (!Array.isArray(values)) return drizzleInArray(column as Column, values as SQLWrapper);
	return sql`${column} in (select value from json_each(${JSON.stringify(values)}))`;
}

export function notInArray(column: Operand, values: readonly unknown[] | SQLWrapper): SQL {
	if (!Array.isArray(values)) return drizzleNotInArray(column as Column, values as SQLWrapper);
	return sql`${column} not in (select value from json_each(${JSON.stringify(values)}))`;
}

export function ilike(column: Operand, pattern: string | SQLWrapper): SQL {
	return sql`${column} like ${pattern}`;
}

/** Split a list so each insert stays under D1's 100-values-per-query limit. */
export function chunksFor<T>(rows: T[], columnsPerRow: number): T[][] {
	const size = Math.max(1, Math.floor(100 / Math.max(1, columnsPerRow)));
	const out: T[][] = [];
	for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
	return out;
}

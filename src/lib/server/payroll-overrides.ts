import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from './db/postgres';
import { payrollCellOverrides, users } from './db/schema';
import { logActivity } from './db/mongo';
import { notHidden } from './hidden-users';
import { ADDED_COLUMN, REMOVED_COLUMN, type CellOverride } from '$lib/payroll-sheet';
import type { SheetKey } from './payroll-export';

/**
 * Finance's manual edits to the payroll sheets (payroll_cell_overrides).
 * They change what downloads, never what the portal computes: the A/B check
 * keeps measuring the portal's own figures.
 */

export async function loadOverrides(cycleKey: string): Promise<Partial<Record<SheetKey, CellOverride[]>>> {
	const rows = await db
		.select({
			sheet: payrollCellOverrides.sheet,
			rowKey: payrollCellOverrides.rowKey,
			column: payrollCellOverrides.column,
			value: payrollCellOverrides.value,
			original: payrollCellOverrides.original,
			by: users.fullName,
			at: payrollCellOverrides.updatedAt
		})
		.from(payrollCellOverrides)
		.leftJoin(users, and(eq(users.id, payrollCellOverrides.updatedBy), notHidden))
		.where(eq(payrollCellOverrides.cycleKey, cycleKey));
	const out: Partial<Record<SheetKey, CellOverride[]>> = {};
	for (const r of rows) {
		const list = (out[r.sheet as SheetKey] ??= []);
		list.push({ rowKey: r.rowKey, column: r.column, value: r.value, original: r.original, by: r.by, at: r.at.toISOString() });
	}
	return out;
}

/** How many cells, rows added and rows removed, per sheet — for the tab badges. */
export function editCounts(overrides: Partial<Record<SheetKey, CellOverride[]>>): Partial<Record<SheetKey, number>> {
	const out: Partial<Record<SheetKey, number>> = {};
	for (const [sheet, list] of Object.entries(overrides)) {
		// An added row counts once, not once per cell typed into it.
		const added = new Set(list!.filter((o) => o.column === ADDED_COLUMN).map((o) => o.rowKey));
		out[sheet as SheetKey] = list!.filter((o) => !added.has(o.rowKey) || o.column === ADDED_COLUMN).length;
	}
	return out;
}

export type EditOp =
	| { op: 'set'; rowKey: string; column: string; value: string; original: string | null }
	| { op: 'clear'; rowKey: string; column: string }
	| { op: 'remove'; rowKey: string }
	| { op: 'restore'; rowKey: string }
	| { op: 'add' };

export async function applyEdit(cycleKey: string, sheet: SheetKey, edit: EditOp, actorId: string): Promise<{ rowKey?: string }> {
	const upsert = async (rowKey: string, column: string, value: string, original: string | null) => {
		await db
			.insert(payrollCellOverrides)
			.values({ cycleKey, sheet, rowKey, column, value, original, updatedBy: actorId })
			.onConflictDoUpdate({
				target: [payrollCellOverrides.cycleKey, payrollCellOverrides.sheet, payrollCellOverrides.rowKey, payrollCellOverrides.column],
				set: { value, updatedBy: actorId, updatedAt: new Date() }
			});
	};
	const remove = async (rowKey: string, column?: string) => {
		const where = [eq(payrollCellOverrides.cycleKey, cycleKey), eq(payrollCellOverrides.sheet, sheet), eq(payrollCellOverrides.rowKey, rowKey)];
		if (column) where.push(eq(payrollCellOverrides.column, column));
		await db.delete(payrollCellOverrides).where(and(...where));
	};

	let result: { rowKey?: string } = {};
	switch (edit.op) {
		case 'set':
			await upsert(edit.rowKey, edit.column, edit.value, edit.original);
			break;
		case 'clear':
			await remove(edit.rowKey, edit.column);
			break;
		case 'remove':
			// A row Finance added is simply deleted with all its cells.
			if (edit.rowKey.startsWith('manual:')) await remove(edit.rowKey);
			else await upsert(edit.rowKey, REMOVED_COLUMN, '1', null);
			break;
		case 'restore':
			await remove(edit.rowKey, REMOVED_COLUMN);
			break;
		case 'add': {
			const rowKey = `manual:${randomUUID()}`;
			await upsert(rowKey, ADDED_COLUMN, '1', null);
			result = { rowKey };
			break;
		}
	}
	await logActivity({
		actorUserId: actorId,
		action: 'payroll.sheet_edit',
		targetType: 'payroll',
		targetId: `${cycleKey}/${sheet}`,
		details: { ...edit, ...result }
	});
	return result;
}

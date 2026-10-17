import { sql } from "drizzle-orm";
import { db } from "@/db";
import { page } from "@/db/schema";
import { PropertyValueError } from "@/lib/properties";
import { holdsOptions } from "@/lib/property-types";
import { splitList } from "@/lib/import/csv";
import type { PastedRow } from "@/lib/table-clipboard";
import { AccessError } from "@/server/access";
import type { WriteActor } from "@/server/collab/bridge";
import {
  afterRowWrites,
  bulkRowIds,
  checkLoops,
  MAX_BULK_ROWS,
  notifyRows,
  requireDatabase,
  rowsWithAccess,
  syncPairedRelationsMany,
  type DatabaseProperty,
} from "@/server/databases";
import { addMissingOptions, checkRows, checkValues, importTargets, writeRows } from "@/server/import/csv";
import { renamePage } from "@/server/pages";
import { rowChanged } from "@/server/row-events";

/**
 * Cells pasted into a database table (see lib/table-clipboard): different values for each row in
 * one call, and rows added below the last one. Values come as a CSV import reads them (option and
 * people names, related rows' titles) and are checked the same way: options a select names that it
 * lacks are added, and a value that can't go in (a person who isn't in the workspace, a property
 * the viewer may not change) is left out and counted rather than stopping the rest. Rows the
 * viewer can't edit are skipped and counted too.
 */
export type PasteResult = { updated: string[]; created: string[]; skippedRows: number; invalid: number };

export async function pasteRows(
  actor: WriteActor,
  databaseId: string,
  { updates, newRows }: { updates: (PastedRow & { rowId: string })[]; newRows: PastedRow[] },
): Promise<PasteResult> {
  const { userId } = actor;
  const ids = bulkRowIds(updates.map((u) => u.rowId));
  if (newRows.length > MAX_BULK_ROWS) {
    throw new PropertyValueError(`At most ${MAX_BULK_ROWS} rows can be changed at once`, "tooManyRows", { max: String(MAX_BULK_ROWS) });
  }
  const database = await requireDatabase(userId, databaseId, newRows.length ? "edit" : "view");
  if (database.archivedAt) throw new AccessError("The database is in the trash");

  // Only properties the viewer may fill in; values of any other are left out like invalid ones.
  let props = await importTargets(userId, databaseId);
  const invalid = new Map<string, number>();
  let dropped = 0;
  const known = (values: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(values)) {
      if (props.some((p) => p.id === key)) out[key] = value;
      else dropped++;
    }
    return out;
  };
  const byRow = new Map(updates.map((u) => [u.rowId, { title: u.title, values: known(u.values) }] as const));
  const added = newRows.map((r) => ({ title: (r.title ?? "").replace(/\s+/g, " ").trim(), values: known(r.values) }));

  // Missing options first, so the values below find them. Adding one changes the property, which
  // needs edit access to the database, as typing a new one into a cell does (databases.ensureOption):
  // someone who may only edit some of its rows gets the values that name an option it lacks left
  // out instead.
  const all = [...byRow.values(), ...added];
  const mayAddOptions = newRows.length > 0 || (await requireDatabase(userId, databaseId, "edit").then(() => true, () => false));
  if (mayAddOptions) {
    props = await Promise.all(
      props.map(async (prop) => {
        if (!holdsOptions(prop.type)) return prop;
        const names = all.flatMap(({ values }) => optionNames(prop, values[prop.id]));
        return names.length ? ((await addMissingOptions(prop, names)) ?? prop) : prop;
      }),
    );
  }

  // Rows already there: checked one by one against what they hold, then written.
  const found = await rowsWithAccess(userId, databaseId, ids, "edit");
  const writes: { row: (typeof found.rows)[number]; values: Record<string, unknown>; title?: string }[] = [];
  for (const row of found.rows) {
    const update = byRow.get(row.id)!;
    const values = Object.keys(update.values).length ? await checkValues(userId, databaseId, update.values, props, invalid, row) : {};
    writes.push({ row, values, title: update.title });
  }
  await checkLoops(databaseId, writes.map((w) => ({ rowId: w.row.id, values: w.values })));

  const changes: { rowId: string; before: Record<string, unknown>; after: Record<string, unknown> }[] = [];
  for (const { row, values } of writes) {
    if (!Object.keys(values).length) continue;
    const set = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== null));
    const cleared = Object.keys(values).filter((k) => values[k] === null);
    // Merged in SQL, so a concurrent edit of another property of the same row isn't overwritten.
    const minus = cleared.length
      ? sql` - ARRAY[${sql.join(
          cleared.map((k) => sql`${k}::text`),
          sql`, `,
        )}]::text[]`
      : sql``;
    await db.execute(sql`
      update ${page} set
        properties = (properties || ${JSON.stringify(set)}::jsonb)${minus},
        updated_by = ${userId},
        updated_at = now()
      where ${page.id} = ${row.id}
    `);
    const after: Record<string, unknown> = { ...row.properties, ...set };
    for (const k of cleared) delete after[k];
    // Rows of a database kept as a template link one way and assign nobody (see updateRowProperties).
    if (!row.inTemplate) changes.push({ rowId: row.id, before: row.properties, after });
  }
  if (changes.length) {
    await syncPairedRelationsMany(databaseId, changes);
    await afterRowWrites(userId, databaseId, changes);
  }
  if (writes.length) {
    notifyRows(databaseId);
    for (const { row } of writes) rowChanged({ rowId: row.id, databaseId, userId });
  }

  let skippedRows = found.skipped.length;
  // Titles last, once the values above are written and announced. They live in each row's shared
  // document (see pages.renamePage); a locked row keeps its own.
  for (const { row, title } of writes) {
    if (title === undefined) continue;
    try {
      await renamePage(actor, row.id, title);
    } catch (error) {
      if ((error as { code?: string }).code !== "pageLocked" && !(error instanceof AccessError)) throw error;
      skippedRows++;
    }
  }
  // Rows below the last one: checked and added together, as an import adds them.
  const created = added.length ? await writeRows(database, userId, await checkRows(userId, databaseId, added, props, invalid)) : [];

  return {
    updated: writes.map((w) => w.row.id),
    created: created.map((r) => r.id),
    skippedRows,
    invalid: dropped + [...invalid.values()].reduce((sum, n) => sum + n, 0),
  };
}

/** The option names a pasted value of a select, status or multi-select names. */
function optionNames(prop: DatabaseProperty, value: unknown): string[] {
  if (typeof value === "string") return prop.type === "multi_select" ? splitList(value) : value.trim() ? [value.trim()] : [];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "") : [];
}

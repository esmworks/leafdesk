import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { databaseProperty, page, type SelectOption } from "@/db/schema";
import {
  cellValue,
  CSV_MAX_COLUMNS,
  CSV_MAX_ROWS,
  detectDateFormat,
  guessColumn,
  INVALID,
  isImportableType,
  percentColumn,
  splitList,
  type CsvColumnType,
  type CsvTable,
  type DateFormat,
} from "@/lib/import/csv";
import { ImportError, WarningList } from "@/lib/import/result";
import { PropertyValueError, sortStatusOptions, statusColor } from "@/lib/properties";
import { atLeast } from "@/lib/property-access";
import { holdsOptions } from "@/lib/property-types";
import { AccessError } from "@/server/access";
import { getCollab, type WriteActor } from "@/server/collab/bridge";
import {
  addProperty,
  getProperties,
  insertRows,
  makeOption,
  normalizeRowProperties,
  requireDatabase,
  type DatabaseProperty,
} from "@/server/databases";
import { createPage, removeOrphanFiles, type DatabaseSeedNames } from "@/server/pages";
import { propertyAccessFor, type PropertyAccess } from "@/server/property-access";

/**
 * CSV imports: a CSV file as a new database, or its rows added to an existing one.
 *
 * Every row is checked before anything is written, and a failure while writing takes back what the
 * import made (the new database, or the rows added), so an import either happens or doesn't. Cells
 * that don't fit their property (a word in a number column, a person who isn't in the workspace)
 * don't stop it: they are left empty and counted in a warning per column.
 */

/** Rows written per insert. */
const CHUNK = 500;

function checkSize(table: CsvTable) {
  if (!table.headers.length) throw new ImportError("The CSV file has no header row", "emptyCsv");
  if (table.headers.length > CSV_MAX_COLUMNS) {
    throw new ImportError(`CSV files can have at most ${CSV_MAX_COLUMNS} columns`, "tooManyColumns", { limit: CSV_MAX_COLUMNS });
  }
  if (table.rows.length > CSV_MAX_ROWS) {
    throw new ImportError(`CSV files can have at most ${CSV_MAX_ROWS} rows`, "tooManyRows", { limit: CSV_MAX_ROWS });
  }
}

const column = (table: CsvTable, i: number) => table.rows.map((r) => r[i] ?? "");

type PendingRow = { title: string; values: Record<string, unknown> };

/**
 * Cells as values of the properties their columns go to (`targets[i]`: a property, or null for
 * the title or a column left out). Cells that can't be a value are counted per property.
 */
function rowValues(
  table: CsvTable,
  titleColumn: number | null,
  targets: (DatabaseProperty | null)[],
  invalid: Map<string, number>,
): PendingRow[] {
  const formats = targets.map((p, i): DateFormat | undefined =>
    p?.type === "date" ? (detectDateFormat(column(table, i)) ?? undefined) : undefined,
  );
  return table.rows.map((row) => {
    const values: Record<string, unknown> = {};
    targets.forEach((prop, i) => {
      if (!prop) return;
      const value = cellValue(prop.type, row[i] ?? "", { dateFormat: formats[i] });
      if (value === INVALID) invalid.set(prop.id, (invalid.get(prop.id) ?? 0) + 1);
      else if (value !== null) values[prop.id] = value;
    });
    return { title: titleColumn === null ? "" : (row[titleColumn] ?? "").replace(/\s+/g, " ").trim(), values };
  });
}

/**
 * Checks each row's values the way every row write does (normalizeRowProperties: options, people,
 * relations by name). A value it refuses is dropped from the row and counted, and the row checked
 * again. Returns the stored values.
 */
async function checkRows(userId: string, databaseId: string, rows: PendingRow[], props: DatabaseProperty[], invalid: Map<string, number>) {
  const checked: { title: string; properties: Record<string, unknown> }[] = [];
  for (const row of rows) {
    const values = { ...row.values };
    for (;;) {
      try {
        checked.push({ title: row.title, properties: await normalizeRowProperties(userId, databaseId, values) });
        break;
      } catch (error) {
        if (!(error instanceof PropertyValueError)) throw error;
        const prop = props.find((p) => p.id in values && p.name === error.params.property);
        if (!prop) throw error;
        delete values[prop.id];
        invalid.set(prop.id, (invalid.get(prop.id) ?? 0) + 1);
      }
    }
  }
  return checked;
}

/**
 * Writes checked rows; if a write fails, the rows already written go again. Rows of a database in a
 * template belong to the template, like every page under one (see server/templates).
 */
async function writeRows(
  database: { id: string; workspaceId: string; inTemplate: boolean },
  userId: string,
  rows: { title: string; properties: Record<string, unknown> }[],
) {
  const created: { id: string; title: string }[] = [];
  try {
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = await insertRows(database, userId, rows.slice(i, i + CHUNK));
      created.push(...chunk);
      if (database.inTemplate) {
        await db.update(page).set({ inTemplate: true }).where(inArray(page.id, chunk.map((r) => r.id)));
      }
    }
  } catch (error) {
    if (created.length) {
      await db.delete(page).where(inArray(page.id, created.map((r) => r.id)));
      getCollab().broadcast(`db:${database.id}`, "rows");
    }
    throw error;
  }
  return created;
}

function reportInvalid(warnings: WarningList, invalid: Map<string, number>, props: DatabaseProperty[]) {
  for (const [id, count] of invalid) {
    const prop = props.find((p) => p.id === id);
    if (prop) warnings.add({ code: "invalidValues", column: prop.name, count });
  }
}

export type NewDatabaseInput = {
  workspaceId: string;
  /** The page the database goes under; null for the top level. */
  parentId: string | null;
  /** At the top level: the teamspace, null for a private database, undefined for the default teamspace. */
  teamspaceId?: string | null;
  title: string;
  table: CsvTable;
  /** The column that becomes the rows' titles; null for untitled rows. */
  titleColumn: number | null;
  /** Each column's property type, or null to leave the column out; guessed when not given. */
  types?: (CsvColumnType | null)[];
  seedNames?: DatabaseSeedNames;
  /** A workspace template (at the top level) or a row template (in a database), as createPage makes them. */
  template?: boolean;
};

/**
 * A CSV file as a new database under `parentId` (edit access needed there, as for any new page):
 * one property per column, typed as given or guessed from the values (see lib/import/csv), and one
 * row per line. Returns the database and its rows.
 */
export async function importCsvAsDatabase(actor: WriteActor, input: NewDatabaseInput, warnings = new WarningList()) {
  const { table } = input;
  checkSize(table);
  const titleColumn = input.titleColumn !== null && input.titleColumn < table.headers.length ? input.titleColumn : null;
  const types = table.headers.map((_, i): CsvColumnType | null =>
    i === titleColumn ? null : input.types ? (input.types[i] ?? null) : guessColumn(column(table, i)).type,
  );

  const database = await createPage(actor, {
    workspaceId: input.workspaceId,
    parentId: input.parentId,
    teamspaceId: input.teamspaceId,
    kind: "database",
    title: input.title,
    seedNames: input.seedNames,
    seedProperties: false,
    template: input.template,
  });
  try {
    const targets: (DatabaseProperty | null)[] = [];
    for (const [i, type] of types.entries()) {
      if (!type) {
        targets.push(null);
        continue;
      }
      const options =
        type === "select"
          ? distinct(column(table, i).map((v) => v.trim().slice(0, 200)))
          : type === "multi_select"
            ? distinct(column(table, i).flatMap((v) => splitList(v).map((o) => o.slice(0, 200))))
            : undefined;
      // A column of percentages ("15%") shows them as such; its values are the fractions.
      const number = type === "number" && percentColumn(column(table, i)) ? { format: "percent" as const } : undefined;
      targets.push(await addProperty(actor.userId, database.id, { name: table.headers[i], type, options, number }));
    }
    const props = targets.filter((p): p is DatabaseProperty => p !== null);
    const invalid = new Map<string, number>();
    const rows = await checkRows(actor.userId, database.id, rowValues(table, titleColumn, targets, invalid), props, invalid);
    const created = await writeRows(database, actor.userId, rows);
    reportInvalid(warnings, invalid, props);
    return { database, rows: created, warnings };
  } catch (error) {
    await discardDatabase(database);
    throw error;
  }
}

/** Takes back a database an import created (with any rows and files it got). */
export async function discardDatabase(database: { id: string; workspaceId: string }) {
  await db.delete(page).where(eq(page.id, database.id));
  getCollab().broadcast(`ws:${database.workspaceId}`, "tree");
  await removeOrphanFiles(database.workspaceId);
}

function distinct(values: string[]) {
  const seen = new Map<string, string>();
  for (const v of values) if (v && !seen.has(v.toLowerCase())) seen.set(v.toLowerCase(), v);
  return [...seen.values()];
}

/**
 * The properties a CSV import may fill in: ones that take typed values, and whose values the
 * importer may set in a new row (see server/property-access; checked like normalizeRowProperties
 * checks a new row). Properties they can't know of or may only read aren't offered.
 */
export function importableProperties<P extends { id: string; type: DatabaseProperty["type"] }>(properties: P[], access: PropertyAccess): P[] {
  return access
    .visible(properties)
    .filter((p) => isImportableType(p.type) && atLeast(access.levelOf(p.id, { properties: {} }), "edit_values"));
}

/** importableProperties of a database, for `userId`. */
export async function importTargets(userId: string, databaseId: string) {
  const [all, access] = await Promise.all([getProperties(databaseId), propertyAccessFor(userId, databaseId)]);
  return importableProperties(all, access);
}

/** Where a column goes when merging: the rows' titles, a property (by id), or nowhere (null). */
export type ColumnTarget = "title" | string | null;

/**
 * Adds a CSV file's rows to an existing database (edit access needed): `mapping[i]` says where
 * column i goes. Options the select, multi-select and status columns name that the property lacks
 * are added to it, as typing them into a cell would.
 */
export async function importCsvIntoDatabase(
  actor: WriteActor,
  { databaseId, table, mapping }: { databaseId: string; table: CsvTable; mapping: ColumnTarget[] },
  warnings = new WarningList(),
) {
  checkSize(table);
  const database = await requireDatabase(actor.userId, databaseId, "edit").catch((error) => {
    if (error instanceof AccessError && (error as { code?: string }).code === "notADatabase") {
      throw new ImportError("Not a database", "notADatabase");
    }
    throw error;
  });
  if (database.archivedAt) throw new ImportError("The database is in the trash", "noAccess");
  // Only properties the importer may fill in; any other id reads like one that doesn't exist.
  const props = await importTargets(actor.userId, databaseId);
  const byId = new Map(props.map((p) => [p.id, p]));

  const used = new Set<string>();
  let titleColumn: number | null = null;
  const targets = table.headers.map((_, i): DatabaseProperty | null => {
    const target = mapping[i] ?? null;
    if (target === null) return null;
    if (used.has(target)) throw new ImportError("Two columns go to the same property", "badMapping");
    used.add(target);
    if (target === "title") {
      titleColumn = i;
      return null;
    }
    const prop = byId.get(target);
    if (!prop) throw new ImportError(`Unknown or read-only property "${target}"`, "badMapping");
    return prop;
  });
  if (!used.size) throw new ImportError("No column goes to a property", "badMapping");

  // Missing options first, so the values below find them.
  for (const [i, prop] of targets.entries()) {
    if (!prop || !holdsOptions(prop.type)) continue;
    const names = column(table, i).flatMap((v) => (prop.type === "multi_select" ? splitList(v) : v.trim() ? [v.trim()] : []));
    const updated = await addMissingOptions(prop, names);
    if (updated) byId.set(prop.id, (targets[i] = updated));
  }

  const invalid = new Map<string, number>();
  const pending = rowValues(table, titleColumn, targets, invalid);
  const rows = await checkRows(actor.userId, databaseId, pending, props, invalid);
  const created = await writeRows(database, actor.userId, rows);
  reportInvalid(warnings, invalid, props);
  return { database, rows: created, warnings };
}

/**
 * Adds the options among `names` that the property lacks (compared without case), the way typing a
 * new one into a cell does (see databases.ensureOption): even on a locked database. New status
 * options start as to do. Returns the updated property, or null when nothing was missing.
 */
async function addMissingOptions(prop: DatabaseProperty, names: string[]): Promise<DatabaseProperty | null> {
  const options: SelectOption[] = [...(prop.options.options ?? [])];
  const known = new Set(options.map((o) => o.name.toLowerCase()));
  let added = false;
  for (const raw of names) {
    const name = raw.slice(0, 200);
    if (known.has(name.toLowerCase())) continue;
    known.add(name.toLowerCase());
    added = true;
    options.push(
      prop.type === "status"
        ? { ...makeOption(name), color: statusColor("todo"), group: "todo" }
        : makeOption(name, options.length),
    );
  }
  if (!added) return null;
  const next = { ...prop.options, options: prop.type === "status" ? sortStatusOptions(options) : options };
  const [updated] = await db.update(databaseProperty).set({ options: next }).where(eq(databaseProperty.id, prop.id)).returning();
  getCollab().broadcast(`db:${prop.databaseId}`, "schema");
  return { ...prop, options: updated.options };
}

import { and, asc, eq, inArray, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { connection, databaseSync, page, sheetsWrite } from "@/db/schema";
import { answerJson, answerText, type ToolAnswer } from "@/lib/import/google-docs";
import { PropertyValueError } from "@/lib/properties";
import { redactError, redactText } from "@/lib/redact";
import {
  cellRange,
  defaultHeaderRow,
  GRID_FIELDS,
  KIND_TYPES,
  MAX_HEADER_ROW,
  MAX_SHEET_CELLS,
  MAX_SHEET_WRITES,
  META_FIELDS,
  planWrites,
  readGrid,
  readMeta,
  sheetCells,
  sheetItems,
  sheetRange,
  formulaColumns,
  sheetHeaders,
  sheetsAccess,
  sheetsWriteAccess,
  SHEETS_TOOL,
  TITLE_FIELD,
  type CellInput,
  type SheetCell,
  type SheetsMapping,
  type SheetsMeta,
  type SheetsQuery,
  type SheetsSyncError,
  type SheetsWriteTool,
} from "@/lib/sheets-sync";
import { AccessError, requireMembership } from "@/server/access";
import { recordAudit } from "@/server/audit";
import { callConnectionTool, classify, type ConnectionRow } from "@/server/connections/client";
import { inputSummary } from "@/server/connections/tools";
import { getProperties } from "@/server/databases";
import { JiraError } from "@/server/jira-sync/client";
import type { SyncRow } from "@/server/jira-sync/run";
import { applyRows, type SyncedDatabase } from "@/server/synced-rows";
import { withUniqueValues } from "@/server/unique-values";
import { fromSync } from "@/server/sync-writes";

/**
 * Reading one sheet of a Google spreadsheet (lib/sheets-sync) through a workspace's Google Sheets
 * connection and writing its rows into the synced database, called by server/jira-sync/run, which
 * holds and records every synced database's runs; for a sync that writes back, writing the changes
 * waiting in `sheets_write` (server/sync-writes) to the sheet first. Each run checks again that the person it
 * runs as may read (and write) through the connection (lib/sheets-sync sheetsAccess,
 * sheetsWriteAccess), and each call to it is recorded in the audit log, as the AI chat's and
 * imports' calls are. An error is a JiraError (the runs record every source alike).
 */

/** A connection a sync reads through, with the role in its workspace of the person it's used as. */
export type SheetsConnection = ConnectionRow & { role: Awaited<ReturnType<typeof requireMembership>>["role"] };

/** The connection a sync reads through, if `userId` may read spreadsheets through it now. */
export async function sheetsConnection(userId: string, connectionId: string): Promise<SheetsConnection> {
  const [row] = connectionId ? await db.select().from(connection).where(eq(connection.id, connectionId)).limit(1) : [];
  if (!row) throw new JiraError("notFound", "The Google Sheets connection is gone");
  let role;
  try {
    ({ role } = await requireMembership(userId, row.workspaceId));
  } catch (error) {
    if (error instanceof AccessError) throw new JiraError("accessLost", error.message);
    throw error;
  }
  if (row.status === "needsAuth") throw new JiraError("unauthorized", "The connection needs signing in again");
  // A connection that failed its last check may answer again: the run tries again next time.
  if (row.status !== "ready") throw new JiraError("unreachable", "The connection is failing");
  if (!row.tools.some((t) => t.name === SHEETS_TOOL)) throw new JiraError("notFound", "The connection has no get_spreadsheet tool");
  if (!sheetsAccess(row, role)) throw new JiraError("forbidden", "The connection may not be used for this");
  return { ...row, role };
}

/**
 * Calls one of the connection's tools as `userId`, recording it in the audit log like the chat's
 * calls (a write with the people whose changes it writes). Returns the answer's JSON, if any.
 */
async function call(
  userId: string,
  row: ConnectionRow,
  args: Record<string, unknown>,
  tool: typeof SHEETS_TOOL | SheetsWriteTool = SHEETS_TOOL,
  editors: string[] = [],
): Promise<Record<string, unknown> | null> {
  const kind = tool === SHEETS_TOOL ? "read" : "write";
  const audit = (outcome: "done" | "failed", error?: string) =>
    recordAudit({
      workspaceId: row.workspaceId,
      actorId: userId,
      action: "connection.tool_called",
      target: { type: "connection", id: row.id, label: row.name },
      details: {
        tool,
        kind,
        input: inputSummary(args),
        approvedBy: null,
        outcome,
        via: "sync",
        ...(editors.length ? { editors } : {}),
        ...(error ? { error: redactText(error).slice(0, 200) } : {}),
      },
    }).catch((e) => console.error("[sheets sync] could not record a call", redactError(e)));
  let answer: ToolAnswer;
  try {
    answer = (await callConnectionTool(row, tool, args)) as ToolAnswer;
  } catch (error) {
    const failure = classify(error);
    await audit("failed", `${failure.code}: ${failure.message}`);
    if (failure.code === "unauthorized") throw new JiraError("unauthorized", "The connection needs signing in again");
    if (/too large/i.test(failure.message)) throw new JiraError("tooManyIssues", "The sheet is too big");
    throw new JiraError("unreachable", "The connection could not be reached");
  }
  if (answer.isError) {
    const said = answerText(answer).slice(0, 500);
    await audit("failed", said);
    if (/not.?found|\b404\b/i.test(said)) throw new JiraError("notFound", "No such spreadsheet");
    if (/permission|forbidden|\b403\b/i.test(said)) throw new JiraError("forbidden", `The connection's account may not ${kind} the spreadsheet`, redactText(said).slice(0, 300) || null);
    throw new JiraError("badQuery", `Google refused the ${kind}`, redactText(said).slice(0, 300) || null);
  }
  await audit("done");
  return answerJson(answer);
}

const readJson = async (userId: string, row: ConnectionRow, args: Record<string, unknown>) => {
  const json = await call(userId, row, args);
  if (!json) throw new JiraError("badQuery", "Google's answer couldn't be read");
  return json;
};

export type ReadSheet = { meta: SheetsMeta; sheet: SheetsMeta["sheets"][number]; headerRow: number; grid: SheetCell[][] };

/**
 * A sheet's cells from its header row down: the sheet with id `sheetId` (the first when null), its
 * header row `headerRow` (the sheet's own suggestion when null).
 */
export async function readSheet(userId: string, row: ConnectionRow, spreadsheetId: string, sheetId: number | null, headerRow: number | null): Promise<ReadSheet> {
  const meta = readMeta(await readJson(userId, row, { spreadsheetId, fields: META_FIELDS }));
  if (!meta) throw new JiraError("badQuery", "Google's answer couldn't be read");
  const sheet = sheetId === null ? meta.sheets[0] : meta.sheets.find((s) => s.sheetId === sheetId);
  if (!sheet) throw new JiraError("notFound", "No such sheet");
  const header = headerRow ?? defaultHeaderRow(sheet);
  if (!Number.isInteger(header) || header < 1 || header > MAX_HEADER_ROW) throw new JiraError("invalidInput", "Not a header row");
  if (sheetCells(sheet, header) > MAX_SHEET_CELLS) throw new JiraError("tooManyIssues", "The sheet has too many cells");
  const grid = readGrid(await readJson(userId, row, { spreadsheetId, ranges: [sheetRange(sheet, header)], includeGridData: true, fields: GRID_FIELDS }));
  if (!grid) throw new JiraError("badQuery", "Google's answer couldn't be read");
  return { meta, sheet, headerRow: header, grid };
}

/** The database's properties, and the mapping's that still exist with the type their column needs. */
type LiveMapping = { live: SheetsMapping; props: Awaited<ReturnType<typeof getProperties>> };

/** The mapping as the database has it now; a run without its key property can't go on ("keyGone"). */
async function liveMapping(databaseId: string, mapping: SheetsMapping): Promise<LiveMapping> {
  const props = await getProperties(databaseId);
  if (!props.some((p) => p.id === mapping.key && p.type === "text")) throw new JiraError("keyGone", "The key property is gone");
  return { live: { key: mapping.key, columns: mapping.columns.filter((c) => props.some((p) => p.id === c.property && p.type === KIND_TYPES[c.kind])) }, props };
}

/** By key, the fields of rows whose changes still wait to be written ("all" for a new row's): the sheet's values don't go over them. */
export type HeldFields = Map<string, Set<string> | "all">;

/** The changes waiting for a sync, by their rows' keys. */
async function heldFields(syncId: string, keyId: string): Promise<HeldFields> {
  const rows = await db
    .select({ before: sheetsWrite.before, created: sheetsWrite.created, properties: page.properties })
    .from(sheetsWrite)
    .innerJoin(page, eq(page.id, sheetsWrite.rowId))
    .where(eq(sheetsWrite.syncId, syncId));
  const held: HeldFields = new Map();
  for (const row of rows) {
    const key = row.properties[keyId];
    if (typeof key === "string" && key.trim()) held.set(key.trim(), row.created ? "all" : new Set(Object.keys(row.before)));
  }
  return held;
}

/**
 * Writes a sheet's rows into the database as `runAs` (who must be able to edit it), leaving the
 * `held` fields as they are. Returns how many rows it added and changed.
 */
export async function applySheetRows(
  database: SyncedDatabase,
  runAs: string,
  query: SheetsQuery,
  mapping: SheetsMapping,
  read: ReadSheet,
  held: HeldFields = new Map(),
  current?: LiveMapping,
) {
  const { live, props } = current ?? (await liveMapping(database.id, mapping));
  const items = sheetItems(read.grid, query, live, read.meta.timeZone);
  if (!items) throw new JiraError("keyGone", `The sheet has no “${query.keyColumn}” column`);
  const kept = items.map((item) => {
    const fields = held.get(item.key);
    if (!fields) return item;
    const holds = (field: string) => fields === "all" || fields.has(field);
    return { ...item, values: Object.fromEntries(Object.entries(item.values).filter(([id]) => !holds(id))), keepTitle: holds(TITLE_FIELD) };
  });
  // The run's own writes are no changes to write back (server/sync-writes).
  const written = await fromSync(() => applyRows(database, runAs, live.key, kept, props, []));
  return { count: items.length, ...written };
}

/** Why writing to the sheet failed, as the sync's dialog shows it; null once it went through. */
type WriteFailure = { code: SheetsSyncError; detail: string | null } | null;

/**
 * Gives new rows the keys their titles make (lib/sheets-sync planWrites `keyed`), before anything is
 * written: a failed write then adds them again, never twice. Returns the keys another row took
 * meanwhile (a unique key property refuses them).
 */
async function setKeys(keyId: string, keyed: { rowId: string; key: string }[]) {
  const refused: string[] = [];
  for (const { rowId, key } of keyed) {
    try {
      await withUniqueValues(() =>
        db
          .update(page)
          .set({ properties: sql`${page.properties} || ${JSON.stringify({ [keyId]: key })}::jsonb` })
          .where(eq(page.id, rowId)),
      );
    } catch (error) {
      if (!(error instanceof PropertyValueError)) throw error;
      refused.push(key);
    }
  }
  return refused;
}

/**
 * Writes the changes waiting for a sync to the sheet as just read (lib/sheets-sync planWrites), as
 * `runAs` through `row`, which must let them write. A refusal stops the writing but not the run:
 * the changes wait, and their fields keep Leafdesk's values. Returns whether it wrote, why it
 * couldn't, and whether more changes than one run writes wait.
 */
async function writeBack(syncId: string, databaseId: string, runAs: string, row: SheetsConnection, query: SheetsQuery, live: SheetsMapping, read: ReadSheet) {
  // New rows without a key (or a title that makes one) wait at the end, so they never hold up the rest.
  const keyless = sql<boolean>`${sheetsWrite.created} and coalesce(trim(${page.properties} ->> ${live.key}), '') = ''${
    query.titleColumn === query.keyColumn ? sql` and trim(${page.title}) = ''` : sql``
  }`;
  const entries = await db
    .select({ id: sheetsWrite.id, rowId: sheetsWrite.rowId, created: sheetsWrite.created, before: sheetsWrite.before, editedBy: sheetsWrite.editedBy, version: sheetsWrite.version, waits: keyless })
    .from(sheetsWrite)
    .innerJoin(page, eq(page.id, sheetsWrite.rowId))
    .where(eq(sheetsWrite.syncId, syncId))
    .orderBy(asc(keyless), asc(sheetsWrite.queuedAt))
    .limit(MAX_SHEET_WRITES);
  if (!entries.length || entries[0].waits) return { wrote: false, failure: null as WriteFailure, more: false };
  const more = entries.length === MAX_SHEET_WRITES && !entries.at(-1)!.waits;
  if (!sheetsWriteAccess(row, row.role)) return { wrote: false, failure: { code: "forbidden", detail: null } as WriteFailure, more };
  const pages = await db
    .select({ id: page.id, title: page.title, properties: page.properties, archivedAt: page.archivedAt, parentId: page.parentId })
    .from(page)
    .where(inArray(page.id, entries.map((e) => e.rowId)));
  const rows = new Map(pages.filter((p) => !p.archivedAt && p.parentId === databaseId).map((p) => [p.id, p]));
  // The keys the database's rows have (in the trash too): a new row named like one stays out of the sheet.
  const taken = new Set<string>();
  if (query.titleColumn === query.keyColumn) {
    const keys = await db
      .select({ key: sql<string>`trim(${page.properties} ->> ${live.key})` })
      .from(page)
      .where(and(eq(page.parentId, databaseId), ne(sql`coalesce(trim(${page.properties} ->> ${live.key}), '')`, "")));
    for (const { key } of keys) taken.add(key);
  }
  let plan = planWrites(read.grid, query, live, read.meta.timeZone, entries, rows, taken);
  for (let refused = await setKeys(live.key, plan.keyed); refused.length; refused = await setKeys(live.key, plan.keyed)) {
    for (const key of refused) taken.add(key);
    plan = planWrites(read.grid, query, live, read.meta.timeZone, entries, rows, taken);
  }
  const editors = [...new Set(entries.flatMap((e) => (e.editedBy ? [e.editedBy] : [])))].slice(0, 20);
  const write = (range: string, values: (CellInput | null)[][]) =>
    call(runAs, row, { spreadsheetId: query.spreadsheetId, range, values }, "update_values", editors);

  let wrote = false;
  try {
    for (const update of plan.updates) {
      await write(cellRange(read.sheet.title, update.row, update.column, update.values.length), [update.values]);
      wrote = true;
    }
    if (plan.appends.length) {
      const width = Math.max(...plan.appends.map((cells) => cells.length), sheetHeaders(read.grid[0] ?? []).at(-1)!.index + 1);
      const cells = plan.appends.map((r) => [...r, ...Array<null>(width - r.length).fill(null)]);
      // Below the last row with anything in it; a sheet without room for them gets rows at its end first.
      const end = plan.appendAt + cells.length - 1;
      if (end > read.sheet.rows) {
        await call(
          runAs,
          row,
          { spreadsheetId: query.spreadsheetId, sheetId: read.sheet.sheetId, dimension: "ROWS", startIndex: read.sheet.rows, endIndex: end, inheritFromBefore: true },
          "insert_dimension",
          editors,
        );
      }
      await write(cellRange(read.sheet.title, plan.appendAt, 0, width, cells.length), cells);
      wrote = true;
    }
  } catch (error) {
    // A sign-in that ran out stops reading too; anything else leaves the changes waiting.
    if (!(error instanceof JiraError) || error.code === "unauthorized") throw error;
    return { wrote, failure: { code: error.code, detail: error.detail } as WriteFailure, more };
  }
  // Done with: removed, unless changed again meanwhile (then its `before` is what the sheet now holds).
  const version = new Map(entries.map((e) => [e.id, e.version]));
  const removed = new Set(
    plan.done.length
      ? (
          await db
            .delete(sheetsWrite)
            .where(or(...plan.done.map((id) => and(eq(sheetsWrite.id, id), eq(sheetsWrite.version, version.get(id)!)))))
            .returning({ id: sheetsWrite.id })
        ).map((r) => r.id)
      : [],
  );
  for (const id of plan.done) {
    const settled = plan.settled[id];
    if (removed.has(id) || !settled) continue;
    await db
      .update(sheetsWrite)
      .set({ created: false, before: sql`${sheetsWrite.before} || ${JSON.stringify(settled)}::jsonb` })
      .where(eq(sheetsWrite.id, id));
  }
  return { wrote, failure: null as WriteFailure, more };
}

/** One run of a sheet sync whose database `runAs` may edit: the changes waiting written first, if it writes back. */
export async function runSheets(sync: SyncRow, database: SyncedDatabase, runAs: string) {
  const query = sync.query as SheetsQuery;
  const mapping = sync.mapping as SheetsMapping;
  const row = await sheetsConnection(runAs, query.connectionId);
  let read = await readSheet(runAs, row, query.spreadsheetId, query.sheetId, query.headerRow);
  const current = await liveMapping(database.id, mapping);
  let failure: WriteFailure = null;
  if (query.direction === "both") {
    const back = await writeBack(sync.id, database.id, runAs, row, query, current.live, read);
    failure = back.failure;
    // What was written, and what its formulas make of it, comes back with the next read.
    if (back.wrote) read = await readSheet(runAs, row, query.spreadsheetId, query.sheetId, query.headerRow);
    // More than one run writes: the next comes soon.
    if (back.more && !failure) await db.update(databaseSync).set({ nextRunAt: sql`now() + interval '20 seconds'` }).where(eq(databaseSync.id, sync.id));
  }
  const held = query.direction === "both" ? await heldFields(sync.id, mapping.key) : new Map();
  const written = await applySheetRows(database, runAs, query, mapping, read, held, current);
  const headers = sheetHeaders(read.grid[0] ?? []);
  const formulas = [...formulaColumns(read.grid)].flatMap((index) => headers.filter((h) => h.index === index).map((h) => h.name));
  // The dialog shows the sheet's name (a renamed sheet is found by its id), its formula columns and why writing failed.
  const next: SheetsQuery = {
    ...query,
    sheetTitle: read.sheet.title,
    formulaColumns: formulas,
    writeError: failure?.code ?? null,
    writeErrorDetail: failure?.detail ?? null,
  };
  const was = { ...query, formulaColumns: query.formulaColumns ?? [], writeError: query.writeError ?? null, writeErrorDetail: query.writeErrorDetail ?? null };
  if (JSON.stringify(next) !== JSON.stringify(was)) {
    // Only these keys: a change of the sync made meanwhile (its direction, connection) stays.
    await db
      .update(databaseSync)
      .set({ query: sql`${databaseSync.query} || ${JSON.stringify({ sheetTitle: next.sheetTitle, formulaColumns: formulas, writeError: next.writeError, writeErrorDetail: next.writeErrorDetail })}::jsonb` })
      .where(eq(databaseSync.id, sync.id));
  }
  return written;
}

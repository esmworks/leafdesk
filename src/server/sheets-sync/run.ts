import { eq } from "drizzle-orm";
import { db } from "@/db";
import { connection, databaseSync } from "@/db/schema";
import { answerJson, answerText, type ToolAnswer } from "@/lib/import/google-docs";
import { redactError, redactText } from "@/lib/redact";
import {
  defaultHeaderRow,
  GRID_FIELDS,
  KIND_TYPES,
  MAX_HEADER_ROW,
  MAX_SHEET_CELLS,
  META_FIELDS,
  readGrid,
  readMeta,
  sheetCells,
  sheetItems,
  sheetRange,
  sheetsAccess,
  SHEETS_TOOL,
  type SheetCell,
  type SheetsMapping,
  type SheetsMeta,
  type SheetsQuery,
} from "@/lib/sheets-sync";
import { AccessError, requireMembership } from "@/server/access";
import { recordAudit } from "@/server/audit";
import { callConnectionTool, classify, type ConnectionRow } from "@/server/connections/client";
import { inputSummary } from "@/server/connections/tools";
import { getProperties } from "@/server/databases";
import { JiraError } from "@/server/jira-sync/client";
import type { SyncRow } from "@/server/jira-sync/run";
import { applyRows, type SyncedDatabase } from "@/server/synced-rows";

/**
 * Reading one sheet of a Google spreadsheet (lib/sheets-sync) through a workspace's Google Sheets
 * connection and writing its rows into the synced database, called by server/jira-sync/run, which
 * holds and records every synced database's runs. Each run checks again that the person it runs
 * as may read through the connection (lib/sheets-sync sheetsAccess), and each call to it is
 * recorded in the audit log, as the AI chat's and imports' calls are. An error is a JiraError (the
 * runs record every source alike).
 */

/** The connection a sync reads through, if `userId` may read spreadsheets through it now. */
export async function sheetsConnection(userId: string, connectionId: string): Promise<ConnectionRow> {
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
  return row;
}

/** Calls the connection's tool as `userId`, recording it in the audit log like the chat's calls. */
async function call(userId: string, row: ConnectionRow, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const audit = (outcome: "done" | "failed", error?: string) =>
    recordAudit({
      workspaceId: row.workspaceId,
      actorId: userId,
      action: "connection.tool_called",
      target: { type: "connection", id: row.id, label: row.name },
      details: { tool: SHEETS_TOOL, kind: "read", input: inputSummary(args), approvedBy: null, outcome, via: "sync", ...(error ? { error: redactText(error).slice(0, 200) } : {}) },
    }).catch((e) => console.error("[sheets sync] could not record a call", redactError(e)));
  let answer: ToolAnswer;
  try {
    answer = (await callConnectionTool(row, SHEETS_TOOL, args)) as ToolAnswer;
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
    if (/permission|forbidden|\b403\b/i.test(said)) throw new JiraError("forbidden", "The connection's account may not open the spreadsheet");
    throw new JiraError("badQuery", "Google refused the read", redactText(said).slice(0, 300) || null);
  }
  await audit("done");
  const json = answerJson(answer);
  if (!json) throw new JiraError("badQuery", "Google's answer couldn't be read");
  return json;
}

export type ReadSheet = { meta: SheetsMeta; sheet: SheetsMeta["sheets"][number]; headerRow: number; grid: SheetCell[][] };

/**
 * A sheet's cells from its header row down: the sheet with id `sheetId` (the first when null), its
 * header row `headerRow` (the sheet's own suggestion when null).
 */
export async function readSheet(userId: string, row: ConnectionRow, spreadsheetId: string, sheetId: number | null, headerRow: number | null): Promise<ReadSheet> {
  const meta = readMeta(await call(userId, row, { spreadsheetId, fields: META_FIELDS }));
  if (!meta) throw new JiraError("badQuery", "Google's answer couldn't be read");
  const sheet = sheetId === null ? meta.sheets[0] : meta.sheets.find((s) => s.sheetId === sheetId);
  if (!sheet) throw new JiraError("notFound", "No such sheet");
  const header = headerRow ?? defaultHeaderRow(sheet);
  if (!Number.isInteger(header) || header < 1 || header > MAX_HEADER_ROW) throw new JiraError("invalidInput", "Not a header row");
  if (sheetCells(sheet, header) > MAX_SHEET_CELLS) throw new JiraError("tooManyIssues", "The sheet has too many cells");
  const grid = readGrid(await call(userId, row, { spreadsheetId, ranges: [sheetRange(sheet, header)], includeGridData: true, fields: GRID_FIELDS }));
  if (!grid) throw new JiraError("badQuery", "Google's answer couldn't be read");
  return { meta, sheet, headerRow: header, grid };
}

/**
 * The mapping's properties that still exist with the type their column needs; a run without its
 * key property can't go on ("keyGone").
 */
async function liveMapping(databaseId: string, mapping: SheetsMapping): Promise<SheetsMapping> {
  const props = await getProperties(databaseId);
  if (!props.some((p) => p.id === mapping.key && p.type === "text")) throw new JiraError("keyGone", "The key property is gone");
  return { key: mapping.key, columns: mapping.columns.filter((c) => props.some((p) => p.id === c.property && p.type === KIND_TYPES[c.kind])) };
}

/** Writes a sheet's rows into the database as `runAs` (who must be able to edit it). Returns how many rows it added and changed. */
export async function applySheetRows(database: SyncedDatabase, runAs: string, query: SheetsQuery, mapping: SheetsMapping, read: ReadSheet) {
  const live = await liveMapping(database.id, mapping);
  const items = sheetItems(read.grid, query, live, read.meta.timeZone);
  if (!items) throw new JiraError("keyGone", `The sheet has no “${query.keyColumn}” column`);
  const written = await applyRows(database, runAs, live.key, items, await getProperties(database.id), []);
  return { count: items.length, ...written };
}

/** One run of a sheet sync whose database `runAs` may edit. */
export async function runSheets(sync: SyncRow, database: SyncedDatabase, runAs: string) {
  const query = sync.query as SheetsQuery;
  const row = await sheetsConnection(runAs, query.connectionId);
  const read = await readSheet(runAs, row, query.spreadsheetId, query.sheetId, query.headerRow);
  const written = await applySheetRows(database, runAs, query, sync.mapping as SheetsMapping, read);
  // A renamed sheet is found by its id; the dialog shows its new name.
  if (read.sheet.title !== query.sheetTitle) {
    await db
      .update(databaseSync)
      .set({ query: { ...query, sheetTitle: read.sheet.title } })
      .where(eq(databaseSync.id, sync.id));
  }
  return written;
}

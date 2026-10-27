import { count, eq } from "drizzle-orm";
import { db } from "@/db";
import { connection, databaseSync, databaseView, sheetsWrite } from "@/db/schema";
import type { ImportResult } from "@/lib/import/result";
import { DEFAULT_JIRA_INTERVAL, isJiraInterval } from "@/lib/jira-sync";
import {
  KIND_TYPES,
  kindOf,
  MAX_HEADER_ROW,
  MAX_SHEET_COLUMNS,
  parseSheetLink,
  sheetHeaders,
  sheetLink,
  sheetsAccess,
  sheetsWriteAccess,
  SHEETS_DIRECTIONS,
  type SheetsDirection,
  type SheetsMapping,
  type SheetsQuery,
  type SheetsSource,
  type SheetsSyncView,
} from "@/lib/sheets-sync";
import { AccessError, requireMembership, requirePageAccess } from "@/server/access";
import type { WriteActor } from "@/server/collab/bridge";
import { addProperty, requireDatabase, updateView } from "@/server/databases";
import { discardDatabase, recordImport } from "@/server/import/csv";
import { JiraError } from "@/server/jira-sync/client";
import { claimSync, runAndRecord, type SyncOutcome, type SyncRow } from "@/server/jira-sync/run";
import { createPage, requireDatabasePlace, type DatabaseSeedNames } from "@/server/pages";
import { sealJson } from "@/server/secret-box";
import { takeSyncSetup } from "@/server/sync-setup";
import { dropSheetWrites, forgetTwoWaySyncs } from "./outbox";
import { applySheetRows, readSheet, sheetsConnection, type SheetsConnection } from "./run";

/**
 * Setting up, changing and stopping Google Sheets syncs (lib/sheets-sync; runs in ./run, held and
 * recorded by server/jira-sync/run). Setting one up reads the sheet through a Google Sheets
 * connection of the database's workspace and makes a database like an import: the key column as
 * text, a property for each other named column (numbers, checkboxes, dates, times, text, by the
 * cells below the header), the title column as the rows' titles. Changing, syncing and stopping
 * need full access to the database; whoever changes a sync or syncs it by hand is who it runs as
 * from then on, and they must be allowed to read through the connection. Nothing secret is kept:
 * the connection holds the Google sign-in.
 *
 * Writing back (`direction` "both") needs the connection's write tools for whoever turns it on and
 * whoever it runs as (lib/sheets-sync sheetsWriteAccess), and a schedule: changes are written by the
 * sync's runs, which the changes bring forward (./outbox).
 */

function interval(value: unknown): number {
  if (value === undefined) return DEFAULT_JIRA_INTERVAL;
  if (!isJiraInterval(value)) throw new JiraError("invalidInput", "Not an interval a sync offers");
  return value;
}

function direction(value: unknown): SheetsDirection {
  if (value === undefined) return "read";
  if (!SHEETS_DIRECTIONS.includes(value as SheetsDirection)) throw new JiraError("invalidInput", "Not a direction");
  return value as SheetsDirection;
}

/** Writing back runs with the sync's runs: it needs a schedule. */
function requireSchedule(direction: SheetsDirection, intervalMinutes: number) {
  if (direction === "both" && intervalMinutes <= 0) throw new JiraError("invalidInput", "Writing back needs the sync to run on a schedule");
}

/** Whether `userId` may write spreadsheets through the connection. */

const mayWrite = (row: SheetsConnection) => sheetsWriteAccess(row, row.role);

const header = (value: unknown) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");

/** The connections the person may sync spreadsheets through, in the order they were added. */
export async function sheetsSources(userId: string, workspaceId: string): Promise<SheetsSource[]> {
  const { role } = await requireMembership(userId, workspaceId);
  const rows = await db.select().from(connection).where(eq(connection.workspaceId, workspaceId)).orderBy(connection.createdAt);
  return rows.flatMap((row) => (sheetsAccess(row, role) ? [{ id: row.id, name: row.name, canWrite: sheetsWriteAccess(row, role) }] : []));
}

/** The connection, if the person may sync through it into `workspaceId`. */
async function usableConnection(userId: string, connectionId: unknown, workspaceId: string) {
  if (typeof connectionId !== "string" || !connectionId) throw new JiraError("invalidInput", "Choose a connection");
  const row = await sheetsConnection(userId, connectionId);
  // A connection's spreadsheets stay in its workspace.
  if (row.workspaceId !== workspaceId) throw new JiraError("forbidden", "That connection is in another workspace");
  return row;
}

export type SheetsSyncInput = {
  workspaceId: string;
  /** The page the database goes under; null for the top level. */
  parentId: string | null;
  /** At the top level: the teamspace, null for a private database, undefined for the default teamspace. */
  teamspaceId?: string | null;
  title?: string;
  connectionId: unknown;
  /** A link to the sheet (or the spreadsheet's id: its first sheet). */
  link: unknown;
  /** The row of column names, from 1; the sheet's last frozen row (else the first) when left out. */
  headerRow?: unknown;
  /** The column that finds each row again; the first named column when left out. */
  keyColumn?: unknown;
  /** The column that names each row; the key column when left out. */
  titleColumn?: unknown;
  intervalMinutes?: unknown;
  /** "both" to write changes made in Leafdesk back to the sheet; "read" when left out. */
  direction?: unknown;
  seedNames?: DatabaseSeedNames;
};

/**
 * Makes a database from a sheet's rows and keeps it in step from then on. The sheet is read before
 * anything is made; a failure after that takes the database back.
 */
export async function createSheetsSync(actor: WriteActor, input: SheetsSyncInput): Promise<ImportResult> {
  const { userId } = actor;
  const target = parseSheetLink(input.link);
  if (!target) throw new JiraError("invalidInput", "Not a link to a Google spreadsheet");
  const every = interval(input.intervalMinutes);
  const way = direction(input.direction);
  requireSchedule(way, every);
  const headerRow = input.headerRow === undefined || input.headerRow === null || input.headerRow === "" ? null : Number(input.headerRow);
  if (headerRow !== null && (!Number.isInteger(headerRow) || headerRow < 1 || headerRow > MAX_HEADER_ROW)) throw new JiraError("invalidInput", "Not a header row");
  const asked = { key: header(input.keyColumn), title: header(input.titleColumn) };

  await requireDatabasePlace(userId, input);
  const workspaceId = input.parentId ? (await requirePageAccess(userId, input.parentId, "edit")).workspaceId : input.workspaceId;
  takeSyncSetup(userId);
  const row = await usableConnection(userId, input.connectionId, workspaceId);
  if (way === "both" && !mayWrite(row)) throw new JiraError("forbidden", "The connection may not be used to write");
  const read = await readSheet(userId, row, target.spreadsheetId, target.sheetId, headerRow);
  const headers = sheetHeaders(read.grid[0] ?? []);
  const has = (name: string) => headers.some((h) => h.name === name);
  const keyColumn = asked.key || headers[0]?.name;
  if (!keyColumn || !has(keyColumn)) throw new JiraError("invalidInput", "No such key column (check the header row)");
  const titleColumn = asked.title || keyColumn;
  if (!has(titleColumn)) throw new JiraError("invalidInput", "No such title column");
  const query: SheetsQuery = {
    connectionId: row.id,
    spreadsheetId: target.spreadsheetId,
    sheetId: read.sheet.sheetId,
    sheetTitle: read.sheet.title,
    headerRow: read.headerRow,
    keyColumn,
    titleColumn,
    direction: way,
  };
  const below = read.grid.slice(1);
  const columns = headers
    .filter((h) => h.name !== keyColumn && h.name !== titleColumn)
    .slice(0, MAX_SHEET_COLUMNS)
    .map((h) => ({ name: h.name, kind: kindOf(below.map((cells) => cells[h.index])) }));

  const database = await createPage(
    actor,
    {
      workspaceId: input.workspaceId,
      parentId: input.parentId,
      teamspaceId: input.teamspaceId,
      kind: "database",
      title: (input.title?.trim() || read.sheet.title || read.meta.title).slice(0, 200),
      seedNames: input.seedNames,
      seedProperties: false,
    },
    { audit: false },
  );
  try {
    const key = (await addProperty(userId, database.id, { name: keyColumn, type: "text" })).id;
    const mapping: SheetsMapping = { key, columns: [] };
    for (const column of columns) {
      const prop = await addProperty(userId, database.id, { name: column.name, type: KIND_TYPES[column.kind] });
      mapping.columns.push({ column: column.name, property: prop.id, kind: column.kind });
    }
    // A key that also names the rows would show twice: the table shows it as the title only.
    if (titleColumn === keyColumn) {
      for (const shown of await db.select({ id: databaseView.id, config: databaseView.config }).from(databaseView).where(eq(databaseView.databaseId, database.id))) {
        await updateView(userId, shown.id, { config: { ...shown.config, hidden: [...(shown.config.hidden ?? []), key] } });
      }
    }
    const written = await applySheetRows(database, userId, query, mapping, read);
    const now = new Date();
    await db.insert(databaseSync).values({
      workspaceId: database.workspaceId,
      databaseId: database.id,
      source: "sheets",
      siteUrl: sheetLink(query.spreadsheetId, query.sheetId),
      query,
      mapping,
      secrets: sealJson({}),
      intervalMinutes: every,
      nextRunAt: every > 0 ? new Date(now.getTime() + every * 60_000) : null,
      lastRunAt: now,
      lastCount: written.count,
      runAs: userId,
      createdBy: userId,
    });
    forgetTwoWaySyncs();
    const result: ImportResult = {
      pages: [{ id: database.id, title: database.title, kind: "database" }],
      created: { pages: 0, databases: 1, rows: written.created, templates: 0, files: 0 },
      warnings: [],
      moreWarnings: 0,
    };
    await recordImport(userId, database.workspaceId, result, "google-sheets");
    return result;
  } catch (error) {
    await discardDatabase(database);
    throw error;
  }
}

/** A sheet sync: its query and mapping are a sheet's. */
type SheetsSyncRow = SyncRow & { source: "sheets"; query: SheetsQuery; mapping: SheetsMapping };

/** The database's sheet sync; null when it has none, or one from elsewhere. */
async function syncOf(databaseId: string): Promise<SheetsSyncRow | null> {
  const [row] = await db.select().from(databaseSync).where(eq(databaseSync.databaseId, databaseId));
  return row?.source === "sheets" ? (row as SheetsSyncRow) : null;
}

async function canManage(userId: string, databaseId: string) {
  try {
    await requireDatabase(userId, databaseId, "full");
    return true;
  } catch (error) {
    if (error instanceof AccessError) return false;
    throw error;
  }
}

/** `viewer`: who may manage it, to list the connections they may switch to; null for others. */
async function view(row: SheetsSyncRow, viewer: string | null, now = new Date()): Promise<SheetsSyncView> {
  const manage = viewer !== null;
  const [through] = await db.select().from(connection).where(eq(connection.id, row.query.connectionId)).limit(1);
  const [waiting] = await db.select({ n: count() }).from(sheetsWrite).where(eq(sheetsWrite.syncId, row.id));
  const choices = viewer ? await sheetsSources(viewer, row.workspaceId) : [];
  return {
    spreadsheetId: row.query.spreadsheetId,
    sheetId: row.query.sheetId,
    sheetTitle: row.query.sheetTitle,
    connectionId: row.query.connectionId,
    connection: through?.name ?? null,
    choices,
    headerRow: row.query.headerRow,
    keyColumn: row.query.keyColumn,
    titleColumn: row.query.titleColumn,
    intervalMinutes: row.intervalMinutes,
    enabled: row.enabled,
    running: Boolean(row.runningUntil && row.runningUntil > now),
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    lastCount: row.lastCount,
    lastError: row.lastError,
    // Google's own words about a refused read, for those who may change the sync.
    lastErrorDetail: manage ? row.lastErrorDetail : null,
    canManage: manage,
    direction: row.query.direction ?? "read",
    canWrite: choices.some((c) => c.id === through?.id && c.canWrite),
    writeError: row.query.writeError ?? null,
    writeErrorDetail: manage ? (row.query.writeErrorDetail ?? null) : null,
    formulaColumns: row.query.formulaColumns ?? [],
    pendingWrites: waiting?.n ?? 0,
  };
}

/** A database's sheet sync, for anyone who can see the database; null when it has none. */
export async function getSheetsSync(userId: string, databaseId: string): Promise<SheetsSyncView | null> {
  await requireDatabase(userId, databaseId, "view");
  const row = await syncOf(databaseId);
  return row ? view(row, (await canManage(userId, databaseId)) ? userId : null) : null;
}

async function requireSync(userId: string, databaseId: string) {
  await requireDatabase(userId, databaseId, "full");
  const row = await syncOf(databaseId);
  if (!row) throw new AccessError("This database isn't synced from Google Sheets");
  return row;
}

/**
 * Runs a sync now, as the person asking from now on. Needs full access to the database, and, while
 * it writes back, leave to write through the connection.
 */
export async function syncSheetsNow(userId: string, databaseId: string): Promise<SheetsSyncView & { outcome: SyncOutcome }> {
  const row = await requireSync(userId, databaseId);
  if (row.query.direction === "both" && !mayWrite(await sheetsConnection(userId, row.query.connectionId))) {
    throw new JiraError("forbidden", "The connection may not be used to write");
  }
  await db.update(databaseSync).set({ runAs: userId, enabled: true }).where(eq(databaseSync.id, row.id));
  const held = await claimSync(row.id);
  if (!held) throw new JiraError("alreadyRunning", "The sync is running");
  const outcome = await runAndRecord(held);
  return { ...(await view((await syncOf(databaseId))!, userId)), outcome };
}

/** `connectionId`: another connection to read through (one added again after the first was removed), checked by reading the sheet. */
export type SheetsSyncPatch = { intervalMinutes?: unknown; connectionId?: unknown; direction?: unknown };

/**
 * Changes a sync: how often it runs, the connection it reads through (the sheet stays), or whether
 * it writes back. It runs as the person changing it from then on (who must be allowed to write
 * through the connection while it writes back), and is on again if it was paused. A new connection
 * syncs at once. Stopping writing back drops the changes waiting: the next run reads them over.
 */
export async function updateSheetsSync(userId: string, databaseId: string, patch: SheetsSyncPatch) {
  const row = await requireSync(userId, databaseId);
  const changes: Partial<typeof databaseSync.$inferInsert> = { runAs: userId, enabled: true };
  if (patch.intervalMinutes !== undefined) {
    changes.intervalMinutes = interval(patch.intervalMinutes);
    changes.nextRunAt = changes.intervalMinutes > 0 ? new Date(Date.now() + changes.intervalMinutes * 60_000) : null;
  }
  const way = patch.direction === undefined ? (row.query.direction ?? "read") : direction(patch.direction);
  requireSchedule(way, changes.intervalMinutes ?? row.intervalMinutes);
  let through = null;
  if (patch.connectionId !== undefined && patch.connectionId !== row.query.connectionId) {
    takeSyncSetup(userId);
    through = await usableConnection(userId, patch.connectionId, row.workspaceId);
    await readSheet(userId, through, row.query.spreadsheetId, row.query.sheetId, row.query.headerRow);
    changes.query = { ...row.query, connectionId: through.id };
  }
  if (way === "both") {
    // Whoever it runs as from now on writes through it.
    through ??= await sheetsConnection(userId, row.query.connectionId);
    if (!mayWrite(through)) throw new JiraError("forbidden", "The connection may not be used to write");
  }
  if (way !== (row.query.direction ?? "read")) {
    const query: SheetsQuery = { ...((changes.query as SheetsQuery | undefined) ?? row.query), direction: way, writeError: null, writeErrorDetail: null };
    changes.query = query;
  }
  await db.update(databaseSync).set(changes).where(eq(databaseSync.id, row.id));
  forgetTwoWaySyncs();
  if (way === "read") await dropSheetWrites(row.id);
  if (through && through.id !== row.query.connectionId) return syncSheetsNow(userId, databaseId);
  return { ...(await view((await syncOf(databaseId))!, userId)), outcome: null };
}

/** Stops syncing: the database and its rows stay as they are. */
export async function stopSheetsSync(userId: string, databaseId: string) {
  const row = await requireSync(userId, databaseId);
  await db.delete(databaseSync).where(eq(databaseSync.id, row.id));
  forgetTwoWaySyncs();
}

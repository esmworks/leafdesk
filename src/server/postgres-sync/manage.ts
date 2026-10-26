import { eq } from "drizzle-orm";
import { db } from "@/db";
import { databaseSync } from "@/db/schema";
import type { ImportResult } from "@/lib/import/result";
import { DEFAULT_JIRA_INTERVAL, isJiraInterval } from "@/lib/jira-sync";
import {
  columnName,
  KIND_TYPES,
  MAX_POSTGRES_COLUMNS,
  parsePostgresUrl,
  parseTableName,
  postgresSite,
  type PostgresMapping,
  type PostgresQuery,
  type PostgresSyncView,
} from "@/lib/postgres-sync";
import { AccessError } from "@/server/access";
import type { WriteActor } from "@/server/collab/bridge";
import { addProperty, requireDatabase } from "@/server/databases";
import { discardDatabase, recordImport } from "@/server/import/csv";
import { claimSync, runAndRecord, type SyncOutcome, type SyncRow } from "@/server/jira-sync/run";
import { createPage, requireDatabasePlace, type DatabaseSeedNames } from "@/server/pages";
import { sealJson } from "@/server/secret-box";
import { takeSyncSetup } from "@/server/sync-setup";
import { describeTable, PostgresSyncError, readTable, withPostgres } from "./client";
import { applyTableRows, readSyncedTable, type PostgresAuth } from "./run";

/**
 * Setting up, changing and stopping PostgreSQL table syncs (lib/postgres-sync; runs in ./run, held
 * and recorded by server/jira-sync/run). Setting one up reads the table's columns and makes a
 * database like an import: the key column as text, a property for each other column it reads
 * (numbers, checkboxes, dates, text), the title column as the rows' titles. Changing, syncing and
 * stopping need full access to the database; whoever changes a sync or syncs it by hand is who it
 * runs as from then on. The connection address, with its password, is kept sealed and never shown.
 */

function urlOf(value: unknown): string {
  if (typeof value !== "string" || !parsePostgresUrl(value)) throw new PostgresSyncError("invalidInput", "Not a PostgreSQL address");
  return value.trim();
}

function interval(value: unknown): number {
  if (value === undefined) return DEFAULT_JIRA_INTERVAL;
  if (!isJiraInterval(value)) throw new PostgresSyncError("invalidInput", "Not an interval a sync offers");
  return value;
}

export type PostgresSyncInput = {
  workspaceId: string;
  /** The page the database goes under; null for the top level. */
  parentId: string | null;
  /** At the top level: the teamspace, null for a private database, undefined for the default teamspace. */
  teamspaceId?: string | null;
  title?: string;
  url: unknown;
  /** "table" or "schema.table". */
  table: unknown;
  /** The column that finds each row again; the table's primary key when left out. */
  keyColumn?: unknown;
  /** The column that names each row; the first text column besides the key when left out. */
  titleColumn?: unknown;
  intervalMinutes?: unknown;
  seedNames?: DatabaseSeedNames;
};

/**
 * Makes a database from a table's rows and keeps it in step from then on. The table is read
 * before anything is made; a failure after that takes the database back.
 */
export async function createPostgresSync(actor: WriteActor, input: PostgresSyncInput): Promise<ImportResult> {
  const { userId } = actor;
  const url = urlOf(input.url);
  const name = parseTableName(input.table);
  if (!name) throw new PostgresSyncError("invalidInput", "Name a table as table or schema.table");
  const every = interval(input.intervalMinutes);
  const asked = {
    key: input.keyColumn === undefined || input.keyColumn === "" ? null : columnName(input.keyColumn),
    title: input.titleColumn === undefined || input.titleColumn === "" ? null : columnName(input.titleColumn),
  };
  if ((input.keyColumn && !asked.key) || (input.titleColumn && !asked.title)) throw new PostgresSyncError("invalidInput", "Not a column name");

  await requireDatabasePlace(userId, input);
  takeSyncSetup(userId);
  const { query, columns, rows } = await withPostgres(url, async (sql) => {
    const table = await describeTable(sql, name.schema, name.table);
    const has = (column: string | null) => column !== null && table.columns.some((c) => c.name === column);
    const keyColumn = asked.key ?? table.primaryKey;
    if (!keyColumn || !has(keyColumn)) throw new PostgresSyncError("invalidInput", "Name the column that finds each row (the table has no one-column primary key)");
    const titleColumn = asked.title ?? table.columns.find((c) => c.kind === "text" && c.name !== keyColumn)?.name ?? keyColumn;
    if (!has(titleColumn)) throw new PostgresSyncError("invalidInput", "No such title column");
    const query: PostgresQuery = { schema: name.schema, table: name.table, keyColumn, titleColumn };
    const columns = table.columns
      .filter((c) => c.kind !== null && c.name !== keyColumn && c.name !== titleColumn)
      .slice(0, MAX_POSTGRES_COLUMNS) as { name: string; kind: NonNullable<(typeof table.columns)[number]["kind"]> }[];
    const rows = await readTable(sql, query.schema, query.table, keyColumn, [titleColumn, ...columns.map((c) => c.name)]);
    return { query, columns, rows };
  });

  const database = await createPage(
    actor,
    {
      workspaceId: input.workspaceId,
      parentId: input.parentId,
      teamspaceId: input.teamspaceId,
      kind: "database",
      title: (input.title?.trim() || query.table).slice(0, 200),
      seedNames: input.seedNames,
      seedProperties: false,
    },
    { audit: false },
  );
  try {
    const key = (await addProperty(userId, database.id, { name: query.keyColumn, type: "text" })).id;
    const mapping: PostgresMapping = { key, columns: [] };
    for (const column of columns) {
      const prop = await addProperty(userId, database.id, { name: column.name, type: KIND_TYPES[column.kind] });
      mapping.columns.push({ column: column.name, property: prop.id, kind: column.kind });
    }
    const written = await applyTableRows(database, userId, query, mapping, rows);
    const now = new Date();
    await db.insert(databaseSync).values({
      workspaceId: database.workspaceId,
      databaseId: database.id,
      source: "postgres",
      siteUrl: postgresSite(parsePostgresUrl(url)!),
      query,
      mapping,
      secrets: sealJson({ url } satisfies PostgresAuth),
      intervalMinutes: every,
      nextRunAt: every > 0 ? new Date(now.getTime() + every * 60_000) : null,
      lastRunAt: now,
      lastCount: rows.length,
      runAs: userId,
      createdBy: userId,
    });
    const result: ImportResult = {
      pages: [{ id: database.id, title: database.title, kind: "database" }],
      created: { pages: 0, databases: 1, rows: written.created, templates: 0, files: 0 },
      warnings: [],
      moreWarnings: 0,
    };
    await recordImport(userId, database.workspaceId, result, "postgres");
    return result;
  } catch (error) {
    await discardDatabase(database);
    throw error;
  }
}

/** A table sync: its query and mapping are a table's. */
type PostgresSyncRow = SyncRow & { source: "postgres"; query: PostgresQuery; mapping: PostgresMapping };

/** The database's table sync; null when it has none, or one from elsewhere. */
async function syncOf(databaseId: string): Promise<PostgresSyncRow | null> {
  const [row] = await db.select().from(databaseSync).where(eq(databaseSync.databaseId, databaseId));
  return row?.source === "postgres" ? (row as PostgresSyncRow) : null;
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

function view(row: PostgresSyncRow, manage: boolean, now = new Date()): PostgresSyncView {
  const site = parsePostgresUrl(row.siteUrl.replace(/^postgres:\/\//, "postgres://_@"));
  return {
    host: site ? `${site.host}:${site.port}` : row.siteUrl,
    database: site?.database ?? "",
    table: row.query.schema === "public" ? row.query.table : `${row.query.schema}.${row.query.table}`,
    keyColumn: row.query.keyColumn,
    titleColumn: row.query.titleColumn,
    intervalMinutes: row.intervalMinutes,
    enabled: row.enabled,
    running: Boolean(row.runningUntil && row.runningUntil > now),
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    lastCount: row.lastCount,
    lastError: row.lastError,
    // The server's own words about a refused query, for those who may change the sync.
    lastErrorDetail: manage ? row.lastErrorDetail : null,
    canManage: manage,
  };
}

/** A database's table sync, for anyone who can see the database; null when it has none. */
export async function getPostgresSync(userId: string, databaseId: string): Promise<PostgresSyncView | null> {
  await requireDatabase(userId, databaseId, "view");
  const row = await syncOf(databaseId);
  return row ? view(row, await canManage(userId, databaseId)) : null;
}

async function requireSync(userId: string, databaseId: string) {
  await requireDatabase(userId, databaseId, "full");
  const row = await syncOf(databaseId);
  if (!row) throw new AccessError("This database isn't synced from PostgreSQL");
  return row;
}

/** Runs a sync now, as the person asking from now on. Needs full access to the database. */
export async function syncPostgresNow(userId: string, databaseId: string): Promise<PostgresSyncView & { outcome: SyncOutcome }> {
  const row = await requireSync(userId, databaseId);
  await db.update(databaseSync).set({ runAs: userId, enabled: true }).where(eq(databaseSync.id, row.id));
  const held = await claimSync(row.id);
  if (!held) throw new PostgresSyncError("alreadyRunning", "The sync is running");
  const outcome = await runAndRecord(held);
  return { ...view((await syncOf(databaseId))!, true), outcome };
}

/** `url`: a new connection address (a new password), checked by reading the table first. */
export type PostgresSyncPatch = { intervalMinutes?: unknown; url?: unknown };

/**
 * Changes a sync: how often it runs, or the connection address (the table stays). It runs as the
 * person changing it from then on, and is on again if it was paused. A new address syncs at once.
 */
export async function updatePostgresSync(userId: string, databaseId: string, patch: PostgresSyncPatch) {
  const row = await requireSync(userId, databaseId);
  const changes: Partial<typeof databaseSync.$inferInsert> = { runAs: userId, enabled: true };
  if (patch.intervalMinutes !== undefined) {
    changes.intervalMinutes = interval(patch.intervalMinutes);
    changes.nextRunAt = changes.intervalMinutes > 0 ? new Date(Date.now() + changes.intervalMinutes * 60_000) : null;
  }
  if (patch.url !== undefined) {
    const url = urlOf(patch.url);
    await readSyncedTable(url, row.query, row.mapping);
    changes.secrets = sealJson({ url } satisfies PostgresAuth);
    changes.siteUrl = postgresSite(parsePostgresUrl(url)!);
  }
  await db.update(databaseSync).set(changes).where(eq(databaseSync.id, row.id));
  if (changes.secrets) return syncPostgresNow(userId, databaseId);
  return { ...view((await syncOf(databaseId))!, true), outcome: null };
}

/** Stops syncing: the database and its rows stay as they are, and the connection address is forgotten. */
export async function stopPostgresSync(userId: string, databaseId: string) {
  const row = await requireSync(userId, databaseId);
  await db.delete(databaseSync).where(eq(databaseSync.id, row.id));
}

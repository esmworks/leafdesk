import { CutText, KIND_TYPES, keyText, postgresValues, type PostgresMapping, type PostgresQuery } from "@/lib/postgres-sync";
import { getProperties } from "@/server/databases";
import type { SyncRow } from "@/server/jira-sync/run";
import { openJson } from "@/server/secret-box";
import { applyRows, type SyncedDatabase } from "@/server/synced-rows";
import { PostgresSyncError, readTable, withPostgres } from "./client";

/**
 * A run of a PostgreSQL table sync (lib/postgres-sync), called by server/jira-sync/run, which holds
 * and records every synced database's runs: the table's rows are read and written into the
 * database, the key column finding each row again and the title column naming it.
 */

/** Sealed with the sync: the connection address, user and password in it. */
export type PostgresAuth = { url: string };

/**
 * The mapping's properties that still exist with the type their column needs; a run without its
 * key property can't go on ("keyGone").
 */
async function liveMapping(databaseId: string, mapping: PostgresMapping): Promise<PostgresMapping> {
  const props = await getProperties(databaseId);
  if (!props.some((p) => p.id === mapping.key && p.type === "text")) throw new PostgresSyncError("keyGone", "The key property is gone");
  return { key: mapping.key, columns: mapping.columns.filter((c) => props.some((p) => p.id === c.property && p.type === KIND_TYPES[c.kind])) };
}

/** Writes table rows into the database as `runAs` (who must be able to edit it). Returns how many rows it added and changed. */
export async function applyTableRows(database: SyncedDatabase, runAs: string, query: PostgresQuery, mapping: PostgresMapping, rows: Record<string, unknown>[]) {
  const live = await liveMapping(database.id, mapping);
  const items = rows.flatMap((row) => {
    const key = keyText(row[query.keyColumn]);
    // A key too long to read whole can't find its row again.
    if (!key || row[query.keyColumn] instanceof CutText) return [];
    return [{ key, title: keyText(row[query.titleColumn]).slice(0, 2000) || key, values: postgresValues(row, query, live) }];
  });
  return applyRows(database, runAs, live.key, items, await getProperties(database.id), []);
}

/** The rows a sync reads, the columns it still writes only. */
export function readSyncedTable(url: string, query: PostgresQuery, mapping: PostgresMapping) {
  return withPostgres(url, (sql) =>
    readTable(sql, query.schema, query.table, query.keyColumn, [query.titleColumn, ...mapping.columns.map((c) => c.column)]),
  );
}

/** One run of a table sync whose database `runAs` may edit. */
export async function runPostgres(sync: SyncRow, database: SyncedDatabase, runAs: string) {
  const { url } = openJson<PostgresAuth>(sync.secrets);
  const query = sync.query as PostgresQuery;
  const mapping = await liveMapping(database.id, sync.mapping as PostgresMapping);
  const rows = await readSyncedTable(url, query, mapping);
  const written = await applyTableRows(database, runAs, query, mapping, rows);
  return { count: rows.length, ...written };
}

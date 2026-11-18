import { eq } from "drizzle-orm";
import { db } from "@/db";
import { databaseSync } from "@/db/schema";
import {
  flatMapping,
  parseSalesforceQuery,
  salesforceOptionsNeeded,
  salesforceTypes,
  salesforceValues,
  type SalesforceMapping,
  type SalesforceObject,
  type SalesforceQuery,
  type SalesforceRow,
} from "@/lib/salesforce-sync";
import { getCollab } from "@/server/collab/bridge";
import { getProperties } from "@/server/databases";
import { matcher } from "@/server/import/board";
import { JiraError } from "@/server/jira-sync/client";
import type { SyncRow } from "@/server/jira-sync/run";
import { openJson } from "@/server/secret-box";
import { addOptions, applyRows, liveFields, type SyncedDatabase } from "@/server/synced-rows";
import { fetchRecords, type SalesforceAuth } from "./client";

/**
 * A run of a Salesforce sync (lib/salesforce-sync), called by server/jira-sync/run, which holds and
 * records every synced database's runs. An owner is found by email address in the workspace where
 * the object has one to give (users), else by name; anyone else's name goes in the text beside.
 */

/** Writes records into the database as `runAs` (who must be able to edit it). Returns how many rows it added and changed. */
export async function applyRecords(
  database: SyncedDatabase,
  runAs: string,
  siteUrl: string,
  object: SalesforceObject,
  mapping: SalesforceMapping,
  rows: SalesforceRow[],
) {
  const before = await getProperties(database.id);
  const flat = flatMapping(mapping);
  const live = liveFields<string>(flat, salesforceTypes(object), "id", before);
  const needed = salesforceOptionsNeeded(object, rows);
  let added = false;
  for (const [key, options] of Object.entries(needed)) {
    if (await addOptions(before.find((p) => p.id === live[key]), options)) added = true;
  }
  if (added) getCollab().broadcast(`db:${database.id}`, "schema");
  const props = added ? await getProperties(database.id) : before;

  const match = await matcher(runAs, database.workspaceId);
  const person = (owner: { name: string; email: string | null }) => match(owner) ?? null;
  // The owner of new rows goes in afterwards, unannounced.
  const deferred = live.owner ? [live.owner] : [];
  const items = rows.map((row) => ({ key: row.id, title: row.title, values: salesforceValues(row, object, siteUrl, live, person) }));
  return applyRows(database, runAs, live.id!, items, props, deferred);
}

/** One run of a Salesforce sync whose database `runAs` may edit: what changed since the last, then where the next starts. */
export async function runSalesforce(sync: SyncRow, database: SyncedDatabase, runAs: string) {
  const auth = openJson<SalesforceAuth>(sync.secrets);
  const state = parseSalesforceQuery(sync.query);
  if (!state) throw new JiraError("failed", "The sync's state is unreadable");
  const fetched = await fetchRecords(sync.siteUrl, auth, state);
  const written = await applyRecords(database, runAs, sync.siteUrl, state.object, sync.mapping as unknown as SalesforceMapping, fetched.rows);
  const next: SalesforceQuery = { ...fetched.next, total: state.total + written.created };
  await db.update(databaseSync).set({ query: next }).where(eq(databaseSync.id, sync.id));
  return { count: next.total, ...written };
}

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { databaseSync } from "@/db/schema";
import type { ZendeskField, ZendeskMapping, ZendeskQuery, ZendeskRow, ZendeskUser } from "@/lib/zendesk-sync";
import { parseZendeskQuery, ticketValues, ZENDESK_STATUS_GROUPS, ZENDESK_STATUSES, zendeskOptionsNeeded } from "@/lib/zendesk-sync";
import type { PropertyType } from "@/lib/property-types";
import { getCollab } from "@/server/collab/bridge";
import { getProperties } from "@/server/databases";
import { matcher } from "@/server/import/board";
import type { SyncRow } from "@/server/jira-sync/run";
import { openJson } from "@/server/secret-box";
import { addOptions, applyRows, liveFields, type SyncedDatabase } from "@/server/synced-rows";
import { fetchTickets, type ZendeskAuth } from "./client";

/**
 * A run of a Zendesk ticket sync (lib/zendesk-sync), called by server/jira-sync/run, which holds and
 * records every synced database's runs. People are found by email address in the workspace, as
 * Jira's are; anyone else's name goes in the text beside.
 */

/** The type a mapped property must still have to be written. */
const TYPES: Record<ZendeskField, PropertyType> = {
  id: "number",
  status: "status",
  priority: "select",
  type: "select",
  requester: "person",
  requesterOthers: "text",
  assignee: "person",
  assigneeOthers: "text",
  tags: "multi_select",
  created: "date",
  updated: "date",
  link: "url",
};

/** Writes tickets into the database as `runAs` (who must be able to edit it). Returns how many rows it added and changed. */
export async function applyTickets(
  database: SyncedDatabase,
  runAs: string,
  mapping: ZendeskMapping,
  { rows, users }: { rows: ZendeskRow[]; users: Map<number, ZendeskUser> },
) {
  const before = await getProperties(database.id);
  const live = liveFields<ZendeskField>(mapping, TYPES, "id", before);
  const prop = (field: ZendeskField) => before.find((p) => p.id === live[field]);
  const needed = zendeskOptionsNeeded(rows);
  const added = [
    await addOptions(
      prop("status"),
      ZENDESK_STATUSES.map((status) => ({ name: mapping.statuses[status], group: ZENDESK_STATUS_GROUPS[status] })),
    ),
    await addOptions(prop("priority"), needed.priority.map((name) => ({ name }))),
    await addOptions(prop("type"), needed.type.map((name) => ({ name }))),
    await addOptions(prop("tags"), needed.tags.map((name) => ({ name }))),
  ].some(Boolean);
  if (added) getCollab().broadcast(`db:${database.id}`, "schema");
  const props = added ? await getProperties(database.id) : before;

  const match = await matcher(runAs, database.workspaceId);
  const person = (user: ZendeskUser) => match(user) ?? null;
  const fields = { ...live, statuses: mapping.statuses };
  // People of new rows go in afterwards, unannounced: the requester and the assignee.
  const deferred = [live.requester, live.assignee].filter((id): id is string => Boolean(id));
  const items = rows.map((row) => ({ key: String(row.id), title: row.title, values: ticketValues(row, fields, users, person) }));
  return applyRows(database, runAs, live.id!, items, props, deferred);
}

/** One run of a Zendesk sync whose database `runAs` may edit: what changed since the last, then where the next starts. */
export async function runZendesk(sync: SyncRow, database: SyncedDatabase, runAs: string) {
  const auth = openJson<ZendeskAuth>(sync.secrets);
  const state = parseZendeskQuery(sync.query);
  const fetched = await fetchTickets(sync.siteUrl, auth, state);
  const written = await applyTickets(database, runAs, sync.mapping as ZendeskMapping, fetched);
  const next: ZendeskQuery = { since: fetched.next.since, total: state.total + written.created };
  await db.update(databaseSync).set({ query: next }).where(eq(databaseSync.id, sync.id));
  return { count: next.total, ...written };
}

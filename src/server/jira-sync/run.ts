import { and, asc, eq, gt, isNull, lt, lte, or } from "drizzle-orm";
import { db } from "@/db";
import { databaseProperty, databaseSync, page } from "@/db/schema";
import { issueRow, jqlOf, optionsNeeded, pausesJiraSync, rowValues, type JiraField, type JiraMapping, type JiraRow, type JiraSyncError } from "@/lib/jira-sync";
import { sortStatusOptions, statusColor } from "@/lib/properties";
import type { PropertyType, StatusGroup } from "@/lib/property-types";
import { AccessError } from "@/server/access";
import { getCollab } from "@/server/collab/bridge";
import { afterRowWrites, getProperties, makeOption, mergedProperties, notifyRows, requireDatabase, type DatabaseProperty } from "@/server/databases";
import { matcher, writeIds } from "@/server/import/board";
import { checkValues, writeRows } from "@/server/import/csv";
import { renamePage } from "@/server/pages";
import { rowChanged } from "@/server/row-events";
import { openJson } from "@/server/secret-box";
import { startSweep } from "@/server/sweep";
import { JiraError, searchIssues, type JiraAuth } from "./client";

/**
 * Runs of Jira syncs (lib/jira-sync): every minute the app server takes the syncs that are due with
 * FOR UPDATE SKIP LOCKED, moves each one's next run on and holds it while it runs (`runningUntil`,
 * let go after LEASE_MS should the server die), so a sync never runs twice at once, here or on
 * another replica; "Sync now" takes the same hold.
 *
 * A run fetches every issue the query finds and writes them as rows, as whoever set the sync last
 * (they need to be able to edit the database). Rows are found by the Key property: a new issue adds
 * a row, a known one gets its summary as title and the synced properties written over; rows in the
 * trash are left there, and rows whose issue no longer matches stay as they are. New rows are added
 * like an import's, so a first run doesn't tell everyone of their old assignments; changes on later
 * runs go through afterRowWrites (activity, followers, automations, a new assignee's notice).
 */

const SWEEP_MS = 60_000;
const BATCH = 10;
const LEASE_MS = 10 * 60_000;

export type SyncRow = typeof databaseSync.$inferSelect;
type Database = { id: string; workspaceId: string; inTemplate: boolean };

/** The type a mapped property must still have to be written. */
const TYPES: Record<JiraField, PropertyType> = {
  key: "text",
  status: "status",
  assignee: "person",
  assigneeOthers: "text",
  reporter: "person",
  priority: "select",
  type: "select",
  labels: "multi_select",
  due: "date",
  link: "url",
};

/** The mapping's properties that still exist with their type; a run without its Key can't go on. */
function liveMapping(mapping: JiraMapping, props: DatabaseProperty[]): Partial<JiraMapping> {
  const live: Partial<JiraMapping> = {};
  for (const [field, id] of Object.entries(mapping) as [JiraField, string][]) {
    if (props.some((p) => p.id === id && p.type === TYPES[field])) live[field] = id;
  }
  if (!live.key) throw new JiraError("keyGone", "The Key property is gone");
  return live;
}

/** Adds the options a run needs that a select, status or multi-select doesn't have yet. */
async function addOptions(prop: DatabaseProperty | undefined, wanted: { name: string; group?: StatusGroup }[]) {
  if (!prop) return false;
  const options = prop.options.options ?? [];
  const missing = wanted.filter((w) => !options.some((o) => o.name.toLowerCase() === w.name.trim().toLowerCase()));
  if (!missing.length) return false;
  const added = missing.map((w, i) =>
    prop.type === "status"
      ? { ...makeOption(w.name), color: statusColor(w.group ?? "todo"), group: w.group ?? "todo" }
      : makeOption(w.name, options.length + i),
  );
  const next = [...options, ...added];
  await db
    .update(databaseProperty)
    .set({ options: { ...prop.options, options: prop.type === "status" ? sortStatusOptions(next) : next } })
    .where(eq(databaseProperty.id, prop.id));
  return true;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Writes issues into the database as `runAs` (who must be able to edit it). Returns how many rows
 * it added and changed.
 */
export async function applyIssues(database: Database, runAs: string, mapping: JiraMapping, rows: JiraRow[]) {
  const before = await getProperties(database.id);
  const live = liveMapping(mapping, before);
  const prop = (field: JiraField) => before.find((p) => p.id === live[field]);
  const needed = optionsNeeded(rows);
  const added = [
    await addOptions(prop("status"), needed.status),
    await addOptions(prop("priority"), needed.priority.map((name) => ({ name }))),
    await addOptions(prop("type"), needed.type.map((name) => ({ name }))),
    await addOptions(prop("labels"), needed.labels.map((name) => ({ name }))),
  ].some(Boolean);
  if (added) getCollab().broadcast(`db:${database.id}`, "schema");
  const props = added ? await getProperties(database.id) : before;

  const match = await matcher(runAs, database.workspaceId);
  const person = (someone: { name: string; email: string | null }) => match(someone) ?? null;
  // People of new rows go in afterwards, unannounced (see above): the assignee and the reporter.
  const deferred = [live.assignee, live.reporter].filter((id): id is string => Boolean(id));

  const stored = await db
    .select({ id: page.id, title: page.title, properties: page.properties, archivedAt: page.archivedAt, createdBy: page.createdBy })
    .from(page)
    .where(and(eq(page.parentId, database.id), eq(page.isTemplate, false)));
  // A key's row: one out of the trash first (two rows with a key: the first is kept in step).
  const byKey = new Map<string, (typeof stored)[number]>();
  for (const row of stored) {
    const key = row.properties[live.key!];
    if (typeof key !== "string" || !key) continue;
    const known = byKey.get(key);
    if (!known || (known.archivedAt && !row.archivedAt)) byKey.set(key, row);
  }

  const invalid = new Map<string, number>();
  const fresh: { title: string; properties: Record<string, unknown>; people: Record<string, string[]> }[] = [];
  const changes: { rowId: string; before: Record<string, unknown>; after: Record<string, unknown>; patch: Record<string, unknown> }[] = [];
  const renames: { id: string; title: string }[] = [];
  const done = new Set<string>();
  for (const row of rows) {
    if (done.has(row.key)) continue;
    done.add(row.key);
    const existing = byKey.get(row.key);
    if (existing?.archivedAt) continue;
    const values = rowValues(row, live, person);
    if (!existing) {
      const normalized = await checkValues(runAs, database.id, values, props, invalid);
      // Assignments of new rows go in afterwards, unannounced (see above).
      const people: Record<string, string[]> = {};
      for (const id of deferred) {
        if (!Array.isArray(normalized[id])) continue;
        people[id] = normalized[id] as string[];
        delete normalized[id];
      }
      fresh.push({ title: row.title, properties: normalized, people });
      continue;
    }
    const normalized = await checkValues(runAs, database.id, values, props, invalid, existing);
    const patch = Object.fromEntries(Object.entries(normalized).filter(([id, value]) => !same(existing.properties[id], value)));
    if (Object.keys(patch).length) {
      const after = { ...existing.properties };
      for (const [id, value] of Object.entries(patch)) {
        if (value === null) delete after[id];
        else after[id] = value;
      }
      changes.push({ rowId: existing.id, before: existing.properties, after, patch });
    }
    if (existing.title.trim() !== row.title.trim()) renames.push({ id: existing.id, title: row.title });
  }

  if (fresh.length) {
    const created = await writeRows(database, runAs, fresh.map(({ title, properties }) => ({ title, properties })));
    for (const propertyId of deferred) {
      const assigned = fresh.flatMap((row, i) => (row.people[propertyId] ? [{ id: created[i].id, ids: row.people[propertyId] }] : []));
      if (assigned.length) await writeIds(propertyId, assigned);
    }
  }
  for (const { rowId, patch } of changes) {
    const set = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== null));
    const cleared = Object.keys(patch).filter((k) => patch[k] === null);
    // Merged in SQL: a value someone else wrote meanwhile to a property the sync doesn't touch stays.
    await db.update(page).set({ properties: mergedProperties(set, cleared), updatedBy: runAs }).where(eq(page.id, rowId));
  }
  if (changes.length) await afterRowWrites(runAs, database.id, changes.map(({ rowId, before, after }) => ({ rowId, before, after })));
  for (const { id, title } of renames) {
    try {
      await renamePage({ userId: runAs }, id, title);
    } catch (error) {
      // A row someone locked keeps its title; the rest goes on.
      if (!(error instanceof AccessError) && !(error instanceof Error && error.constructor === Error)) throw error;
    }
  }
  if (fresh.length || changes.length) notifyRows(database.id);
  for (const { rowId } of changes) rowChanged({ rowId, databaseId: database.id, userId: runAs });
  return { created: fresh.length, updated: new Set([...changes.map((c) => c.rowId), ...renames.map((r) => r.id)]).size };
}

/** One run of a sync, as whoever set it last. Null when its database is in the trash (nothing to do). */
export async function runSync(sync: SyncRow) {
  if (!sync.runAs) throw new JiraError("runAsGone");
  let database;
  try {
    database = await requireDatabase(sync.runAs, sync.databaseId, "edit");
  } catch (error) {
    if (error instanceof AccessError) throw new JiraError("accessLost", error.message);
    throw error;
  }
  if (database.archivedAt) return null;
  const auth = openJson<JiraAuth>(sync.secrets);
  const issues = await searchIssues(sync.siteUrl, auth, jqlOf(sync.query));
  const rows = issues.map((issue) => issueRow(issue, sync.siteUrl)).filter((row): row is JiraRow => row !== null);
  const written = await applyIssues(database, sync.runAs, sync.mapping, rows);
  return { count: rows.length, ...written };
}

export type SyncOutcome = { error: JiraSyncError | null; count: number | null };

/** Runs a sync it holds, records how it went and lets it go. */
export async function runAndRecord(sync: SyncRow, now = new Date()): Promise<SyncOutcome> {
  let error: JiraSyncError | null = null;
  let detail: string | null = null;
  let result: Awaited<ReturnType<typeof runSync>> = null;
  try {
    result = await runSync(sync);
  } catch (e) {
    if (e instanceof JiraError) {
      // An address that can't be reached any more (CONNECTOR_ALLOWED_HOSTS changed) is no Jira to it.
      error = e.code === "invalidSite" || e.code === "invalidInput" || e.code === "alreadyRunning" ? "notFound" : e.code;
      detail = e.detail;
    } else {
      error = "failed";
      console.error("[jira sync] run failed", sync.id, e);
    }
  }
  const pause = error !== null && pausesJiraSync(error);
  await db
    .update(databaseSync)
    .set({
      runningUntil: null,
      lastError: error,
      lastErrorDetail: detail,
      ...(pause ? { enabled: false, nextRunAt: null } : {}),
      ...(result ? { lastRunAt: now, lastCount: result.count } : {}),
    })
    .where(eq(databaseSync.id, sync.id));
  // The database's viewers see when it last synced.
  getCollab().broadcast(`db:${sync.databaseId}`, "rows");
  return { error, count: result?.count ?? null };
}

const nextRun = (intervalMinutes: number, now: Date) => (intervalMinutes > 0 ? new Date(now.getTime() + intervalMinutes * 60_000) : null);
const free = (now: Date) => or(isNull(databaseSync.runningUntil), lt(databaseSync.runningUntil, now));

/** Takes the syncs due at `now`, moving each one's next run on and holding it, in one transaction. */
async function claimDue(now: Date) {
  return db.transaction(async (tx) => {
    const due = await tx
      .select()
      .from(databaseSync)
      .where(and(eq(databaseSync.enabled, true), gt(databaseSync.intervalMinutes, 0), lte(databaseSync.nextRunAt, now), free(now)))
      .orderBy(asc(databaseSync.nextRunAt))
      .limit(BATCH)
      .for("update", { skipLocked: true });
    for (const row of due) {
      await tx
        .update(databaseSync)
        .set({ nextRunAt: nextRun(row.intervalMinutes, now), runningUntil: new Date(now.getTime() + LEASE_MS) })
        .where(eq(databaseSync.id, row.id));
    }
    return due;
  });
}

/** Holds one sync for a run now (its next run counted from now), or null while another run is going. */
export async function claimSync(syncId: string, now = new Date()) {
  const [current] = await db.select({ intervalMinutes: databaseSync.intervalMinutes }).from(databaseSync).where(eq(databaseSync.id, syncId));
  if (!current) return null;
  const [row] = await db
    .update(databaseSync)
    .set({ runningUntil: new Date(now.getTime() + LEASE_MS), nextRunAt: nextRun(current.intervalMinutes, now) })
    .where(and(eq(databaseSync.id, syncId), free(now)))
    .returning();
  return row ?? null;
}

/** Runs every sync due at `now`. Returns how many ran (or tried to). */
export async function runDueSyncs(now = new Date()) {
  let total = 0;
  for (;;) {
    const claimed = await claimDue(now);
    for (const row of claimed) await runAndRecord(row, now);
    total += claimed.length;
    if (claimed.length < BATCH) return total;
  }
}

/** Server only: runs syncs as they fall due. */
export function startJiraSyncs() {
  return startSweep(SWEEP_MS, () => runDueSyncs(), "could not run Jira syncs");
}

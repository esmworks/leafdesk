import { and, asc, eq, gt, isNull, lt, lte, or } from "drizzle-orm";
import { db } from "@/db";
import { databaseSync } from "@/db/schema";
import { issueRow, jqlOf, optionsNeeded, pausesJiraSync, rowValues, type JiraField, type JiraMapping, type JiraQuery, type JiraRow, type JiraSyncError } from "@/lib/jira-sync";
import type { PropertyType } from "@/lib/property-types";
import { AccessError } from "@/server/access";
import { getCollab } from "@/server/collab/bridge";
import { getProperties, requireDatabase } from "@/server/databases";
import { runGithubPulls } from "@/server/github-pulls/run";
import { runIcal } from "@/server/ical-sync/run";
import { runPostgres } from "@/server/postgres-sync/run";
import { runSheets } from "@/server/sheets-sync/run";
import { matcher } from "@/server/import/board";
import { openJson } from "@/server/secret-box";
import { startSweep } from "@/server/sweep";
import { addOptions, applyRows, liveFields, type SyncedDatabase } from "@/server/synced-rows";
import { JiraError, searchIssues, type JiraAuth } from "./client";

/**
 * Runs of synced databases (`database_sync`: Jira issues, lib/jira-sync, GitHub pull requests,
 * lib/github-pulls-sync, calendars, lib/ical-sync, PostgreSQL tables, lib/postgres-sync, and Google
 * Sheets, lib/sheets-sync): every minute the app server takes the syncs that are due with FOR UPDATE
 * SKIP LOCKED, moves each one's next run on and holds it while it runs (`runningUntil`, let go after
 * LEASE_MS should the server die), so a sync never runs twice at once, here or on another replica;
 * "Sync now" takes the same hold.
 *
 * A run fetches what the sync takes and writes it as rows (server/synced-rows), as whoever set the
 * sync last (they need to be able to edit the database).
 */

const SWEEP_MS = 60_000;
const BATCH = 10;
const LEASE_MS = 10 * 60_000;
/**
 * How long the sweep waits for one run before it records the run as failed and goes on to the
 * next sync (each source's requests have shorter limits of their own). The run left behind keeps
 * its hold until LEASE_MS, so the sync doesn't start again while it may still be writing.
 */
export const RUN_TIMEOUT_MS = 8 * 60_000;

class RunTimeout extends Error {}

/** `work`, or a RunTimeout after `ms`. */
function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RunTimeout()), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export type SyncRow = typeof databaseSync.$inferSelect;

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

/**
 * Writes issues into the database as `runAs` (who must be able to edit it). Returns how many rows
 * it added and changed.
 */
export async function applyIssues(database: SyncedDatabase, runAs: string, mapping: JiraMapping, rows: JiraRow[]) {
  const before = await getProperties(database.id);
  const live = liveFields<JiraField>(mapping, TYPES, "key", before);
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
  // People of new rows go in afterwards, unannounced: the assignee and the reporter.
  const deferred = [live.assignee, live.reporter].filter((id): id is string => Boolean(id));
  const items = rows.map((row) => ({ key: row.key, title: row.title, values: rowValues(row, live, person) }));
  return applyRows(database, runAs, live.key!, items, props, deferred);
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
  if (sync.source === "github") return runGithubPulls(sync, database, sync.runAs);
  if (sync.source === "ical") return runIcal(sync, database, sync.runAs);
  if (sync.source === "postgres") return runPostgres(sync, database, sync.runAs);
  if (sync.source === "sheets") return runSheets(sync, database, sync.runAs);
  const auth = openJson<JiraAuth>(sync.secrets);
  const issues = await searchIssues(sync.siteUrl, auth, jqlOf(sync.query as JiraQuery));
  const rows = issues.map((issue) => issueRow(issue, sync.siteUrl)).filter((row): row is JiraRow => row !== null);
  const written = await applyIssues(database, sync.runAs, sync.mapping as JiraMapping, rows);
  return { count: rows.length, ...written };
}

export type SyncOutcome = { error: JiraSyncError | null; count: number | null };

/** Runs a sync it holds, records how it went and lets it go. */
export async function runAndRecord(sync: SyncRow, now = new Date()): Promise<SyncOutcome> {
  let error: JiraSyncError | null = null;
  let detail: string | null = null;
  let result: Awaited<ReturnType<typeof runSync>> = null;
  let timedOut = false;
  try {
    result = await within(runSync(sync), RUN_TIMEOUT_MS);
  } catch (e) {
    if (e instanceof RunTimeout) {
      timedOut = true;
      error = "unreachable";
      console.error(`[${sync.source} sync] run took too long`, sync.id);
    } else if (e instanceof JiraError) {
      // An address that can't be reached any more (CONNECTOR_ALLOWED_HOSTS changed) is no Jira (or GitHub) to it.
      error = e.code === "invalidSite" || e.code === "invalidInput" || e.code === "alreadyRunning" ? "notFound" : e.code;
      detail = e.detail;
    } else {
      error = "failed";
      console.error(`[${sync.source} sync] run failed`, sync.id, e);
    }
  }
  const pause = error !== null && pausesJiraSync(error);
  await db
    .update(databaseSync)
    .set({
      ...(timedOut ? {} : { runningUntil: null }),
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

const runner = globalThis as unknown as { __leafdeskSyncsSoon?: (ms: number) => void };

/**
 * Server only: runs syncs (Jira, GitHub, calendars, PostgreSQL, Google Sheets) as they fall due,
 * and, asked by sheets-sync/outbox, those due within `ms` once that time is up, without waiting
 * for the sweep. Both claim their syncs (claimDue), so they never run one twice.
 */
export function startDatabaseSyncs() {
  let timer: ReturnType<typeof setTimeout> | null = null;
  // One wait at a time: a change made meanwhile is due by then too.
  runner.__leafdeskSyncsSoon = (ms) => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      runDueSyncs().catch((error) => console.error("could not run database syncs", error));
    }, ms + 500);
    timer.unref?.();
  };
  const stop = startSweep(SWEEP_MS, () => runDueSyncs(), "could not run database syncs");
  return () => {
    stop();
    if (timer) clearTimeout(timer);
    delete runner.__leafdeskSyncsSoon;
  };
}

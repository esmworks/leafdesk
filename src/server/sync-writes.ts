import { AsyncLocalStorage } from "node:async_hooks";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { databaseSync, sheetsWrite } from "@/db/schema";
import type { GcalMapping } from "@/lib/gcal-sync";
import { TITLE_FIELD, type SheetsMapping, type SheetsQuery } from "@/lib/sheets-sync";

/**
 * Changes to the rows of a synced database that writes back (`direction` "both": a Google Sheets
 * sync, lib/sheets-sync, or a Google Calendar sync, lib/gcal-sync), kept in `sheets_write` until
 * the sync's next run writes them (sheets-sync/run, gcal-sync/run): row writes from
 * databases.afterRowWrites, titles from collab/service when a row's title is saved. Each change
 * brings the sync's next run to within WRITE_DELAY_MS and asks the server's syncs to run then
 * (jira-sync/run startDatabaseSyncs), rather than at the one-minute sweep. The run's own writes
 * (its reading the source into the rows) are no changes: it runs inside fromSync.
 * Imports nothing of server/databases, which calls it.
 */

/** How soon after a change the sync runs to write it: changes made together go in one run. */
const WRITE_DELAY_MS = 8_000;

/** The sources whose syncs may write back. */
const TWO_WAY_SOURCES = ["sheets", "gcal"] as const;

const syncRun = new AsyncLocalStorage<true>();

/** Runs `work` (a run writing its source into the rows) without queueing its writes for the source. */
export const fromSync = <T>(work: () => Promise<T>) => syncRun.run(true, work);

type Change = { rowId: string; before: Record<string, unknown>; after: Record<string, unknown> };

/** How long the list of databases whose syncs write back is kept; the syncs' manage.ts forget it on each change. */
const TWO_WAY_TTL_MS = 10_000;

// Shared by Next's bundle (manage.ts) and server.ts (row writes from the collab server).
const store = globalThis as unknown as { __leafdeskTwoWaySyncs?: { at: number; ids: Promise<Set<string>> } };

/** The databases whose syncs write back: every row write asks, and most databases have none. */
function twoWayDatabases() {
  const now = Date.now();
  let kept = store.__leafdeskTwoWaySyncs;
  if (!kept || now - kept.at > TWO_WAY_TTL_MS) {
    const ids = db
      .select({ databaseId: databaseSync.databaseId })
      .from(databaseSync)
      .where(and(inArray(databaseSync.source, [...TWO_WAY_SOURCES]), sql`${databaseSync.query} ->> 'direction' = 'both'`))
      .then((rows) => new Set(rows.map((r) => r.databaseId)));
    const fresh = { at: now, ids };
    kept = store.__leafdeskTwoWaySyncs = fresh;
    ids.catch(() => {
      if (store.__leafdeskTwoWaySyncs === fresh) delete store.__leafdeskTwoWaySyncs;
    });
  }
  return kept.ids;
}

/** Forgets which syncs write back (one was made, changed or stopped). */
export function forgetTwoWaySyncs() {
  delete store.__leafdeskTwoWaySyncs;
}

/** Whether the database's sync may write back (as of at most TWO_WAY_TTL_MS ago). */
export const mayWriteBack = async (databaseId: string) => (await twoWayDatabases()).has(databaseId);

/**
 * The database's sync, if it writes back: its id, the properties it writes, and how it takes a
 * row's title: "written" like a property, "key" when the title is the key a new row waits for (a
 * sheet whose key column names its rows: a key changes in the sheet alone).
 */
async function writingSync(databaseId: string) {
  if (!(await twoWayDatabases()).has(databaseId)) return null;
  const [row] = await db
    .select({ id: databaseSync.id, source: databaseSync.source, query: databaseSync.query, mapping: databaseSync.mapping })
    .from(databaseSync)
    .where(eq(databaseSync.databaseId, databaseId));
  // A paused sync keeps them too, for when it runs again.
  if (!row || (row.query as { direction?: string }).direction !== "both") return null;
  if (row.source === "sheets") {
    const query = row.query as SheetsQuery;
    const written = (row.mapping as SheetsMapping).columns.map((c) => c.property);
    return { id: row.id, written, title: query.titleColumn === query.keyColumn ? ("key" as const) : ("written" as const) };
  }
  if (row.source === "gcal") {
    const mapping = row.mapping as GcalMapping;
    const written = [mapping.when, mapping.location, mapping.description].filter((id): id is string => Boolean(id));
    return { id: row.id, written, title: "written" as const };
  }
  return null;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Keeps the changes and brings the run on. `before` of an entry already waiting keeps its first values. */
async function queue(syncId: string, entries: { rowId: string; created: boolean; before: Record<string, unknown> }[], editedBy: string | null) {
  if (!entries.length) return;
  await db
    .insert(sheetsWrite)
    .values(entries.map((e) => ({ syncId, rowId: e.rowId, created: e.created, before: e.before, editedBy })))
    .onConflictDoUpdate({
      target: [sheetsWrite.syncId, sheetsWrite.rowId],
      set: {
        before: sql`excluded.before || ${sheetsWrite.before}`,
        created: sql`${sheetsWrite.created} or excluded.created`,
        editedBy: sql`coalesce(excluded.edited_by, ${sheetsWrite.editedBy})`,
        queuedAt: sql`now()`,
        version: sql`${sheetsWrite.version} + 1`,
      },
    });
  await soon(syncId);
}

// Set by jira-sync/run startDatabaseSyncs where the server runs syncs (server.ts), shared with Next's bundle.
const runner = globalThis as unknown as { __leafdeskSyncsSoon?: (ms: number) => void };

/** Brings the sync's next run to within WRITE_DELAY_MS. It writes back, so runs on a schedule (manage.ts): its next run is never null. */
async function soon(syncId: string) {
  await db
    .update(databaseSync)
    .set({ nextRunAt: sql`least(${databaseSync.nextRunAt}, now() + ${`${WRITE_DELAY_MS} milliseconds`}::interval)` })
    .where(eq(databaseSync.id, syncId));
  runner.__leafdeskSyncsSoon?.(WRITE_DELAY_MS);
}

/** Row writes (afterRowWrites): the synced properties that changed, or every one of a new row. */
export async function queueSyncWrites(actorId: string | null, databaseId: string, changes: Change[], created: boolean) {
  if (syncRun.getStore() || !changes.length) return;
  const sync = await writingSync(databaseId);
  if (!sync) return;
  const entries = changes.flatMap(({ rowId, before, after }) => {
    if (created) return [{ rowId, created: true, before: {} }];
    const fields = sync.written.filter((id) => !same(before[id], after[id]));
    return fields.length ? [{ rowId, created: false, before: Object.fromEntries(fields.map((id) => [id, before[id] ?? null])) }] : [];
  });
  await queue(sync.id, entries, actorId);
}

/**
 * A row's saved title (collab/service). A new row waiting for its title to give it a key brings
 * the run on; other titles are written back. The run's own renames come here too, outside fromSync;
 * the run finds its source already holding them and writes nothing.
 */
export async function queueSyncTitle(rowId: string, databaseId: string, before: string, userId: string | null) {
  const sync = await writingSync(databaseId);
  if (!sync) return;
  if (sync.title === "key") {
    const [waiting] = await db
      .select({ id: sheetsWrite.id })
      .from(sheetsWrite)
      .where(and(eq(sheetsWrite.syncId, sync.id), eq(sheetsWrite.rowId, rowId), eq(sheetsWrite.created, true)))
      .limit(1);
    if (waiting) await soon(sync.id);
    return;
  }
  await queue(sync.id, [{ rowId, created: false, before: { [TITLE_FIELD]: before.trim() || null } }], userId);
}

/** Drops what waits for a sync (it stops writing back). */
export async function dropSyncWrites(syncId: string) {
  await db.delete(sheetsWrite).where(eq(sheetsWrite.syncId, syncId));
}

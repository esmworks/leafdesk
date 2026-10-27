import { AsyncLocalStorage } from "node:async_hooks";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { databaseSync, sheetsWrite } from "@/db/schema";
import { TITLE_FIELD, type SheetsMapping, type SheetsQuery } from "@/lib/sheets-sync";

/**
 * Changes to the rows of a Google Sheets sync that writes back (lib/sheets-sync `direction`
 * "both"), kept in `sheets_write` until the sync's next run writes them (./write): row writes from
 * databases.afterRowWrites, titles from collab/service when a row's title is saved. Each change
 * brings the sync's next run to within WRITE_DELAY_MS, which the one-minute sweep then takes. The
 * run's own writes (its reading the sheet into the rows) are no changes: it runs inside fromSheet.
 * Imports nothing of server/databases, which calls it.
 */

/** How soon after a change the sync runs to write it. */
const WRITE_DELAY_MS = 20_000;

const sheetRun = new AsyncLocalStorage<true>();

/** Runs `work` (the run writing the sheet into the rows) without queueing its writes for the sheet. */
export const fromSheet = <T>(work: () => Promise<T>) => sheetRun.run(true, work);

type Change = { rowId: string; before: Record<string, unknown>; after: Record<string, unknown> };

/** How long the list of databases whose syncs write back is kept; manage.ts forgets it on each change. */
const TWO_WAY_TTL_MS = 10_000;

// Shared by Next's bundle (manage.ts) and server.ts (row writes from the collab server).
const store = globalThis as unknown as { __leafdeskSheetsTwoWay?: { at: number; ids: Promise<Set<string>> } };

/** The databases whose syncs write back: every row write asks, and most databases have none. */
function twoWayDatabases() {
  const now = Date.now();
  let kept = store.__leafdeskSheetsTwoWay;
  if (!kept || now - kept.at > TWO_WAY_TTL_MS) {
    const ids = db
      .select({ databaseId: databaseSync.databaseId })
      .from(databaseSync)
      .where(and(eq(databaseSync.source, "sheets"), sql`${databaseSync.query} ->> 'direction' = 'both'`))
      .then((rows) => new Set(rows.map((r) => r.databaseId)));
    const fresh = { at: now, ids };
    kept = store.__leafdeskSheetsTwoWay = fresh;
    ids.catch(() => {
      if (store.__leafdeskSheetsTwoWay === fresh) delete store.__leafdeskSheetsTwoWay;
    });
  }
  return kept.ids;
}

/** Forgets which syncs write back (one was made, changed or stopped). */
export function forgetTwoWaySyncs() {
  delete store.__leafdeskSheetsTwoWay;
}

/** The database's sync, if it writes back: its id and the properties it writes. */
async function writingSync(databaseId: string) {
  if (!(await twoWayDatabases()).has(databaseId)) return null;
  const [row] = await db
    .select({ id: databaseSync.id, source: databaseSync.source, query: databaseSync.query, mapping: databaseSync.mapping })
    .from(databaseSync)
    .where(eq(databaseSync.databaseId, databaseId));
  // A paused sync keeps them too, for when it runs again.
  if (!row || row.source !== "sheets" || (row.query as SheetsQuery).direction !== "both") return null;
  return { id: row.id, query: row.query as SheetsQuery, mapping: row.mapping as SheetsMapping };
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

/** Brings the sync's next run to within WRITE_DELAY_MS. It writes back, so runs on a schedule (manage.ts): its next run is never null. */
async function soon(syncId: string) {
  await db
    .update(databaseSync)
    .set({ nextRunAt: sql`least(${databaseSync.nextRunAt}, now() + ${`${WRITE_DELAY_MS} milliseconds`}::interval)` })
    .where(eq(databaseSync.id, syncId));
}

/** Row writes (afterRowWrites): the synced properties that changed, or every one of a new row. */
export async function queueSheetWrites(actorId: string | null, databaseId: string, changes: Change[], created: boolean) {
  if (sheetRun.getStore() || !changes.length) return;
  const sync = await writingSync(databaseId);
  if (!sync) return;
  const written = sync.mapping.columns.map((c) => c.property);
  const entries = changes.flatMap(({ rowId, before, after }) => {
    if (created) return [{ rowId, created: true, before: {} }];
    const fields = written.filter((id) => !same(before[id], after[id]));
    return fields.length ? [{ rowId, created: false, before: Object.fromEntries(fields.map((id) => [id, before[id] ?? null])) }] : [];
  });
  await queue(sync.id, entries, actorId);
}

/**
 * A row's saved title (collab/service). Written back only where another column than the key names
 * rows: a key changes in the sheet alone, but a new row waiting for its title to give it a key
 * brings the run on. The run's own renames come here too, outside fromSheet; the run finds the
 * sheet already holding them and writes nothing.
 */
export async function queueSheetTitle(rowId: string, databaseId: string, before: string, userId: string | null) {
  const sync = await writingSync(databaseId);
  if (!sync) return;
  if (sync.query.titleColumn === sync.query.keyColumn) {
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
export async function dropSheetWrites(syncId: string) {
  await db.delete(sheetsWrite).where(eq(sheetsWrite.syncId, syncId));
}

/**
 * Records a database's history (lib/database-history.ts and the `database_change` table): what
 * the schema writes of server/databases.ts did to properties and shared views (trackSchema reads
 * them before and after), and rows put in the trash or taken out (server/pages.ts). Nothing here
 * throws: the history never holds back or fails the write it records. Reading and undoing is
 * server/database-history.ts.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { databaseChange, databaseProperty, databaseView, page } from "@/db/schema";
import {
  CHANGE_WINDOW_MS,
  MAX_KEPT_VALUES,
  mergeChange,
  mergeValues,
  propertySnapshot,
  sameSnapshot,
  viewSnapshot,
  type ChangedValues,
  type DatabaseChangeKind,
  type OpenChange,
  type RowsSnapshot,
} from "@/lib/database-history";
import { redactError, redactValue } from "@/lib/redact";
import { sameValue, storedValue } from "@/lib/row-activity";
import { actorKindOf } from "@/server/row-activity";

// One per process: route modules can be loaded more than once in development.
const globalForSetup = globalThis as unknown as { __leafdeskDatabaseSetup?: AsyncLocalStorage<true> };
const setup = (globalForSetup.__leafdeskDatabaseSetup ??= new AsyncLocalStorage<true>());

/**
 * Runs `fn`, the making of new databases with their properties and views (a plan, a template, a
 * synced database's setup): what it sets up is where their history starts, not a change of it.
 */
export const asSetup = <T>(fn: () => Promise<T>) => setup.run(true, fn);

type Targets = { properties?: readonly string[]; views?: readonly string[] };
type PropertyRow = typeof databaseProperty.$inferSelect;
type ViewRow = typeof databaseView.$inferSelect;

type NewChange = {
  databaseId: string;
  kind: DatabaseChangeKind;
  targetId: string | null;
  before: unknown;
  after: unknown;
  changedValues?: ChangedValues | null;
};

async function readTargets({ properties = [], views = [] }: Targets) {
  const [props, vs] = await Promise.all([
    properties.length ? db.select().from(databaseProperty).where(inArray(databaseProperty.id, [...properties])) : Promise.resolve([] as PropertyRow[]),
    views.length ? db.select().from(databaseView).where(inArray(databaseView.id, [...views])) : Promise.resolve([] as ViewRow[]),
  ]);
  return { properties: new Map(props.map((p) => [p.id, p])), views: new Map(vs.map((v) => [v.id, v])) };
}

/** `targets` with the other sides of the two-way relations among `known`. */
function withPairs(targets: Targets, known: PropertyRow[]): Targets {
  const paired = known.flatMap((p) => (p.type === "relation" && p.options.relation?.pairedPropertyId ? [p.options.relation.pairedPropertyId] : []));
  return { ...targets, properties: [...new Set([...(targets.properties ?? []), ...paired])] };
}

/** The values the rows of `databaseId` hold in a property, or null past the most a change keeps. */
async function readValues(databaseId: string, propertyId: string): Promise<Map<string, unknown> | null> {
  const rows = await db
    .select({ id: page.id, value: sql<unknown>`${page.properties} -> ${propertyId}::text` })
    .from(page)
    .where(and(eq(page.parentId, databaseId), sql`${page.properties} ? ${propertyId}::text`))
    .limit(MAX_KEPT_VALUES + 1);
  return rows.length > MAX_KEPT_VALUES ? null : new Map(rows.map((r) => [r.id, r.value]));
}

/** The rows whose value `before` and `after` differ in, each [before, after]; null when not known. */
function valueChanges(before: Map<string, unknown> | null, after: Map<string, unknown> | null): ChangedValues | null {
  if (!before || !after) return null;
  const changes: ChangedValues = {};
  for (const rowId of new Set([...before.keys(), ...after.keys()])) {
    const [a, b] = [storedValue(before.get(rowId)), storedValue(after.get(rowId))];
    if (!sameValue(a, b)) changes[rowId] = [redactValue(a), redactValue(b)];
  }
  return Object.keys(changes).length ? changes : null;
}

/**
 * Runs a schema write and records what it did to the properties and views it names (and to those
 * `added` names of its result): added, changed, deleted or restored, each with its settings before
 * and after. `values`: a property whose row values the write may rewrite (a type change, options
 * taken away), read before and after so undoing it can put them back.
 */
export async function trackSchema<T>(
  actorId: string,
  targets: Targets,
  write: () => Promise<T>,
  { added, values }: { added?: (result: T) => Targets; values?: string } = {},
): Promise<T> {
  if (setup.getStore()) return write();
  let started = new Date();
  let before: Awaited<ReturnType<typeof readTargets>> | null = null;
  let valuesBefore: Map<string, unknown> | null = null;
  try {
    // The database's clock, which stamps what the write makes.
    const [clock] = await db.execute<{ now: string }>(sql`select clock_timestamp() as now`);
    started = new Date(clock.now);
    before = await readTargets(withPairs(targets, []));
    // The other side of a two-way relation changes with it (deleted, restored, taken apart).
    before = await readTargets(withPairs(targets, [...before.properties.values()]));
    const valued = values ? before.properties.get(values) : undefined;
    if (valued) valuesBefore = await readValues(valued.databaseId, valued.id);
  } catch (error) {
    console.error("[database-history] reading before a schema write failed", redactError(error));
  }
  const result = await write();
  if (!before) return result;
  try {
    const more = added?.(result) ?? {};
    const named = {
      properties: [...new Set([...(targets.properties ?? []), ...(more.properties ?? [])])],
      views: [...new Set([...(targets.views ?? []), ...(more.views ?? [])])],
    };
    const first = await readTargets(named);
    const all = withPairs(named, [...before.properties.values(), ...first.properties.values()]);
    const after = await readTargets(all);
    const valued = values ? after.properties.get(values) : undefined;
    const valuesAfter = valued && valuesBefore ? await readValues(valued.databaseId, valued.id) : null;
    const changes: NewChange[] = [];
    for (const id of all.properties ?? []) {
      const was = before.properties.get(id) ?? null;
      const now = after.properties.get(id) ?? null;
      // Named only after the write and there before it: what it was isn't known, so nothing is said.
      if (!was && now && now.createdAt < started) continue;
      const change = propertyChange(was, now);
      if (!change) continue;
      if (values === id && change.kind === "property_changed") change.changedValues = valueChanges(valuesBefore, valuesAfter);
      changes.push(change);
    }
    for (const id of all.views ?? []) {
      const was = before.views.get(id) ?? null;
      const now = after.views.get(id) ?? null;
      if (!was && now && now.createdAt < started) continue;
      const change = viewChange(was, now);
      if (change) changes.push(change);
    }
    if (changes.length) await save(actorId, changes);
  } catch (error) {
    console.error("[database-history] recording a schema write failed", redactError(error));
  }
  return result;
}

function propertyChange(before: PropertyRow | null, after: PropertyRow | null): NewChange | null {
  // Gone for good: the trash's own record (and the audit log) say so.
  if (!after) return null;
  const base = { databaseId: after.databaseId, targetId: after.id };
  const now = propertySnapshot(after);
  if (!before) return after.deletedAt ? null : { ...base, kind: "property_added", before: null, after: now };
  const was = propertySnapshot(before);
  if (!before.deletedAt && after.deletedAt) return { ...base, kind: "property_deleted", before: was, after: null };
  if (before.deletedAt && !after.deletedAt) return { ...base, kind: "property_restored", before: null, after: now };
  if (after.deletedAt || sameSnapshot(was, now)) return null;
  return { ...base, kind: "property_changed", before: was, after: now };
}

/** Shared views only: a personal view is its person's alone, and leaves no history. */
function viewChange(before: ViewRow | null, after: ViewRow | null): NewChange | null {
  if (!after || after.ownerId) return null;
  const base = { databaseId: after.databaseId, targetId: after.id };
  const now = viewSnapshot(after);
  // A personal view shared with everyone is new to them.
  if (!before || before.ownerId) return after.deletedAt ? null : { ...base, kind: "view_added", before: null, after: now };
  const was = viewSnapshot(before);
  if (!before.deletedAt && after.deletedAt) return { ...base, kind: "view_deleted", before: was, after: null };
  if (before.deletedAt && !after.deletedAt) return { ...base, kind: "view_restored", before: null, after: now };
  if (after.deletedAt || sameSnapshot(was, now)) return null;
  return { ...base, kind: "view_changed", before: was, after: now };
}

/**
 * Records rows of a database put in the trash (`rows_trashed`) or taken out of it. Rows trashed or
 * restored one after another by the same person within the merge window are one entry.
 */
export async function recordRows(actorId: string, databaseId: string, kind: "rows_trashed" | "rows_restored", rows: { id: string; title: string }[]) {
  if (!rows.length) return;
  try {
    // Rows of a database only: pages under other pages go to the trash with no history of their own.
    const [parent] = await db.select({ kind: page.kind }).from(page).where(eq(page.id, databaseId));
    if (parent?.kind !== "database") return;
    await save(actorId, [{ databaseId, kind, targetId: null, before: null, after: { rows } satisfies RowsSnapshot }]);
  } catch (error) {
    console.error("[database-history] recording rows failed", redactError(error));
  }
}

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

async function save(actorId: string, changes: NewChange[]) {
  const actorKind = await actorKindOf(actorId, false);
  const databaseIds = [...new Set(changes.map((c) => c.databaseId))];
  const workspaces = new Map(
    (await db.select({ id: page.id, workspaceId: page.workspaceId }).from(page).where(inArray(page.id, databaseIds))).map((d) => [d.id, d.workspaceId]),
  );
  const now = new Date();
  for (const change of changes) {
    const workspaceId = workspaces.get(change.databaseId);
    if (!workspaceId) continue;
    // One merge per property, view or database's rows at a time.
    const key = change.targetId ?? `${change.databaseId}:${change.kind}`;
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`leafdesk:database-change:${key}`}))`);
      const latest = await latestChange(tx, change);
      if (change.kind === "rows_trashed" || change.kind === "rows_restored") {
        const rows = (change.after as RowsSnapshot).rows;
        if (latest && latest.kind === change.kind && latest.actorUserId === actorId && now.getTime() - latest.at.getTime() <= CHANGE_WINDOW_MS) {
          const known = new Set(latest.rows.map((r) => r.id));
          const merged = [...latest.rows, ...rows.filter((r) => !known.has(r.id))];
          await tx.update(databaseChange).set({ after: { rows: merged }, createdAt: now }).where(eq(databaseChange.id, latest.id));
          return;
        }
        await insert(tx, workspaceId, actorId, actorKind, change, now);
        return;
      }
      const decision = mergeChange(latest, { kind: change.kind, actorUserId: actorId, actorKind, after: change.after }, now);
      if (decision.action === "insert") return insert(tx, workspaceId, actorId, actorKind, change, now);
      if (decision.action === "drop") {
        await tx.delete(databaseChange).where(eq(databaseChange.id, decision.id));
        return;
      }
      await tx
        .update(databaseChange)
        .set({ after: change.after, changedValues: mergeValues(latest!.changedValues, change.changedValues ?? null), createdAt: now })
        .where(eq(databaseChange.id, decision.id));
    });
  }
}

/** The newest entry about the same property or view (or the same database's rows, for `rows_*`). */
async function latestChange(
  tx: Executor,
  change: NewChange,
): Promise<(OpenChange & { changedValues: ChangedValues | null; rows: { id: string; title: string }[] }) | null> {
  const [row] = await tx
    .select()
    .from(databaseChange)
    .where(
      change.targetId
        ? eq(databaseChange.targetId, change.targetId)
        : and(eq(databaseChange.databaseId, change.databaseId), eq(databaseChange.kind, change.kind)),
    )
    .orderBy(desc(databaseChange.createdAt), desc(databaseChange.id))
    .limit(1);
  if (!row) return null;
  const rows = (row.after as RowsSnapshot | null)?.rows ?? [];
  return {
    id: row.id,
    kind: row.kind,
    actorUserId: row.actorUserId,
    actorKind: row.actorKind,
    before: row.before,
    at: row.createdAt,
    changedValues: row.changedValues,
    rows: Array.isArray(rows) ? rows : [],
  };
}

async function insert(
  tx: Executor,
  workspaceId: string,
  actorId: string,
  actorKind: Awaited<ReturnType<typeof actorKindOf>>,
  change: NewChange,
  at: Date,
) {
  await tx.insert(databaseChange).values({
    databaseId: change.databaseId,
    workspaceId,
    actorUserId: actorId,
    actorKind,
    kind: change.kind,
    targetId: change.targetId,
    before: change.before,
    after: change.after,
    changedValues: change.changedValues ?? null,
    createdAt: at,
  });
}

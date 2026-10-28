/**
 * Reading and undoing a database's history (lib/database-history.ts; recorded by
 * server/database-changes.ts), for the database's history panel and MCP alike. Whoever can open
 * the database reads it: changes of properties they may not know of are left out, and so are rows
 * they can't open. Row values come from the rows' activity (lib/row-activity), read in groups: what
 * one actor did to one property within the merge window, across every row it touched.
 */

import { and, asc, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { databaseChange, databaseProperty, databaseView, page, rowActivity, type PropertyType, type ViewType } from "@/db/schema";
import {
  CHANGE_WINDOW_MS,
  MAX_HISTORY_PAGE,
  propertyFields,
  propertySnapshot,
  restorePatch,
  viewParts,
  type ChangedValues,
  type DatabaseChangeKind,
  type HistoryActor,
  type PropertyField,
  type PropertySnapshot,
  type RowsSnapshot,
  type ViewPart,
  type ViewSnapshot,
} from "@/lib/database-history";
import { atLeast } from "@/lib/property-access";
import { REDACTED } from "@/lib/redact";
import { referencedIds, resolveValue, sameValue, storedValue, type ActivityValue, type RowActivityActor } from "@/lib/row-activity";
import { AccessError, childVisibleTo, hasLevel, resolvePageAccess } from "@/server/access";
import { loadLookups } from "@/server/activity-lookups";
import {
  changePropertyType,
  deleteProperty,
  deleteView,
  restoreProperty,
  restoreView,
  updateProperty,
  updateRowsProperties,
  updateView,
  withCode,
} from "@/server/databases";
import { archiveRows, restorePage } from "@/server/pages";
import { propertyAccessFor } from "@/server/property-access";

type TargetState = "live" | "deleted" | "gone";

type Base = { id: string; at: string; actor: HistoryActor; canUndo: boolean };

export type HistoryEntry =
  | (Base & {
      type: "property";
      kind: Extract<DatabaseChangeKind, `property_${string}`>;
      property: { id: string; name: string; type: PropertyType; state: TargetState };
      /** property_changed: what changed. */
      fields: PropertyField[];
      /** Row values the change rewrote that undoing it puts back. */
      values: number;
    })
  | (Base & {
      type: "view";
      kind: Extract<DatabaseChangeKind, `view_${string}`>;
      view: { id: string; name: string; type: ViewType; state: TargetState };
      parts: ViewPart[];
    })
  | (Base & { type: "rows"; kind: "rows_trashed" | "rows_restored"; rows: { id: string; title: string }[] })
  | (Base & {
      type: "values";
      kind: "created" | "title" | "property";
      /** When the first of the changes was. */
      since: string;
      property: { id: string; name: string; type: PropertyType } | null;
      /** How many rows the changes touched, and a few of them. */
      rows: number;
      sample: { id: string; title: string }[];
      /** The value every row had before, or got: null when they differ, or the viewer may not see them. */
      from: ActivityValue | null;
      to: ActivityValue | null;
    });

export type HistoryPage = { entries: HistoryEntry[]; next: string | null };

/** What a group of row value changes is known by, for undoing it. */
type GroupKey = { db: string; actor: string | null; actorKind: RowActivityActor; kind: "created" | "title" | "property"; property: string | null; from: string; to: string };

const encodeKey = (key: GroupKey) => `values:${Buffer.from(JSON.stringify(key)).toString("base64url")}`;

function decodeKey(id: string): GroupKey | null {
  if (!id.startsWith("values:")) return null;
  try {
    const key = JSON.parse(Buffer.from(id.slice(7), "base64url").toString()) as GroupKey;
    if (typeof key.db !== "string" || typeof key.from !== "string" || typeof key.to !== "string" || !["created", "title", "property"].includes(key.kind)) return null;
    return key;
  } catch {
    return null;
  }
}

async function databaseAccess(userId: string, databaseId: string) {
  const { page: found, level } = await resolvePageAccess(userId, databaseId);
  if (!found || !hasLevel(level, "view")) throw new AccessError();
  if (found.kind !== "database") throw withCode(new AccessError("Not a database"), "notADatabase");
  return { database: found, canEdit: hasLevel(level, "edit") && !found.lockedAt && !found.archivedAt, canEditRows: hasLevel(level, "content") && !found.archivedAt };
}

/**
 * `limit` entries of a database's history before `before` (an entry's `at`, from the page before),
 * newest first.
 */
export async function listDatabaseHistory(
  userId: string,
  databaseId: string,
  { before, limit = 30 }: { before?: string | null; limit?: number } = {},
): Promise<HistoryPage> {
  const { canEdit, canEditRows } = await databaseAccess(userId, databaseId);
  limit = Math.min(Math.max(1, Math.trunc(limit)), MAX_HISTORY_PAGE);
  const cursor = before ? new Date(before) : null;
  if (cursor && Number.isNaN(cursor.getTime())) throw new Error("before is a time from the page before");

  const [properties, views, access] = await Promise.all([
    db
      .select({ id: databaseProperty.id, name: databaseProperty.name, type: databaseProperty.type, options: databaseProperty.options, deletedAt: databaseProperty.deletedAt })
      .from(databaseProperty)
      .where(eq(databaseProperty.databaseId, databaseId)),
    db
      .select({ id: databaseView.id, name: databaseView.name, type: databaseView.type, deletedAt: databaseView.deletedAt })
      .from(databaseView)
      .where(and(eq(databaseView.databaseId, databaseId), isNull(databaseView.ownerId))),
    propertyAccessFor(userId, databaseId, { withDeleted: true }),
  ]);
  const propertyById = new Map(properties.map((p) => [p.id, p]));
  const viewById = new Map(views.map((v) => [v.id, v]));
  const known = new Set(access.visible(properties).map((p) => p.id));
  // Values show where the viewer sees them in every row; rules that go by the row hide them here.
  const info = access.info();
  const valuesShown = new Set([...known].filter((id) => atLeast(access.levelOf(id), "view") && !info?.[id]?.perRow));

  const [changes, groups] = await Promise.all([
    db
      .select()
      .from(databaseChange)
      .where(and(eq(databaseChange.databaseId, databaseId), cursor ? lt(databaseChange.createdAt, cursor) : undefined))
      .orderBy(desc(databaseChange.createdAt), desc(databaseChange.id))
      // Entries about properties the viewer can't know of are dropped after reading: read some more.
      .limit(limit * 2 + 20),
    valueGroups(userId, databaseId, known, cursor, limit),
  ]);

  const shownChanges = changes.filter((c) => !c.targetId || !(c.kind.startsWith("property_")) || known.has(c.targetId));
  const visibleRows = await visibleRowIds(userId, databaseId, [
    ...shownChanges.flatMap((c) => (c.kind === "rows_trashed" || c.kind === "rows_restored" ? rowsOf(c.after).map((r) => r.id) : [])),
  ]);

  const ids = referencedIds(groups.flatMap((g) => [g.from, g.to].map((value) => ({ type: g.propertyType, value }))));
  const lookups = await loadLookups(
    userId,
    [...ids.people, ...changes.flatMap((c) => (c.actorUserId ? [c.actorUserId] : [])), ...groups.flatMap((g) => (g.actorUserId ? [g.actorUserId] : []))],
    [...ids.pages],
  );
  const actorOf = (id: string | null, kind: RowActivityActor): HistoryActor => {
    const person = id ? (lookups.people.get(id) ?? null) : null;
    return { kind: kind === "user" && person?.isAgent ? "agent" : kind, person };
  };

  const entries: HistoryEntry[] = [];
  for (const c of shownChanges) {
    const base = { id: c.id, at: c.createdAt.toISOString(), actor: actorOf(c.actorUserId, c.actorKind) };
    if (c.kind.startsWith("property_")) {
      const current = c.targetId ? propertyById.get(c.targetId) : undefined;
      const snap = (c.after ?? c.before) as PropertySnapshot;
      const state: TargetState = !current ? "gone" : current.deletedAt ? "deleted" : "live";
      const values = c.changedValues ? Object.keys(c.changedValues).length : 0;
      entries.push({
        ...base,
        type: "property",
        kind: c.kind as Extract<DatabaseChangeKind, `property_${string}`>,
        // The name it has now, so it can be found; the type the change left it with.
        property: { id: c.targetId!, name: current?.name ?? snap.name, type: snap.type, state },
        fields: c.kind === "property_changed" ? propertyFields(c.before as PropertySnapshot, c.after as PropertySnapshot) : [],
        values,
        canUndo: canEdit && undoable(c.kind, state),
      });
    } else if (c.kind.startsWith("view_")) {
      const current = c.targetId ? viewById.get(c.targetId) : undefined;
      const snap = (c.after ?? c.before) as ViewSnapshot;
      const state: TargetState = !current ? "gone" : current.deletedAt ? "deleted" : "live";
      entries.push({
        ...base,
        type: "view",
        kind: c.kind as Extract<DatabaseChangeKind, `view_${string}`>,
        view: { id: c.targetId!, name: current?.name ?? snap.name, type: snap.type, state },
        parts: c.kind === "view_changed" ? viewParts(c.before as ViewSnapshot, c.after as ViewSnapshot) : [],
        canUndo: canEdit && undoable(c.kind, state),
      });
    } else {
      const rows = rowsOf(c.after).filter((r) => visibleRows.has(r.id));
      if (!rows.length) continue;
      entries.push({ ...base, type: "rows", kind: c.kind as "rows_trashed" | "rows_restored", rows, canUndo: canEditRows });
    }
  }
  for (const g of groups) {
    const property = g.propertyId ? propertyById.get(g.propertyId) : undefined;
    const shown = g.kind === "title" || (g.propertyId !== null && valuesShown.has(g.propertyId));
    const read = (value: unknown): ActivityValue | null =>
      !shown ? null : g.kind === "title" ? resolveValue("text", [], value, lookups) : resolveValue(g.propertyType ?? property?.type ?? null, property?.options.options ?? [], value, lookups);
    entries.push({
      id: encodeKey({ db: databaseId, actor: g.actorUserId, actorKind: g.actorKind, kind: g.kind, property: g.propertyId, from: g.firstAt.toISOString(), to: g.lastAt.toISOString() }),
      type: "values",
      kind: g.kind,
      at: g.lastAt.toISOString(),
      since: g.firstAt.toISOString(),
      actor: actorOf(g.actorUserId, g.actorKind),
      property: property ? { id: property.id, name: property.name, type: property.type } : null,
      rows: g.rows,
      sample: g.sample,
      from: g.kind === "created" || g.fromCount !== 1 ? null : read(g.from),
      to: g.kind === "created" || g.toCount !== 1 ? null : read(g.to),
      // Values put back by an undo; new rows go back to the trash. Titles are undone in each row's page history.
      canUndo: canEditRows && g.kind !== "title",
    });
  }
  entries.sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
  const shown = entries.slice(0, limit);
  const more = entries.length > limit || changes.length > shownChanges.length || groups.length >= limit;
  return { entries: shown, next: shown.length && more ? shown[shown.length - 1].at : null };
}

function undoable(kind: DatabaseChangeKind, state: TargetState): boolean {
  if (state === "gone") return false;
  if (kind === "property_deleted" || kind === "view_deleted") return state === "deleted";
  return state === "live";
}

function rowsOf(value: unknown): { id: string; title: string }[] {
  const rows = (value as RowsSnapshot | null)?.rows;
  return Array.isArray(rows) ? rows.filter((r) => r && typeof r.id === "string").map((r) => ({ id: r.id, title: typeof r.title === "string" ? r.title : "" })) : [];
}

/** Of `rowIds`, the rows of the database the viewer can open (in the trash too). */
async function visibleRowIds(userId: string, databaseId: string, rowIds: string[]): Promise<Set<string>> {
  if (!rowIds.length) return new Set();
  const rows = await db
    .select({ id: page.id })
    .from(page)
    .where(and(inArray(page.id, [...new Set(rowIds)]), childVisibleTo(userId, databaseId)));
  return new Set(rows.map((r) => r.id));
}

type ValueGroup = {
  actorUserId: string | null;
  actorKind: RowActivityActor;
  kind: "created" | "title" | "property";
  propertyId: string | null;
  propertyType: PropertyType | null;
  firstAt: Date;
  lastAt: Date;
  rows: number;
  fromCount: number;
  toCount: number;
  from: unknown;
  to: unknown;
  sample: { id: string; title: string }[];
};

/**
 * The rows' value changes in groups, newest first, `limit` of them that ended before `cursor`: an
 * actor's changes of one property (or of titles, or the rows they made) with no gap longer than
 * the merge window, on rows the viewer can open and properties they may know of.
 */
async function valueGroups(userId: string, databaseId: string, known: ReadonlySet<string>, cursor: Date | null, limit: number): Promise<ValueGroup[]> {
  const props = [...known];
  const propertyRule = props.length
    ? sql`(ra.kind <> 'property' or ra.property_id in (${sql.join(props.map((id) => sql`${id}`), sql`, `)}))`
    : sql`ra.kind <> 'property'`;
  const gap = sql.raw(`interval '${Math.round(CHANGE_WINDOW_MS / 1000)} seconds'`);
  const rows = await db.execute<{
    actor_user_id: string | null;
    actor_kind: RowActivityActor;
    kind: "created" | "title" | "property";
    property_id: string | null;
    property_type: PropertyType | null;
    first_at: string;
    last_at: string;
    rows: number;
    from_count: number;
    to_count: number;
    old_value: unknown;
    new_value: unknown;
    sample: { id: string; title: string }[];
  }>(sql`
    with e as (
      select ra.row_id, ra.actor_user_id, ra.actor_kind, ra.kind, ra.property_id, ra.property_type, ra.old_value, ra.new_value, ra.created_at, r.title,
        case when lag(ra.created_at) over w is null or ra.created_at - lag(ra.created_at) over w > ${gap} then 1 else 0 end as starts
      from ${rowActivity} ra join ${page} r on r.id = ra.row_id
      where ra.database_id = ${databaseId} and ra.merged_from_id is null and ra.kind in ('created', 'title', 'property')
        and ${propertyRule} and ${childVisibleTo(userId, databaseId, "r")}
      window w as (partition by ra.actor_user_id, ra.actor_kind, ra.kind, ra.property_id order by ra.created_at)
    ), g as (
      select *, sum(starts) over (partition by actor_user_id, actor_kind, kind, property_id order by created_at rows unbounded preceding) as grp from e
    )
    select actor_user_id, actor_kind, kind, property_id, max(property_type) as property_type,
      min(created_at) as first_at, max(created_at) as last_at, count(distinct row_id)::int as rows,
      count(distinct coalesce(old_value, 'null'::jsonb))::int as from_count, count(distinct coalesce(new_value, 'null'::jsonb))::int as to_count,
      (array_agg(old_value order by created_at))[1] as old_value, (array_agg(new_value order by created_at desc))[1] as new_value,
      (select coalesce(jsonb_agg(jsonb_build_object('id', s.row_id, 'title', s.title)), '[]'::jsonb) from (
        select distinct on (g2.row_id) g2.row_id, g2.title, g2.created_at from g g2
        where g2.actor_user_id is not distinct from g.actor_user_id and g2.actor_kind = g.actor_kind and g2.kind = g.kind
          and g2.property_id is not distinct from g.property_id and g2.grp = g.grp
        order by g2.row_id, g2.created_at desc limit 5
      ) s) as sample
    from g
    group by actor_user_id, actor_kind, kind, property_id, grp
    ${cursor ? sql`having max(created_at) < ${cursor.toISOString()}` : sql``}
    order by last_at desc
    limit ${limit}
  `);
  return rows.map((r) => ({
    actorUserId: r.actor_user_id,
    actorKind: r.actor_kind,
    kind: r.kind,
    propertyId: r.property_id,
    propertyType: r.property_type,
    firstAt: new Date(r.first_at),
    lastAt: new Date(r.last_at),
    rows: Number(r.rows),
    fromCount: Number(r.from_count),
    toCount: Number(r.to_count),
    from: r.old_value,
    to: r.new_value,
    sample: Array.isArray(r.sample) ? r.sample : [],
  }));
}

// ---------------------------------------------------------------------------------- undoing

export type UndoResult = { done: number; skipped: number };

/** The database an entry of a history is about, or null when `entryId` is none (a page version's id, say). */
export async function historyEntryDatabase(entryId: string): Promise<string | null> {
  const key = decodeKey(entryId);
  if (key) return key.db;
  if (!/^[0-9a-f-]{36}$/i.test(entryId)) return null;
  const [found] = await db.select({ databaseId: databaseChange.databaseId }).from(databaseChange).where(eq(databaseChange.id, entryId));
  return found?.databaseId ?? null;
}

/**
 * Undoes one entry of a database's history, as the user (every check of the change it undoes
 * applies, and the undo is itself recorded): a property or view back to its settings before the
 * change (only the settings that change touched), an added one deleted, a deleted one restored,
 * rows back out of the trash or into it, values put back on the rows that still hold what the
 * changes left. `yes`: a ticked checkbox as text, for a type change back (lib/convert-property).
 */
export async function undoHistoryEntry(userId: string, databaseId: string, entryId: string, { yes = "Yes" }: { yes?: string } = {}): Promise<UndoResult> {
  await databaseAccess(userId, databaseId);
  const key = decodeKey(entryId);
  if (key && key.db !== databaseId) throw withCode(new Error("No such history entry"), "historyEntryGone");
  if (key) return undoValues(userId, databaseId, key);
  const [change] = await db
    .select()
    .from(databaseChange)
    .where(and(eq(databaseChange.id, entryId), eq(databaseChange.databaseId, databaseId)));
  if (!change) throw withCode(new Error("No such history entry"), "historyEntryGone");
  const target = change.targetId;
  switch (change.kind) {
    case "property_added":
    case "property_restored":
      await deleteProperty(userId, target!);
      return { done: 1, skipped: 0 };
    case "property_deleted":
      await restoreProperty(userId, target!);
      return { done: 1, skipped: 0 };
    case "property_changed":
      return undoPropertyChange(userId, databaseId, target!, change.before as PropertySnapshot, change.after as PropertySnapshot, change.changedValues, yes);
    case "view_added":
    case "view_restored":
      await deleteView(userId, target!);
      return { done: 1, skipped: 0 };
    case "view_deleted":
      await restoreView(userId, target!);
      return { done: 1, skipped: 0 };
    case "view_changed":
      return undoViewChange(userId, target!, change.before as ViewSnapshot, change.after as ViewSnapshot);
    case "rows_trashed": {
      let done = 0;
      const rows = rowsOf(change.after);
      for (const row of rows) {
        try {
          const [now] = await db.select({ archivedAt: page.archivedAt, parentId: page.parentId }).from(page).where(eq(page.id, row.id));
          if (!now?.archivedAt || now.parentId !== databaseId) continue;
          await restorePage(userId, row.id);
          done++;
        } catch (error) {
          if (!(error instanceof AccessError)) throw error;
        }
      }
      return { done, skipped: rows.length - done };
    }
    case "rows_restored": {
      const rows = rowsOf(change.after);
      const { done } = await archiveRows(userId, databaseId, rows.map((r) => r.id));
      return { done: done.length, skipped: rows.length - done.length };
    }
  }
}

/** The settings a change touched taken back to what they were; the others stay as they are now. */
function touchedBack(current: PropertySnapshot, before: PropertySnapshot, after: PropertySnapshot): PropertySnapshot {
  const options: Record<string, unknown> = { ...current.options };
  const keys = new Set([...Object.keys(before.options), ...Object.keys(after.options)]) as Set<keyof PropertySnapshot["options"]>;
  for (const k of keys) {
    if (JSON.stringify(before.options[k] ?? null) === JSON.stringify(after.options[k] ?? null)) continue;
    if (before.options[k] === undefined) delete options[k];
    else options[k] = before.options[k];
  }
  return {
    name: before.name !== after.name ? before.name : current.name,
    type: before.type !== after.type ? before.type : current.type,
    options: options as PropertySnapshot["options"],
  };
}

async function undoPropertyChange(
  userId: string,
  databaseId: string,
  propertyId: string,
  before: PropertySnapshot,
  after: PropertySnapshot,
  changedValues: ChangedValues | null,
  yes: string,
): Promise<UndoResult> {
  const [prop] = await db.select().from(databaseProperty).where(and(eq(databaseProperty.id, propertyId), isNull(databaseProperty.deletedAt)));
  if (!prop) throw new AccessError();
  const current = propertySnapshot(prop);
  const target = touchedBack(current, before, after);
  const { type, patch } = restorePatch(current, target);
  if (type) {
    await changePropertyType(userId, propertyId, {
      type,
      yes,
      ...(target.options.relation ? { relation: { databaseId: target.options.relation.databaseId } } : {}),
      ...(target.options.formula ? { formula: { expression: target.options.formula.expression } } : {}),
      ...(target.options.rollup
        ? {
            rollup: {
              relationPropertyId: target.options.rollup.relationPropertyId,
              targetPropertyId: target.options.rollup.targetPropertyId,
              function: target.options.rollup.function,
            },
          }
        : {}),
    });
    // The type's own settings come with it; what is left are the others.
    const [retyped] = await db.select().from(databaseProperty).where(eq(databaseProperty.id, propertyId));
    const rest = restorePatch(propertySnapshot(retyped), target).patch;
    if (Object.keys(rest).length) await updateProperty(userId, propertyId, rest);
  } else if (Object.keys(patch).length) {
    await updateProperty(userId, propertyId, patch);
  }
  if (!changedValues) return { done: 1, skipped: 0 };
  const { done, skipped } = await putValuesBack(
    userId,
    databaseId,
    propertyId,
    Object.entries(changedValues).map(([rowId, [was, left]]) => ({ rowId, was, left })),
  );
  return { done: 1 + done, skipped };
}

async function undoViewChange(userId: string, viewId: string, before: ViewSnapshot, after: ViewSnapshot): Promise<UndoResult> {
  const [view] = await db.select().from(databaseView).where(and(eq(databaseView.id, viewId), isNull(databaseView.deletedAt)));
  if (!view) throw new AccessError();
  const config: Record<string, unknown> = { ...view.config };
  const keys = new Set([...Object.keys(before.config), ...Object.keys(after.config)]) as Set<keyof ViewSnapshot["config"]>;
  for (const k of keys) {
    if (JSON.stringify(before.config[k] ?? null) === JSON.stringify(after.config[k] ?? null)) continue;
    if (before.config[k] === undefined) delete config[k];
    else config[k] = before.config[k];
  }
  await updateView(userId, viewId, {
    ...(before.name !== after.name ? { name: before.name } : {}),
    ...(before.type !== after.type ? { type: before.type } : {}),
    config: config as ViewSnapshot["config"],
  });
  return { done: 1, skipped: 0 };
}

/**
 * Writes each row's value `was` back where it still holds `left`, what the change left there
 * (nothing else changed it since), as the user: rows they can't change are skipped like rows that
 * changed again. Values kept masked (lib/redact) aren't written back.
 */
async function putValuesBack(userId: string, databaseId: string, propertyId: string, rows: { rowId: string; was: unknown; left: unknown }[]): Promise<UndoResult> {
  if (!rows.length) return { done: 0, skipped: 0 };
  const current = new Map<string, unknown>();
  for (let i = 0; i < rows.length; i += 1000) {
    const found = await db
      .select({ id: page.id, value: sql<unknown>`${page.properties} -> ${propertyId}::text` })
      .from(page)
      .where(and(inArray(page.id, rows.slice(i, i + 1000).map((r) => r.rowId)), eq(page.parentId, databaseId), isNull(page.archivedAt)));
    for (const r of found) current.set(r.id, r.value);
  }
  const byValue = new Map<string, { value: unknown; rowIds: string[] }>();
  for (const { rowId, was, left } of rows) {
    if (!current.has(rowId) || !sameValue(current.get(rowId), left)) continue;
    if (JSON.stringify(was ?? null).includes(REDACTED)) continue;
    const key = JSON.stringify(storedValue(was));
    const entry = byValue.get(key) ?? { value: storedValue(was), rowIds: [] };
    entry.rowIds.push(rowId);
    byValue.set(key, entry);
  }
  let done = 0;
  for (const { value, rowIds } of byValue.values()) {
    for (let i = 0; i < rowIds.length; i += 500) {
      const result = await updateRowsProperties(userId, databaseId, rowIds.slice(i, i + 500), { [propertyId]: value });
      done += result.done.length;
    }
  }
  return { done, skipped: rows.length - done };
}

/** Undoes a group of row value changes: values put back, or the rows it made put in the trash. */
async function undoValues(userId: string, databaseId: string, key: GroupKey): Promise<UndoResult> {
  if (key.kind === "title") throw withCode(new Error("Titles are brought back from each row's page history"), "historyNotUndoable");
  const entries = await db
    .select({ rowId: rowActivity.rowId, oldValue: rowActivity.oldValue, newValue: rowActivity.newValue })
    .from(rowActivity)
    .where(
      and(
        eq(rowActivity.databaseId, databaseId),
        key.actor ? eq(rowActivity.actorUserId, key.actor) : isNull(rowActivity.actorUserId),
        eq(rowActivity.actorKind, key.actorKind),
        eq(rowActivity.kind, key.kind),
        key.property ? eq(rowActivity.propertyId, key.property) : isNull(rowActivity.propertyId),
        isNull(rowActivity.mergedFromId),
        sql`${rowActivity.createdAt} between ${key.from} and ${key.to}`,
      ),
    )
    .orderBy(asc(rowActivity.createdAt));
  if (!entries.length) throw withCode(new Error("No such history entry"), "historyEntryGone");
  if (key.kind === "created") {
    const rowIds = [...new Set(entries.map((e) => e.rowId))];
    const { done } = await archiveRows(userId, databaseId, rowIds);
    return { done: done.length, skipped: rowIds.length - done.length };
  }
  // Each row: its value before the first change, and what the last one left.
  const byRow = new Map<string, { was: unknown; left: unknown }>();
  for (const e of entries) {
    const known = byRow.get(e.rowId);
    byRow.set(e.rowId, { was: known ? known.was : e.oldValue, left: e.newValue });
  }
  return putValuesBack(
    userId,
    databaseId,
    key.property!,
    [...byRow].map(([rowId, v]) => ({ rowId, ...v })),
  );
}

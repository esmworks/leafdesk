import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { databaseProperty, page } from "@/db/schema";
import { sortStatusOptions, statusColor } from "@/lib/properties";
import type { PropertyType, StatusGroup } from "@/lib/property-types";
import { AccessError } from "@/server/access";
import { afterRowWrites, makeOption, mergedProperties, notifyRows, type DatabaseProperty } from "@/server/databases";
import { writeIds } from "@/server/import/board";
import { checkValues, writeRows } from "@/server/import/csv";
import { JiraError } from "@/server/jira-sync/client";
import { renamePage } from "@/server/pages";
import { rowChanged } from "@/server/row-events";
import { dropRepeatedValues, withUniqueValues } from "@/server/unique-values";

/**
 * Writing what a synced database's source has (Jira issues, GitHub pull requests; see
 * server/jira-sync/run for the runs) into its rows, as whoever the sync runs as. Rows are found by
 * the key property: a new item adds a row, a known one gets its title and the synced properties
 * written over; rows in the trash are left there, and rows whose item no longer comes stay as they
 * are. New rows are added like an import's, so a first run doesn't tell everyone of their old
 * assignments; changes on later runs go through afterRowWrites (activity, followers, automations,
 * a new assignee's notice).
 */

export type SyncedDatabase = { id: string; workspaceId: string; inTemplate: boolean };

/** One item as a row: found again by `key` (the key property's value, as text). */
export type SyncedItem = {
  key: string;
  title: string;
  /** The synced properties' values, as normalizeRowProperties takes them (null clears one). */
  values: Record<string, unknown>;
  /** Only keeps a row it has in step, never adds one (closed pull requests of an open-only sync). */
  onlyUpdate?: boolean;
};

/**
 * The mapping's properties that still exist with the type each needs; a run without its key
 * property can't go on ("keyGone").
 */
export function liveFields<F extends string>(
  mapping: Partial<Record<F, string>>,
  types: Record<F, PropertyType>,
  keyField: F,
  props: DatabaseProperty[],
): Partial<Record<F, string>> {
  const live: Partial<Record<F, string>> = {};
  for (const field of Object.keys(types) as F[]) {
    const id = mapping[field];
    if (id && props.some((p) => p.id === id && p.type === types[field])) live[field] = id;
  }
  if (!live[keyField]) throw new JiraError("keyGone", "The key property is gone");
  return live;
}

/** Adds the options a run needs that a select, status or multi-select doesn't have yet. */
export async function addOptions(prop: DatabaseProperty | undefined, wanted: { name: string; group?: StatusGroup }[]) {
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
 * Writes items into the database as `runAs` (who must be able to edit it). `keyId` is the key
 * property, `props` the database's properties (with the options the items need), `deferred` the
 * person properties new rows get afterwards, unannounced. Returns how many rows it added and changed.
 */
export async function applyRows(
  database: SyncedDatabase,
  runAs: string,
  keyId: string,
  items: SyncedItem[],
  props: DatabaseProperty[],
  deferred: string[],
) {
  const stored = await db
    .select({ id: page.id, title: page.title, properties: page.properties, archivedAt: page.archivedAt, createdBy: page.createdBy })
    .from(page)
    .where(and(eq(page.parentId, database.id), eq(page.isTemplate, false)));
  // A key's row: one out of the trash first (two rows with a key: the first is kept in step). A
  // number key (a pull request's) is matched as its text.
  const byKey = new Map<string, (typeof stored)[number]>();
  for (const row of stored) {
    const value = row.properties[keyId];
    const key = typeof value === "string" || typeof value === "number" ? String(value) : "";
    if (!key) continue;
    const known = byKey.get(key);
    if (!known || (known.archivedAt && !row.archivedAt)) byKey.set(key, row);
  }

  const invalid = new Map<string, number>();
  const fresh: { title: string; properties: Record<string, unknown>; people: Record<string, string[]>; keyed: boolean }[] = [];
  const known: { existing: (typeof stored)[number]; properties: Record<string, unknown> }[] = [];
  // Every value written, in the items' order, for the unique properties' check below.
  const batch: { rowId?: string; properties: Record<string, unknown> }[] = [];
  const changes: { rowId: string; before: Record<string, unknown>; after: Record<string, unknown>; patch: Record<string, unknown> }[] = [];
  const renames: { id: string; title: string }[] = [];
  const done = new Set<string>();
  for (const item of items) {
    if (done.has(item.key)) continue;
    done.add(item.key);
    const existing = byKey.get(item.key);
    if (existing?.archivedAt || (!existing && item.onlyUpdate)) continue;
    if (!existing) {
      const normalized = await checkValues(runAs, database.id, item.values, props, invalid);
      // Assignments of new rows go in afterwards, unannounced (see above).
      const people: Record<string, string[]> = {};
      for (const id of deferred) {
        if (!Array.isArray(normalized[id])) continue;
        people[id] = normalized[id] as string[];
        delete normalized[id];
      }
      fresh.push({ title: item.title, properties: normalized, people, keyed: keyId in normalized });
      batch.push({ properties: normalized });
      continue;
    }
    const normalized = await checkValues(runAs, database.id, item.values, props, invalid, existing);
    known.push({ existing, properties: normalized });
    batch.push({ rowId: existing.id, properties: normalized });
    if (existing.title.trim() !== item.title.trim()) renames.push({ id: existing.id, title: item.title });
  }
  // A value a unique property would refuse (another row's, or one an earlier item takes: two
  // emails differing only in case) is left out like any other before anything is written, so one
  // such item doesn't stop every run at the same row.
  await dropRepeatedValues(database.id, batch, invalid);
  // A new row whose key was refused couldn't be found again, and every run would add it anew.
  const added = fresh.filter((row) => !row.keyed || keyId in row.properties);
  for (const { existing, properties: normalized } of known) {
    const patch = Object.fromEntries(Object.entries(normalized).filter(([id, value]) => !same(existing.properties[id], value)));
    if (Object.keys(patch).length) {
      const after = { ...existing.properties };
      for (const [id, value] of Object.entries(patch)) {
        if (value === null) delete after[id];
        else after[id] = value;
      }
      changes.push({ rowId: existing.id, before: existing.properties, after, patch });
    }
  }

  if (added.length) {
    const created = await writeRows(database, runAs, added.map(({ title, properties }) => ({ title, properties })));
    for (const propertyId of deferred) {
      const assigned = added.flatMap((row, i) => (row.people[propertyId] ? [{ id: created[i].id, ids: row.people[propertyId] }] : []));
      if (assigned.length) await writeIds(propertyId, assigned);
    }
  }
  // The changed rows together: all written, or (another write taking a unique value meanwhile) none.
  if (changes.length) {
    await withUniqueValues(() =>
      db.transaction(async (tx) => {
        for (const { rowId, patch } of changes) {
          const set = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== null));
          const cleared = Object.keys(patch).filter((k) => patch[k] === null);
          // Merged in SQL: a value someone else wrote meanwhile to a property the sync doesn't touch stays.
          await tx.update(page).set({ properties: mergedProperties(set, cleared), updatedBy: runAs }).where(eq(page.id, rowId));
        }
      }),
    );
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
  if (added.length || changes.length) notifyRows(database.id);
  for (const { rowId } of changes) rowChanged({ rowId, databaseId: database.id, userId: runAs });
  return { created: added.length, updated: new Set([...changes.map((c) => c.rowId), ...renames.map((r) => r.id)]).size };
}

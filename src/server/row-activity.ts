/**
 * Records database rows' activity (see lib/row-activity.ts and the `row_activity` table): what
 * every saved row write changed (databases.afterRowWrites, which all value writes go through) and
 * title changes (saves of the row's document, collab/service.ts). Nothing here throws: activity
 * never holds back or fails the write it records. Reading is server/row-activity-feed.ts.
 */

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { databaseProperty, page, rowActivity } from "@/db/schema";
import { redactError, redactValue } from "@/lib/redact";
import {
  changedProperties,
  coalesce,
  storedValue,
  type OpenEntry,
  type RowActivityActor,
  type RowActivityKind,
} from "@/lib/row-activity";
import type { PropertyType } from "@/lib/property-types";
import { isAgentUser } from "@/server/agents/users";
import { runningAutomation } from "@/server/automations/queue";

type RowWrite = { rowId: string; before: Record<string, unknown>; after: Record<string, unknown> };

type NewEntry = {
  rowId: string;
  kind: RowActivityKind;
  propertyId: string | null;
  propertyType: PropertyType | null;
  oldValue: unknown;
  newValue: unknown;
};

const CHUNK = 500;

/**
 * Who a write is by. An agent's writes run as automations do (so they start none), and still read
 * as the agent's; nobody named is an anonymous form answer when it made the row.
 */
async function actorKindOf(actorId: string | null, anonymousForm: boolean): Promise<RowActivityActor> {
  if (!actorId) return anonymousForm ? "form" : "user";
  if (await isAgentUser(actorId)) return "agent";
  return runningAutomation() ? "automation" : "user";
}

/**
 * Records what saved row writes changed. New rows get one "created" entry each, whatever values
 * they came with (imports, forms, templates alike). Changes of one row by a named actor merge into
 * that actor's newest entry about the same value when it is recent (lib/row-activity `coalesce`);
 * several rows at once (bulk edits) get one entry per row and value.
 */
export async function recordRowWrites(
  actorId: string | null,
  databaseId: string,
  changes: RowWrite[],
  { created = false, anonymousForm = false }: { created?: boolean; anonymousForm?: boolean } = {},
) {
  if (!changes.length) return;
  try {
    const [database] = await db.select({ workspaceId: page.workspaceId }).from(page).where(eq(page.id, databaseId));
    if (!database) return;
    const actorKind = await actorKindOf(actorId, anonymousForm);
    if (created) {
      const entries = changes.map(({ rowId }) => createdEntry(rowId));
      await insertEntries(database.workspaceId, databaseId, actorId, actorKind, entries);
      return;
    }
    const properties = await db
      .select({ id: databaseProperty.id, type: databaseProperty.type })
      .from(databaseProperty)
      .where(and(eq(databaseProperty.databaseId, databaseId), isNull(databaseProperty.deletedAt)));
    const entries: NewEntry[] = changes.flatMap(({ rowId, before, after }) =>
      changedProperties(before, after, properties).map((c) => ({
        rowId,
        kind: "property" as const,
        propertyId: c.propertyId,
        propertyType: c.propertyType,
        oldValue: c.oldValue,
        newValue: c.newValue,
      })),
    );
    await save(database.workspaceId, databaseId, actorId, actorKind, entries, changes.length === 1);
  } catch (error) {
    console.error("[row-activity] recording row writes failed", redactError(error));
  }
}

const createdEntry = (rowId: string): NewEntry => ({
  rowId,
  kind: "created",
  propertyId: null,
  propertyType: null,
  oldValue: null,
  newValue: null,
});

/**
 * Records a database row's new title, from a save of its document by `userId` (null when nobody is
 * known). Pages that aren't rows, and row templates, are left alone.
 */
export async function recordTitleChange(rowId: string, before: string, after: string, userId: string | null) {
  if (before === after) return;
  try {
    const parent = alias(page, "parent");
    const [row] = await db
      .select({
        workspaceId: page.workspaceId,
        databaseId: page.parentId,
        isTemplate: page.isTemplate,
        inTemplate: page.inTemplate,
        parentKind: parent.kind,
      })
      .from(page)
      .innerJoin(parent, eq(parent.id, page.parentId))
      .where(eq(page.id, rowId));
    if (!row?.databaseId || row.parentKind !== "database" || row.isTemplate || row.inTemplate) return;
    const actorKind = await actorKindOf(userId, false);
    const entry: NewEntry = { rowId, kind: "title", propertyId: null, propertyType: null, oldValue: before, newValue: after };
    await save(row.workspaceId, row.databaseId, userId, actorKind, [entry], true);
  } catch (error) {
    console.error("[row-activity] recording a title failed", redactError(error));
  }
}

/** Writes entries, merging them into recent ones of the same actor first when `merge` (one row). */
async function save(
  workspaceId: string,
  databaseId: string,
  actorId: string | null,
  actorKind: RowActivityActor,
  entries: NewEntry[],
  merge: boolean,
) {
  if (!entries.length) return;
  const now = new Date();
  let fresh = entries;
  if (merge && actorId) {
    const [rowId] = entries.map((e) => e.rowId);
    const latest = await latestEntries(rowId, entries);
    fresh = [];
    const drop: string[] = [];
    for (const entry of entries) {
      const open = latest.get(keyOf(entry)) ?? null;
      const decision = coalesce(open, { actorUserId: actorId, actorKind, newValue: entry.newValue }, now);
      if (decision.action === "insert") fresh.push(entry);
      else if (decision.action === "drop") drop.push(decision.id);
      else {
        await db
          .update(rowActivity)
          .set({ newValue: redactValue(storedValue(entry.newValue)), propertyType: entry.propertyType, createdAt: now })
          .where(eq(rowActivity.id, decision.id));
      }
    }
    if (drop.length) await db.delete(rowActivity).where(inArray(rowActivity.id, drop));
  }
  await insertEntries(workspaceId, databaseId, actorId, actorKind, fresh, now);
}

const keyOf = (entry: { kind: RowActivityKind; propertyId: string | null }) => `${entry.kind}:${entry.propertyId ?? ""}`;

/** The newest entry of the row about each value `entries` change, by kind and property. */
async function latestEntries(rowId: string, entries: NewEntry[]): Promise<Map<string, OpenEntry>> {
  const propertyIds = entries.flatMap((e) => (e.propertyId ? [e.propertyId] : []));
  const titled = entries.some((e) => e.kind === "title");
  const rows = await db
    .selectDistinctOn([rowActivity.kind, rowActivity.propertyId], {
      id: rowActivity.id,
      kind: rowActivity.kind,
      propertyId: rowActivity.propertyId,
      actorUserId: rowActivity.actorUserId,
      actorKind: rowActivity.actorKind,
      oldValue: rowActivity.oldValue,
      at: rowActivity.createdAt,
    })
    .from(rowActivity)
    .where(
      and(
        eq(rowActivity.rowId, rowId),
        sql`(${propertyIds.length ? inArray(rowActivity.propertyId, propertyIds) : sql`false`} or ${titled ? sql`${rowActivity.kind} = 'title'` : sql`false`})`,
      ),
    )
    .orderBy(rowActivity.kind, rowActivity.propertyId, desc(rowActivity.createdAt), desc(rowActivity.id));
  return new Map(rows.map((r) => [keyOf(r), r]));
}

async function insertEntries(
  workspaceId: string,
  databaseId: string,
  actorId: string | null,
  actorKind: RowActivityActor,
  entries: NewEntry[],
  at: Date = new Date(),
) {
  for (let i = 0; i < entries.length; i += CHUNK) {
    await db.insert(rowActivity).values(
      entries.slice(i, i + CHUNK).map((e) => ({
        rowId: e.rowId,
        databaseId,
        workspaceId,
        actorUserId: actorId,
        actorKind,
        kind: e.kind,
        propertyId: e.propertyId,
        propertyType: e.propertyType,
        // Text people type can hold credentials: kept masked, like the audit log's values.
        oldValue: redactValue(storedValue(e.oldValue)),
        newValue: redactValue(storedValue(e.newValue)),
        createdAt: at,
      })),
    );
  }
}

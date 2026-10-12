/**
 * Reading a database row's activity (lib/row-activity.ts; recorded by server/row-activity.ts),
 * for the row page, MCP and the REST API alike. Whoever can open the row reads it (a row in the
 * trash too, for those who see it there); entries about properties they may not see in it, and
 * about deleted ones, are left out, and stored ids read as names they may see.
 */

import { and, asc, count, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { databaseProperty, page, rowActivity, user, type PropertyType } from "@/db/schema";
import { avatarSrc } from "@/lib/avatar";
import {
  MAX_ACTIVITY_PAGE,
  readableProperties,
  referencedIds,
  resolveValue,
  type ActivityLookups,
  type ActivityPerson,
  type ActivityValue,
  type RowActivityActor,
  type RowActivityKind,
} from "@/lib/row-activity";
import { pageVisibleTo, requirePageAccess } from "@/server/access";
import { agentMarks } from "@/server/agents/users";
import { requireDatabase, withCode } from "@/server/databases";
import { propertyAccessFor } from "@/server/property-access";

export type RowActivityEntry = {
  id: string;
  kind: RowActivityKind;
  /** When it happened; for merged changes, the last of them. ISO 8601. */
  at: string;
  actor: { kind: RowActivityActor; person: ActivityPerson | null };
  /** The property a `property` entry is about. */
  property: { id: string; name: string; type: PropertyType } | null;
  /** The value before and after, for `title` and `property` entries. */
  from: ActivityValue | null;
  to: ActivityValue | null;
};

export type RowActivityList = { entries: RowActivityEntry[]; total: number; hasMore: boolean };

export { MAX_ACTIVITY_PAGE };

/**
 * `limit` entries of a row's activity from `offset` on, newest first. Rows made before activity
 * was recorded, or copied, end with a "created" entry made from who created them and when.
 */
export async function listRowActivity(
  userId: string,
  rowId: string,
  { offset = 0, limit = 20 }: { offset?: number; limit?: number } = {},
): Promise<RowActivityList> {
  const row = await requirePageAccess(userId, rowId, "view");
  if (!row.parentId) throw withCode(new Error("Page is not a database row"), "notADatabaseRow");
  await requireDatabase(userId, row.parentId, "view");
  limit = Math.min(Math.max(1, Math.trunc(limit)), MAX_ACTIVITY_PAGE);
  offset = Math.max(0, Math.trunc(offset));

  const [properties, access] = await Promise.all([
    db
      .select({
        id: databaseProperty.id,
        name: databaseProperty.name,
        type: databaseProperty.type,
        options: databaseProperty.options,
        deletedAt: databaseProperty.deletedAt,
      })
      .from(databaseProperty)
      .where(eq(databaseProperty.databaseId, row.parentId))
      .orderBy(asc(databaseProperty.position)),
    propertyAccessFor(userId, row.parentId),
  ]);
  const readable = readableProperties(properties, access, row);

  const shown = and(
    eq(rowActivity.rowId, rowId),
    readable.size ? or(ne(rowActivity.kind, "property"), inArray(rowActivity.propertyId, [...readable])) : ne(rowActivity.kind, "property"),
  );
  const [[totals], stored] = await Promise.all([
    db
      .select({ stored: count(), hasCreated: sql<boolean>`coalesce(bool_or(${rowActivity.kind} = 'created'), false)` })
      .from(rowActivity)
      .where(shown),
    db
      .select()
      .from(rowActivity)
      .where(shown)
      .orderBy(desc(rowActivity.createdAt), desc(rowActivity.id))
      .limit(limit)
      .offset(offset),
  ]);
  const total = totals.stored + (totals.hasCreated ? 0 : 1);
  const listed: (typeof stored)[number][] = [...stored];
  if (!totals.hasCreated && offset + limit > totals.stored && offset <= totals.stored) {
    listed.push({
      id: `created:${row.id}`,
      rowId: row.id,
      databaseId: row.parentId,
      workspaceId: row.workspaceId,
      actorUserId: row.createdBy,
      actorKind: "user",
      kind: "created",
      propertyId: null,
      propertyType: null,
      oldValue: null,
      newValue: null,
      createdAt: row.createdAt,
    });
  }

  const byId = new Map(properties.map((p) => [p.id, p]));
  const values = listed.flatMap((e) => [
    { type: e.propertyType, value: e.oldValue },
    { type: e.propertyType, value: e.newValue },
  ]);
  const ids = referencedIds(values);
  const lookups = await loadLookups(userId, [...ids.people, ...listed.flatMap((e) => (e.actorUserId ? [e.actorUserId] : []))], [...ids.pages]);
  const entries = listed.map((e): RowActivityEntry => {
    const prop = e.propertyId ? byId.get(e.propertyId) : undefined;
    const options = prop?.options.options ?? [];
    const read = (value: unknown) =>
      e.kind === "title" ? resolveValue("text", [], value, lookups) : resolveValue(e.propertyType ?? prop?.type ?? null, options, value, lookups);
    const person = e.actorUserId ? (lookups.people.get(e.actorUserId) ?? null) : null;
    return {
      id: e.id,
      kind: e.kind,
      at: e.createdAt.toISOString(),
      // The "created" entry made up for older rows knows only who created them.
      actor: { kind: e.actorKind === "user" && person?.isAgent ? "agent" : e.actorKind, person },
      property: prop ? { id: prop.id, name: prop.name, type: prop.type } : null,
      from: e.kind === "created" ? null : read(e.oldValue),
      to: e.kind === "created" ? null : read(e.newValue),
    };
  });
  return { entries, total, hasMore: offset + listed.length < total };
}

async function loadLookups(viewerId: string, userIds: string[], pageIds: string[]): Promise<ActivityLookups> {
  const people = [...new Set(userIds)];
  const pages = [...new Set(pageIds)];
  const [users, marks, linked] = await Promise.all([
    people.length
      ? db.select({ id: user.id, name: user.name, image: user.image }).from(user).where(inArray(user.id, people))
      : Promise.resolve([]),
    agentMarks(people),
    // Linked rows the viewer can't open read as "no access", never by title.
    pages.length
      ? db
          .select({ id: page.id, title: page.title, icon: page.icon })
          .from(page)
          .where(and(inArray(page.id, pages), pageVisibleTo(viewerId)))
      : Promise.resolve([]),
  ]);
  return {
    people: new Map(
      users.map((u) => {
        const mark = marks.get(u.id);
        const person: ActivityPerson = { id: u.id, name: u.name, image: avatarSrc(u.image) };
        return [u.id, mark ? { ...person, isAgent: true as const, agentIcon: mark.agentIcon } : person];
      }),
    ),
    pages: new Map(linked.map((p) => [p.id, { title: p.title, icon: p.icon }])),
  };
}

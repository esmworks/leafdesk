import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { databaseProperty, page, type PageKind, type SelectOption } from "@/db/schema";
import { groupAssigned, type AssignedGroupKey } from "@/lib/assigned";
import { dateDays } from "@/lib/date-value";
import { atLeast } from "@/lib/property-access";
import { firstDoneOption, isDoneStatus, optionOf } from "@/lib/properties";
import { dayString } from "@/lib/time-zone";
import { accessRank, childVisibleTo, hasLevel, levelFromRank, pageVisibleTo, requireMembership, requirePageAccess } from "@/server/access";
import { updateRowProperties } from "@/server/databases";
import { loadProperties } from "@/server/derived";
import { openPageTasks, type AssignedPageTask } from "@/server/page-tasks";
import { propertyAccessFor } from "@/server/property-access";

/** How many rows the home page lists: enough for a week's work, short enough to keep the page. */
export const ASSIGNED_LIMIT = 25;
/** How many rows the My tasks page lists. */
export const MY_TASKS_LIMIT = 200;
/** How many assigned rows are looked at, last edited first, before done ones are left out. */
export const CANDIDATE_LIMIT = 1000;

export type AssignedRow = {
  type: "row";
  id: string;
  title: string;
  icon: string | null;
  kind: PageKind;
  databaseId: string;
  /** Null when the viewer may open the row but not its database. */
  databaseTitle: string | null;
  /** The first day of the row's first date the viewer may see (`YYYY-MM-DD`), or null. */
  date: string | null;
  /** That date's last day when it is a range, else null. */
  endDate: string | null;
  /** That date's value as stored (a day, a time or a range of either), or null. */
  dateValue: string | null;
  /** The row's first status the viewer may see, or null. */
  status: SelectOption | null;
  /**
   * Whether the viewer may mark the row done from the list: it has a status they may change with
   * an option in the "done" group, and they may edit the row. Only worked out for the rows a list
   * shows (assignedRows); false in what openAssignedRows returns.
   */
  markable: boolean;
  updatedAt: Date;
};

export type { AssignedPageTask };

/** What My tasks and the home page list: a database row, or a to-do in a page (server/page-tasks.ts). */
export type AssignedItem = AssignedRow | AssignedPageTask;

export type AssignedRows = {
  groups: { key: AssignedGroupKey; rows: AssignedItem[] }[];
  /** Every open row and to-do of the viewer's, of which `groups` holds the first ASSIGNED_LIMIT. */
  total: number;
};

/** The page an item is about: the row itself, or the page a to-do is in. */
const pageOf = (item: AssignedItem) => (item.type === "row" ? item.id : item.pageId);

/**
 * The database rows of a workspace that a person property assigns to `userId` and that aren't
 * done, with the unticked to-dos in its pages that mention them (server/page-tasks.ts), grouped by
 * their date relative to `today` (the viewer's calendar day). Only rows and pages the viewer may
 * open count, and only where they may see the person property that names them; a status or date
 * hidden from them neither shows nor decides anything.
 */
export async function assignedRows(
  userId: string,
  workspaceId: string,
  today: string,
  timeZone = "UTC",
  limit = ASSIGNED_LIMIT,
): Promise<AssignedRows> {
  const [rows, tasks] = await Promise.all([
    openAssignedRows(userId, workspaceId, timeZone, { markable: true }),
    openPageTasks(userId, workspaceId, timeZone, { markable: true }),
  ]);
  const items: AssignedItem[] = [...rows, ...tasks];
  // Keep the first items in group order, then group those again.
  const shown = groupAssigned(items, today)
    .flatMap((g) => g.rows)
    .slice(0, limit);
  // Edit access to each row (or to-do's page) shown, in one query (the candidates were only
  // checked for viewing).
  const markable = [...new Set(shown.filter((r) => r.markable).map(pageOf))];
  if (markable.length) {
    const levels = await db
      .select({ id: page.id, level: accessRank(userId, sql`${page.id}`) })
      .from(page)
      .where(inArray(page.id, markable));
    const editable = new Set(levels.filter((l) => hasLevel(levelFromRank(l.level), "content")).map((l) => l.id));
    for (const item of shown) item.markable = item.markable && editable.has(pageOf(item));
  }
  return { groups: groupAssigned(shown, today), total: items.length };
}

/**
 * Every row `assignedRows` counts, ungrouped and with no cap but CANDIDATE_LIMIT, last edited
 * first: for the home page and the feed of assigned rows (see server/calendar-feeds).
 */
export async function openAssignedRows(
  userId: string,
  workspaceId: string,
  timeZone = "UTC",
  { markable: withMarkable = false }: { markable?: boolean } = {},
): Promise<AssignedRow[]> {
  await requireMembership(userId, workspaceId);
  const personProps = await db
    .select({ id: databaseProperty.id, databaseId: databaseProperty.databaseId })
    .from(databaseProperty)
    .innerJoin(page, eq(page.id, databaseProperty.databaseId))
    .where(
      and(
        eq(page.workspaceId, workspaceId),
        eq(page.kind, "database"),
        eq(databaseProperty.type, "person"),
        isNull(databaseProperty.deletedAt),
        isNull(page.archivedAt),
        eq(page.inTemplate, false),
      ),
    );
  if (!personProps.length) return [];
  const byDatabase = new Map<string, string[]>();
  for (const p of personProps) byDatabase.set(p.databaseId, [...(byDatabase.get(p.databaseId) ?? []), p.id]);

  const me = JSON.stringify([userId]);
  // Without JIT: the access check's estimate (page_access_level per row) makes Postgres compile
  // the query, which takes several times what running it does (200 ms against 45 on 50,000 rows).
  const candidates = await db.transaction(async (tx) => {
    await tx.execute(sql`set local jit = off`);
    return tx
      .select({
        id: page.id,
        title: page.title,
        icon: page.icon,
        kind: page.kind,
        parentId: page.parentId,
        properties: page.properties,
        createdBy: page.createdBy,
        updatedAt: page.updatedAt,
      })
      .from(page)
      .where(
        and(
          eq(page.workspaceId, workspaceId),
          isNull(page.archivedAt),
          eq(page.isTemplate, false),
          eq(page.inTemplate, false),
          // Access is worked out once per database for rows that have no sharing of their own
          // (childVisibleTo): asking for each row assigned to them took 0.45 s on 50,000 rows.
          or(
            ...[...byDatabase].map(([databaseId, propertyIds]) =>
              and(
                eq(page.parentId, databaseId),
                or(...propertyIds.map((id) => sql`(${page.properties} -> ${id}) @> ${me}::jsonb`)),
                childVisibleTo(userId, databaseId),
              ),
            ),
          ),
        ),
      )
      .orderBy(desc(page.updatedAt))
      .limit(CANDIDATE_LIMIT);
  });
  if (!candidates.length) return [];

  const databaseIds = [...new Set(candidates.map((r) => r.parentId!))];
  const [properties, databases, accessList] = await Promise.all([
    loadProperties(databaseIds),
    // A row can be shared without its database: then the database's name stays hidden too.
    db
      .select({ id: page.id, title: page.title })
      .from(page)
      .where(and(inArray(page.id, databaseIds), pageVisibleTo(userId))),
    Promise.all(databaseIds.map(async (id) => [id, await propertyAccessFor(userId, id)] as const)),
  ]);
  const titles = new Map(databases.map((d) => [d.id, d.title]));
  const access = new Map(accessList);

  const rows: AssignedRow[] = [];
  for (const row of candidates) {
    const databaseId = row.parentId!;
    const props = properties.get(databaseId) ?? [];
    const levels = access.get(databaseId)!;
    const sees = (propertyId: string) => atLeast(levels.levelOf(propertyId, row), "view");
    const value = (propertyId: string) => row.properties[propertyId];

    const namesMe = props.some(
      (p) => p.type === "person" && sees(p.id) && Array.isArray(value(p.id)) && (value(p.id) as unknown[]).includes(userId),
    );
    if (!namesMe) continue;

    const statuses = props.filter((p) => p.type === "status" && sees(p.id));
    if (statuses.some((p) => isDoneStatus(p, value(p.id)))) continue;
    // The status shown is the one marking it done changes.
    const statusProp = statuses.find((p) => optionOf(p, value(p.id))) ?? statuses[0];

    const dateProp = props.find((p) => p.type === "date" && sees(p.id) && dateDays(value(p.id), timeZone));
    // Times count on their day in the viewer's zone.
    const days = dateProp ? dateDays(value(dateProp.id), timeZone) : null;
    rows.push({
      type: "row",
      id: row.id,
      title: row.title,
      icon: row.icon,
      kind: row.kind,
      databaseId,
      databaseTitle: titles.get(databaseId) ?? null,
      date: days ? dayString(days.start) : null,
      endDate: days && days.end > days.start ? dayString(days.end) : null,
      dateValue: dateProp ? (value(dateProp.id) as string) : null,
      status: statusProp ? (optionOf(statusProp, value(statusProp.id)) ?? null) : null,
      markable:
        withMarkable && statusProp !== undefined && firstDoneOption(statusProp) !== undefined && atLeast(levels.levelOf(statusProp.id, row), "edit"),
      updatedAt: row.updatedAt,
    });
  }
  return rows;
}

/**
 * Marks a row assigned to the user done from their list: its status (the first they may see that
 * has a value, else the first they may see) goes to the first option of its "done" group, written
 * the way any change of a row's values is (property access, automations, activity). Returns the
 * property and the option it had, to put it back.
 */
export async function markAssignedDone(userId: string, rowId: string) {
  const row = await requirePageAccess(userId, rowId, "content");
  if (!row.parentId) throw new AssignedRowError("noStatus");
  const props = (await loadProperties([row.parentId])).get(row.parentId) ?? [];
  const levels = await propertyAccessFor(userId, row.parentId);
  const statuses = props.filter((p) => p.type === "status" && atLeast(levels.levelOf(p.id, row), "view"));
  const statusProp = statuses.find((p) => optionOf(p, row.properties[p.id])) ?? statuses[0];
  const done = statusProp && firstDoneOption(statusProp);
  if (!statusProp || !done) throw new AssignedRowError("noStatus");
  const previous = typeof row.properties[statusProp.id] === "string" ? (row.properties[statusProp.id] as string) : null;
  if (!isDoneStatus(statusProp, previous)) await updateRowProperties(userId, rowId, { [statusProp.id]: done.id });
  return { propertyId: statusProp.id, previous };
}

/** A row that can't be marked done from the list: it has no status with a "done" option. */
export class AssignedRowError extends Error {
  constructor(readonly code: "noStatus") {
    super("This row has no status that can be marked done");
    this.name = "AssignedRowError";
  }
}

import { dayNumber } from "@/lib/time-zone";

/** Where a row assigned to someone falls on their home page, by its date and today's. */
export type AssignedGroupKey = "overdue" | "today" | "next7" | "later" | "none";

export const ASSIGNED_GROUPS: AssignedGroupKey[] = ["overdue", "today", "next7", "later", "none"];

/** Days after today that still count as "next 7 days". */
const SOON_DAYS = 7;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The group of a row due on `date` (`YYYY-MM-DD`, or null for none) when it is `today`. A row whose
 * date runs to `end` (a range) is due today while today is within it, and overdue once it ended.
 */
export function assignedGroup(date: string | null, today: string, end?: string | null): AssignedGroupKey {
  if (!date || !DAY.test(date)) return "none";
  const last = end && DAY.test(end) && end > date ? end : date;
  if (dayNumber(last) < dayNumber(today)) return "overdue";
  const days = Math.max(0, dayNumber(date) - dayNumber(today));
  if (days === 0) return "today";
  if (days <= SOON_DAYS) return "next7";
  return "later";
}

/**
 * The rows in their groups, in group order and without empty groups. Within a group the earliest
 * date comes first, then the row edited last.
 */
export function groupAssigned<R extends { date: string | null; endDate?: string | null; updatedAt: Date }>(
  rows: R[],
  today: string,
): { key: AssignedGroupKey; rows: R[] }[] {
  const byGroup = new Map<AssignedGroupKey, R[]>(ASSIGNED_GROUPS.map((key) => [key, []]));
  for (const row of rows) byGroup.get(assignedGroup(row.date, today, row.endDate))!.push(row);
  return ASSIGNED_GROUPS.map((key) => ({
    key,
    rows: byGroup.get(key)!.sort(
      (a, b) => (a.date ?? "").localeCompare(b.date ?? "") || b.updatedAt.getTime() - a.updatedAt.getTime(),
    ),
  })).filter((g) => g.rows.length > 0);
}

/**
 * How a list of assigned rows is grouped: by when they are due, or by the database they are in (a
 * to-do written in a page: by that page).
 */
export type AssignedGrouping = "due" | "database";

export const isAssignedGrouping = (value: unknown): value is AssignedGrouping => value === "due" || value === "database";

/** A database row, or a to-do in a page (server/page-tasks.ts), as groupByDatabase places them. */
type Placed = { date: string | null; updatedAt: Date } & (
  | { type?: "row"; databaseId: string; databaseTitle: string | null }
  | { type: "pageTask"; pageId: string; pageTitle: string }
);

/**
 * The parts of My tasks the sidebar's tasks tab lists (`?view=`): everything, what is due by today
 * (overdue too), what is due within the next 7 days (overdue too), what has no date, and only the
 * rows or only the to-dos.
 */
export type TaskView = "all" | "today" | "soon" | "undated" | "rows" | "todos";

export const TASK_VIEWS: TaskView[] = ["all", "today", "soon", "undated", "rows", "todos"];

export const isTaskView = (value: unknown): value is TaskView => TASK_VIEWS.includes(value as TaskView);

type Viewed = { type?: "row" | "pageTask"; date: string | null; endDate?: string | null };

export function inTaskView(item: Viewed, view: TaskView, today: string): boolean {
  if (view === "rows") return item.type !== "pageTask";
  if (view === "todos") return item.type === "pageTask";
  if (view === "all") return true;
  const group = assignedGroup(item.date, today, item.endDate);
  if (view === "undated") return group === "none";
  if (view === "today") return group === "overdue" || group === "today";
  return group === "overdue" || group === "today" || group === "next7";
}

/** The place of rows shared with the viewer without their database, in `?in=` and the sidebar. */
export const SHARED_PLACE = "shared";

/** The place an item is filed under in `?in=`: its database, the page its to-do is in, or SHARED_PLACE. */
export const taskPlace = (item: Placed): string => placeOf(item).id ?? SHARED_PLACE;

/** A place in the tasks tab: a database or a page, with how many of the person's items it holds. */
export type TaskPlaceCount = { id: string; title: string | null; count: number };

/**
 * How many items each view holds, and the places with how many each: the most first, then by
 * title, the shared rows (no title) last.
 */
export function countTasks<R extends Placed & Viewed>(
  items: R[],
  today: string,
  collator: Intl.Collator = new Intl.Collator(),
): { views: Record<TaskView, number>; places: TaskPlaceCount[] } {
  const views = Object.fromEntries(TASK_VIEWS.map((view) => [view, 0])) as Record<TaskView, number>;
  const places = new Map<string, TaskPlaceCount>();
  for (const item of items) {
    for (const view of TASK_VIEWS) if (inTaskView(item, view, today)) views[view]++;
    const id = taskPlace(item);
    const place = places.get(id);
    if (place) place.count++;
    else places.set(id, { id, title: placeOf(item).title, count: 1 });
  }
  return {
    views,
    places: [...places.values()].sort(
      (a, b) =>
        (a.title === null ? 1 : 0) - (b.title === null ? 1 : 0) || b.count - a.count || collator.compare(a.title ?? "", b.title ?? "") || a.id.localeCompare(b.id),
    ),
  };
}

/** Where an item goes: its database (null: shared without it) or the page its to-do is in. */
const placeOf =(item: Placed): { id: string | null; title: string | null } =>
  item.type === "pageTask"
    ? { id: item.pageId, title: item.pageTitle }
    : { id: item.databaseTitle === null ? null : item.databaseId, title: item.databaseTitle };

/**
 * The rows by database, the databases by name, and the rows of each in due-date order: the
 * earliest date first, rows without one last, then the row edited last. Rows shared with the
 * viewer without their database (no title) come last, together, under a null database. To-dos in
 * pages go under their page, which sorts by its title among the databases.
 */
export function groupByDatabase<R extends Placed>(
  rows: R[],
  collator: Intl.Collator = new Intl.Collator(),
): { databaseId: string | null; databaseTitle: string | null; rows: R[] }[] {
  const byDatabase = new Map<string | null, R[]>();
  for (const row of rows) {
    const key = placeOf(row).id;
    const list = byDatabase.get(key);
    if (list) list.push(row);
    else byDatabase.set(key, [row]);
  }
  return [...byDatabase.entries()]
    .map(([databaseId, list]) => ({
      databaseId,
      databaseTitle: databaseId === null ? null : placeOf(list[0]).title,
      rows: list.sort(
        (a, b) =>
          (a.date === null ? 1 : 0) - (b.date === null ? 1 : 0) ||
          (a.date ?? "").localeCompare(b.date ?? "") ||
          b.updatedAt.getTime() - a.updatedAt.getTime(),
      ),
    }))
    .sort(
      (a, b) =>
        (a.databaseTitle === null ? 1 : 0) - (b.databaseTitle === null ? 1 : 0) ||
        collator.compare(a.databaseTitle ?? "", b.databaseTitle ?? "") ||
        (a.databaseId ?? "").localeCompare(b.databaseId ?? ""),
    );
}

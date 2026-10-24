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

/** How a list of assigned rows is grouped: by when they are due, or by the database they are in. */
export type AssignedGrouping = "due" | "database";

export const isAssignedGrouping = (value: unknown): value is AssignedGrouping => value === "due" || value === "database";

/**
 * The rows by database, the databases by name, and the rows of each in due-date order: the
 * earliest date first, rows without one last, then the row edited last. Rows shared with the
 * viewer without their database (no title) come last, together, under a null database.
 */
export function groupByDatabase<R extends { databaseId: string; databaseTitle: string | null; date: string | null; updatedAt: Date }>(
  rows: R[],
  collator: Intl.Collator = new Intl.Collator(),
): { databaseId: string | null; databaseTitle: string | null; rows: R[] }[] {
  const byDatabase = new Map<string | null, R[]>();
  for (const row of rows) {
    const key = row.databaseTitle === null ? null : row.databaseId;
    const list = byDatabase.get(key);
    if (list) list.push(row);
    else byDatabase.set(key, [row]);
  }
  return [...byDatabase.entries()]
    .map(([databaseId, list]) => ({
      databaseId,
      databaseTitle: databaseId === null ? null : list[0].databaseTitle,
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

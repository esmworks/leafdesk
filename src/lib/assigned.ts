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

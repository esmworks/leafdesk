import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { databaseSync, meetingNote, page } from "@/db/schema";
import { CALENDAR_MAX_DAYS, type CalendarItem } from "@/lib/calendar-items";
import { dateOverlaps, dateSortKey, isDay } from "@/lib/date-value";
import type { IcalMapping } from "@/lib/ical-sync";
import { atLeast } from "@/lib/property-access";
import { dayNumber, dayString } from "@/lib/time-zone";
import { childVisibleTo, pageVisibleTo, requireMembership } from "@/server/access";
import { openAssignedRows } from "@/server/assigned";
import { requireDatabase } from "@/server/databases";
import { openPageTasks } from "@/server/page-tasks";
import { propertyAccessFor } from "@/server/property-access";

const addDays = (day: string, n: number) => dayString(dayNumber(day) + n);

/**
 * What the Calendar place shows a person from `from` to `to` (YYYY-MM-DD, both included, their
 * days in `timeZone`): the events of the calendars synced into the workspace (Google Calendar and
 * calendar addresses, server/gcal-sync and ical-sync) whose database and When they may see, the
 * meeting notes they may open, planned or held, and the open rows and to-dos assigned to them
 * that have a date (as My tasks lists them). In the order they start.
 */
export async function calendarItems(userId: string, workspaceId: string, input: { from: string; to: string; timeZone: string }): Promise<CalendarItem[]> {
  await requireMembership(userId, workspaceId);
  const { from, to, timeZone } = input;
  if (!isDay(from) || !isDay(to) || dayNumber(to) < dayNumber(from) || dayNumber(to) - dayNumber(from) >= CALENDAR_MAX_DAYS) {
    throw new Error("A calendar reads whole days, at most CALENDAR_MAX_DAYS of them");
  }
  const inRange = (date: string | null): date is string => !!date && dateOverlaps(date, from, to, timeZone);
  const [events, meetings, rows, tasks] = await Promise.all([
    syncedEvents(userId, workspaceId, from, to),
    meetingItems(userId, workspaceId, from, to),
    openAssignedRows(userId, workspaceId, timeZone),
    openPageTasks(userId, workspaceId, timeZone),
  ]);
  const items: CalendarItem[] = [
    ...events,
    ...meetings,
    ...rows.flatMap((row): CalendarItem[] =>
      inRange(row.dateValue)
        ? [{ id: `task:${row.id}`, kind: "task", title: row.title, icon: row.icon, date: row.dateValue, href: `/w/${workspaceId}/p/${row.id}`, detail: row.databaseTitle }]
        : [],
    ),
    ...tasks.flatMap((task): CalendarItem[] =>
      inRange(task.dateValue)
        ? [{ id: `todo:${task.id}`, kind: "task", title: task.text || task.pageTitle, icon: task.pageIcon, date: task.dateValue, href: task.path, detail: task.pageTitle }]
        : [],
    ),
  ];
  const start = (item: CalendarItem) => dateSortKey(item.date, timeZone) ?? 0;
  return items.filter((item) => inRange(item.date)).sort((a, b) => start(a) - start(b));
}

/**
 * The events of the workspace's synced calendars the person sees, on the days asked for. Rows are
 * picked out in SQL by the first ten characters of their When, a day either way of the range
 * (an instant's are its UTC day), then exactly by dateOverlaps.
 */
async function syncedEvents(userId: string, workspaceId: string, from: string, to: string): Promise<CalendarItem[]> {
  const syncs = await db
    .select({ databaseId: databaseSync.databaseId, mapping: databaseSync.mapping })
    .from(databaseSync)
    .where(and(eq(databaseSync.workspaceId, workspaceId), inArray(databaseSync.source, ["ical", "gcal"])));
  const lists = await Promise.all(
    syncs.map(async ({ databaseId, mapping }) => {
      const { when, location } = mapping as IcalMapping;
      if (!when) return [];
      const database = await requireDatabase(userId, databaseId, "view").catch(() => null);
      if (!database || database.archivedAt) return [];
      const access = await propertyAccessFor(userId, databaseId);
      const value = sql<string | null>`${page.properties} ->> ${when}`;
      const end = sql`coalesce(nullif(split_part(${value}, '/', 2), ''), ${value})`;
      const rows = await db
        .select({ id: page.id, title: page.title, icon: page.icon, properties: page.properties, createdBy: page.createdBy })
        .from(page)
        .where(
          and(
            eq(page.parentId, databaseId),
            eq(page.isTemplate, false),
            isNull(page.archivedAt),
            childVisibleTo(userId, databaseId),
            sql`left(${value}, 10) <= ${addDays(to, 1)}`,
            sql`left(${end}, 10) >= ${addDays(from, -1)}`,
          ),
        );
      return rows.flatMap((row): CalendarItem[] => {
        const properties = (row.properties ?? {}) as Record<string, unknown>;
        const seen = { properties, createdBy: row.createdBy };
        const date = properties[when];
        if (typeof date !== "string" || !atLeast(access.levelOf(when, seen), "view")) return [];
        const place = location && atLeast(access.levelOf(location, seen), "view") ? properties[location] : null;
        return [
          {
            id: `event:${row.id}`,
            kind: "event",
            title: row.title,
            icon: row.icon,
            date,
            href: `/w/${workspaceId}/p/${row.id}`,
            detail: typeof place === "string" && place.trim() ? place.trim().slice(0, 200) : null,
          },
        ];
      });
    }),
  );
  return lists.flat();
}

/** The meeting notes the person may open that start on or about the days asked for: held from their start to end, else planned. */
async function meetingItems(userId: string, workspaceId: string, from: string, to: string): Promise<CalendarItem[]> {
  const at = sql`coalesce(${meetingNote.startedAt}, ${meetingNote.scheduledAt})`;
  const rows = await db
    .select({
      pageId: meetingNote.pageId,
      meetingId: meetingNote.meetingId,
      title: meetingNote.title,
      pageTitle: page.title,
      icon: page.icon,
      scheduledAt: meetingNote.scheduledAt,
      startedAt: meetingNote.startedAt,
      endedAt: meetingNote.endedAt,
      seconds: meetingNote.seconds,
      attendees: meetingNote.attendees,
    })
    .from(meetingNote)
    .innerJoin(page, eq(page.id, meetingNote.pageId))
    .where(
      and(
        eq(page.workspaceId, workspaceId),
        isNull(page.archivedAt),
        eq(page.inTemplate, false),
        pageVisibleTo(userId),
        // A day either way: the range is the person's days, the times are UTC.
        sql`${at} >= ${addDays(from, -1)}::date`,
        sql`${at} < ${addDays(to, 2)}::date`,
      ),
    );
  return rows.flatMap((m): CalendarItem[] => {
    const start = m.startedAt ?? m.scheduledAt;
    if (!start) return [];
    const end = m.startedAt && m.endedAt ? m.endedAt : m.startedAt && m.seconds > 0 ? new Date(m.startedAt.getTime() + m.seconds * 1000) : null;
    const people = (Array.isArray(m.attendees) ? m.attendees : []).flatMap((a) => (typeof a?.name === "string" && a.name.trim() ? [a.name.trim()] : []));
    return [
      {
        id: `meeting:${m.pageId}:${m.meetingId}`,
        kind: "meeting",
        title: m.title.trim() || m.pageTitle,
        icon: m.icon,
        date: end && end > start ? `${start.toISOString()}/${end.toISOString()}` : start.toISOString(),
        href: `/w/${workspaceId}/p/${m.pageId}`,
        detail: people.length ? people.join(", ") : null,
      },
    ];
  });
}

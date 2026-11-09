import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { databaseSync, meetingNote, page } from "@/db/schema";
import { MAX_REMINDER_AHEAD_MS } from "@/lib/ai-reminders";
import { CALENDAR_MAX_DAYS, reminderItem, type CalendarItem } from "@/lib/calendar-items";
import { dateDays, dateOverlaps, dateSortKey, isDay, parseDateValue, shiftDateValue } from "@/lib/date-value";
import type { GcalQuery } from "@/lib/gcal-sync";
import type { IcalMapping } from "@/lib/ical-sync";
import { isBlockId, MENTION, mentionProps, newMentionId } from "@/lib/mentions";
import { atLeast } from "@/lib/property-access";
import { dayNumber, dayString, localDay, zonedInstant } from "@/lib/time-zone";
import { AccessError, childVisibleTo, pageVisibleTo, requireMembership, requirePageAccess } from "@/server/access";
import { openAssignedRows } from "@/server/assigned";
import { getCollab } from "@/server/collab/bridge";
import { requireDatabase, updateRowProperties } from "@/server/databases";
import { loadProperties } from "@/server/derived";
import { isMeetingError, rescheduleMeeting } from "@/server/meetings";
import { listNotifications, moveReminder } from "@/server/notifications";
import { openPageTasks } from "@/server/page-tasks";
import { propertyAccessFor } from "@/server/property-access";
import { moveWorkBlock, WorkBlockError, workBlockItems } from "@/server/work-blocks";

const addDays = (day: string, n: number) => dayString(dayNumber(day) + n);
/** What moves to any day or time: tasks, and events of calendars written back to. */
const ANYWHERE = { allDay: true } as const;
/**
 * The most reminders still to come one read lists: above what agents may keep waiting for a person
 * (MAX_WAITING_REMINDERS each) in any workspace with a sensible number of them.
 */
const REMINDERS_READ = 500;

/**
 * What the Calendar place shows a person from `from` to `to` (YYYY-MM-DD, both included, their
 * days in `timeZone`): the events of the calendars synced into the workspace (Google Calendar and
 * calendar addresses, server/gcal-sync and ical-sync) whose database and When they may see, the
 * meeting notes they may open, planned or held, the open rows and to-dos assigned to them
 * that have a date (as My tasks lists them), and the reminders agents and the AI chat set them
 * that haven't come yet (theirs alone, as the inbox's Scheduled tab lists them), and the time they
 * planned for their tasks (server/work-blocks.ts, theirs alone). In the order they start.
 */
export async function calendarItems(userId: string, workspaceId: string, input: { from: string; to: string; timeZone: string }): Promise<CalendarItem[]> {
  await requireMembership(userId, workspaceId);
  const { from, to, timeZone } = input;
  if (!isDay(from) || !isDay(to) || dayNumber(to) < dayNumber(from) || dayNumber(to) - dayNumber(from) >= CALENDAR_MAX_DAYS) {
    throw new Error("A calendar reads whole days, at most CALENDAR_MAX_DAYS of them");
  }
  const inRange = (date: string | null): date is string => !!date && dateOverlaps(date, from, to, timeZone);
  const [events, meetings, rows, tasks, reminders, blocks] = await Promise.all([
    syncedEvents(userId, workspaceId, from, to),
    meetingItems(userId, workspaceId, from, to),
    openAssignedRows(userId, workspaceId, timeZone),
    openPageTasks(userId, workspaceId, timeZone),
    listNotifications(userId, { workspaceId, kinds: ["ai_reminder"], pending: true, limit: REMINDERS_READ }),
    workBlockItems(userId, workspaceId, new Date(zonedInstant(dayNumber(from), 0, timeZone)), new Date(zonedInstant(dayNumber(to) + 1, 0, timeZone))),
  ]);
  const items: CalendarItem[] = [
    ...events,
    ...meetings,
    ...rows.flatMap((row): CalendarItem[] =>
      inRange(row.dateValue)
        ? [{ id: `task:${row.id}`, kind: "task", title: row.title, icon: row.icon, date: row.dateValue, href: `/w/${workspaceId}/p/${row.id}`, detail: row.databaseTitle, moves: ANYWHERE }]
        : [],
    ),
    ...tasks.flatMap((task): CalendarItem[] =>
      inRange(task.dateValue)
        ? [{ id: `todo:${task.id}`, kind: "task", title: task.text || task.pageTitle, icon: task.pageIcon, date: task.dateValue, href: task.path, detail: task.pageTitle, moves: ANYWHERE }]
        : [],
    ),
    ...reminders.flatMap((n): CalendarItem[] =>
      n.snoozedUntil && n.aiReminder
        ? [
            reminderItem(
              { id: n.id, text: n.aiReminder.text, at: n.snoozedUntil, pageId: n.pageId, agentName: n.aiReminder.agentName, own: n.aiReminder.own === true },
              workspaceId,
            ),
          ]
        : [],
    ),
    ...blocks,
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
    .select({ databaseId: databaseSync.databaseId, source: databaseSync.source, query: databaseSync.query, mapping: databaseSync.mapping })
    .from(databaseSync)
    .where(and(eq(databaseSync.workspaceId, workspaceId), inArray(databaseSync.source, ["ical", "gcal"])));
  const lists = await Promise.all(
    syncs.map(async (sync) => {
      const { databaseId } = sync;
      const { when, location } = sync.mapping as IcalMapping;
      // A calendar address is only read, and so is a Google calendar not written back to: a
      // change here would be undone by the next run.
      const moves = writesBack(sync) ? ANYWHERE : null;
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
            moves,
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
        // A planned meeting moves to another time; a held one is a record.
        moves: m.startedAt ? null : { allDay: false },
      },
    ];
  });
}

/** Whether a synced calendar's changes in Leafdesk go back to it: a Google Calendar sync set to "both". */
function writesBack(sync: { source: string; query: unknown }): boolean {
  return sync.source === "gcal" && (sync.query as GcalQuery).direction === "both";
}

/** Why a calendar item couldn't be moved: it is gone, it can't move there, or the person may not change it. */
export class CalendarMoveError extends Error {
  constructor(readonly code: "notFound" | "fixed" | "noAccess") {
    super(`The item can't be moved (${code})`);
    this.name = "CalendarMoveError";
  }
}

/**
 * Moves an item of the Calendar (its `id` as calendarItems gives it) to the date `value` (a date
 * value, lib/date-value), as the person, with their access checked by the write itself: a row's
 * date (an assigned row's first date they see, an event's When), a planned meeting's time, and a
 * to-do's date mention, whose time is a reminder on its day (timedOnItsDay in page-tasks.ts):
 * dropped on a time it gets one then, dropped on a day one it had on its day goes, and one on
 * another day moves along; a reminder still to come, to another time (the person's own, at most
 * 30 days ahead); time planned for a task, to new times or a new length (the person's own, a
 * range of times within its limits). `timeZone` is the person's, whose days and clock the drop was on.
 */
export async function moveCalendarItem(userId: string, workspaceId: string, id: string, value: string, timeZone: string): Promise<void> {
  await requireMembership(userId, workspaceId);
  const parts = parseDateValue(value);
  if (!parts) throw new CalendarMoveError("fixed");
  const [kind, first, second] = id.split(":");
  try {
    if (kind === "task" || kind === "event") return await moveRowDate(userId, workspaceId, kind, first, value, timeZone);
    if (kind === "todo" && second) return await moveTodoDate(userId, workspaceId, first, second, value, timeZone);
    if (kind === "reminder" && first) {
      if (!parts.time) throw new CalendarMoveError("fixed");
      // A reminder goes at most MAX_REMINDER_AHEAD_MS ahead, never back in time.
      const until = new Date(parts.start);
      const now = Date.now();
      if (!(until.getTime() > now && until.getTime() <= now + MAX_REMINDER_AHEAD_MS)) throw new CalendarMoveError("fixed");
      // Never one that has come meanwhile (a stale calendar): only a reminder still to come, in this workspace.
      if (await moveReminder(userId, first, until, { workspaceId })) return;
      throw new CalendarMoveError("notFound");
    }
    if (kind === "block" && first) {
      if (!parts.time || !parts.end) throw new CalendarMoveError("fixed");
      return await moveWorkBlock(userId, workspaceId, first, new Date(parts.start), new Date(parts.end));
    }
    if (kind === "meeting" && second) {
      if (!parts.time) throw new CalendarMoveError("fixed");
      await pageInWorkspace(userId, workspaceId, first);
      return await rescheduleMeeting(userId, first, second, new Date(parts.start));
    }
  } catch (error) {
    if (error instanceof AccessError) throw new CalendarMoveError("noAccess");
    if (error instanceof WorkBlockError) throw new CalendarMoveError(error.code === "notFound" || error.code === "noAccess" ? error.code : "fixed");
    if (isMeetingError(error)) throw new CalendarMoveError(error.code === "noAccess" ? "noAccess" : error.code === "notFound" ? "notFound" : "fixed");
    throw error;
  }
  throw new CalendarMoveError("notFound");
}

/** The page, when it is in the workspace and the person may change its content. */
async function pageInWorkspace(userId: string, workspaceId: string, pageId: string) {
  const found = await requirePageAccess(userId, pageId, "content");
  if (found.workspaceId !== workspaceId || found.archivedAt) throw new CalendarMoveError("notFound");
  return found;
}

/** A row's date: an event's When (of a calendar written back to), a task's first date the person sees, as calendarItems picks them. */
async function moveRowDate(userId: string, workspaceId: string, kind: "task" | "event", rowId: string, value: string, timeZone: string) {
  const row = await pageInWorkspace(userId, workspaceId, rowId);
  const databaseId = row.parentId;
  if (!databaseId) throw new CalendarMoveError("notFound");
  let propertyId: string | undefined;
  if (kind === "event") {
    const [sync] = await db
      .select({ source: databaseSync.source, query: databaseSync.query, mapping: databaseSync.mapping })
      .from(databaseSync)
      .where(and(eq(databaseSync.databaseId, databaseId), inArray(databaseSync.source, ["ical", "gcal"])))
      .limit(1);
    if (!sync) throw new CalendarMoveError("notFound");
    if (!writesBack(sync)) throw new CalendarMoveError("fixed");
    propertyId = (sync.mapping as IcalMapping).when;
  } else {
    const [properties, access] = await Promise.all([loadProperties([databaseId]), propertyAccessFor(userId, databaseId)]);
    const seen = { properties: row.properties, createdBy: row.createdBy };
    propertyId = (properties.get(databaseId) ?? []).find(
      (p) => p.type === "date" && atLeast(access.levelOf(p.id, seen), "view") && dateDays(row.properties[p.id], timeZone),
    )?.id;
  }
  if (!propertyId) throw new CalendarMoveError("notFound");
  await updateRowProperties(userId, rowId, { [propertyId]: value });
}

/** A to-do's first date mention, as lib/page-tasks reads it: its day, and its reminder as its time. */
async function moveTodoDate(userId: string, workspaceId: string, pageId: string, blockId: string, value: string, timeZone: string) {
  if (!isBlockId(blockId)) throw new CalendarMoveError("notFound");
  await pageInWorkspace(userId, workspaceId, pageId);
  const parts = parseDateValue(value)!;
  const day = parts.time ? dayString(localDay(Date.parse(parts.start), timeZone)) : parts.start;
  const after = await getCollab().updateBlockAttributes(
    pageId,
    MENTION,
    (props, id) => id === blockId && props.kind === "date" && parseDateValue(props.date) !== null,
    (props) => {
      const mention = mentionProps(props);
      let remindAt = mention.remindAt;
      if (parts.time) remindAt = new Date(parts.start).toISOString();
      else if (remindAt && !Number.isNaN(Date.parse(remindAt))) {
        const wasTime = isDay(mention.date) && localDay(Date.parse(remindAt), timeZone) === dayNumber(mention.date);
        const moved = isDay(mention.date) ? dayNumber(day) - dayNumber(mention.date) : 0;
        remindAt = wasTime ? "" : (shiftDateValue(remindAt, moved, timeZone) ?? remindAt);
      }
      if (mention.date === day && mention.remindAt === remindAt) return null;
      // A reminder is kept by the mention's id (server/mentions.ts).
      return { date: day, remindAt, ...(remindAt && !mention.id ? { id: newMentionId() } : {}) };
    },
    { userId },
  );
  if (!after) throw new CalendarMoveError("notFound");
}

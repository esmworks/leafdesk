import { and, eq, isNotNull, isNull, lt, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { databaseProperty, notification, page, rowReminder, type DateReminder } from "@/db/schema";
import { dueReminderDay, reminderInstant } from "@/lib/date-options";
import { parseDateValue, shiftDateValue } from "@/lib/date-value";
import { atLeast } from "@/lib/property-access";
import { isDoneStatus } from "@/lib/properties";
import { dayString, localDay } from "@/lib/time-zone";
import { loadProperties } from "@/server/derived";
import { mailStatus } from "@/server/mail";
import { pageRecipients, signalInbox } from "@/server/notifications";
import { propertyAccessFor, type PropertyAccess } from "@/server/property-access";
import { pushNotifications } from "@/server/push";
import { startSweep } from "@/server/sweep";

/**
 * Reminders on date properties (see lib/date-options): a date property with a reminder tells the
 * people of each row, `daysBefore` days before the row's date at 9:00 in the reminder's zone (for a
 * time: `daysBefore` days before it, at that time on the reminder zone's clock), in the inbox, by
 * email and as a push notification. A range reminds of its start. The people are those the row's person properties
 * name, or whoever added the row when they name nobody; each only while they can open the row and
 * see the date. Rows that are done (a status in the "done" group), trashed or templates don't
 * remind. Each sweep looks at the rows whose date reminds at the latest 9:00 gone by, and those whose
 * time reminds within LATE_MS; row_reminder keeps one reminder per row and start. A reminder time missed by more than LATE_MS (a server that
 * was down) is skipped, as are those that had passed when the reminder was set or the row added.
 */

/** How late a reminder may still go. */
export const LATE_MS = 2 * 3_600_000;
/** How often reminders are looked for. */
const SWEEP_MS = 60_000;
/** How often row_reminder drops what it no longer needs (see pruneRowReminders). */
const PRUNE_EVERY_MS = 3_600_000;
const DAY_MS = 86_400_000;
let prunedAt = 0;

type ReminderProperty = { id: string; databaseId: string; workspaceId: string; reminder: DateReminder };

/** Sends the reminders due at `now`. Returns how many people were told. */
export async function deliverDateReminders(now = new Date()): Promise<number> {
  const rows = await db
    .select({ id: databaseProperty.id, databaseId: databaseProperty.databaseId, workspaceId: page.workspaceId, options: databaseProperty.options })
    .from(databaseProperty)
    .innerJoin(page, eq(page.id, databaseProperty.databaseId))
    .where(
      and(
        eq(databaseProperty.type, "date"),
        isNotNull(sql`${databaseProperty.options} -> 'date' -> 'reminder'`),
        isNull(databaseProperty.deletedAt),
        isNull(page.archivedAt),
        eq(page.inTemplate, false),
      ),
    );
  if (now.getTime() - prunedAt > PRUNE_EVERY_MS) {
    prunedAt = now.getTime();
    await pruneRowReminders(now);
  }
  let told = 0;
  for (const row of rows) {
    const reminder = row.options.date?.reminder;
    if (!reminder) continue;
    try {
      told += await remindProperty({ id: row.id, databaseId: row.databaseId, workspaceId: row.workspaceId, reminder }, now);
    } catch (error) {
      console.error("date reminders failed", row.id, error);
    }
  }
  return told;
}

/**
 * row_reminder only has to stop a reminder going twice while it can still go: within LATE_MS of 9:00
 * on or before its date. Dates two days gone (in any zone) are past that.
 */
async function pruneRowReminders(now: Date) {
  await db.delete(rowReminder).where(lt(rowReminder.date, dayString(localDay(now.getTime(), "UTC") - 2)));
}

type Candidate = { id: string; workspaceId: string; properties: Record<string, unknown>; createdBy: string | null; createdAt: Date };
/** What a row is reminded of: its start (a day, or the UTC timestamp of a time), and when. */
type Due = { row: Candidate; date: string; at: number };

const CANDIDATE_COLUMNS = {
  id: page.id,
  workspaceId: page.workspaceId,
  properties: page.properties,
  createdBy: page.createdBy,
  createdAt: page.createdAt,
};

/** The live rows of the database (the workspace too, for the (workspace, parent) index). */
const liveRows = (workspaceId: string, databaseId: string) => [
  eq(page.workspaceId, workspaceId),
  eq(page.parentId, databaseId),
  isNull(page.archivedAt),
  eq(page.isTemplate, false),
  eq(page.inTemplate, false),
];

/** Rows already reminded of their start (an earlier sweep, another server) aren't looked at again. */
const notReminded = (propertyId: string, start: SQL) =>
  sql`not exists (select 1 from ${rowReminder} where ${rowReminder.rowId} = ${page.id}
    and ${rowReminder.propertyId} = ${propertyId} and ${rowReminder.date} = ${start})`;

async function remindProperty(property: ReminderProperty, now: Date): Promise<number> {
  const due = [...(await dueDays(property, now)), ...(await dueTimes(property, now))];
  // A row added after its reminder time doesn't remind about it.
  const candidates = due.filter(({ row, at }) => row.createdAt.getTime() <= at);
  if (!candidates.length) return 0;

  const { id: propertyId, databaseId } = property;
  const properties = (await loadProperties([databaseId])).get(databaseId) ?? [];
  const people = properties.filter((p) => p.type === "person");
  const statuses = properties.filter((p) => p.type === "status");
  // Each person's access to the database's properties, asked once for all its rows.
  const accessOf = new Map<string, Promise<PropertyAccess>>();
  const propertyAccess = (userId: string) => {
    let access = accessOf.get(userId);
    if (!access) accessOf.set(userId, (access = propertyAccessFor(userId, databaseId)));
    return access;
  };
  let told = 0;
  for (const { row, date } of candidates) {
    if (statuses.some((p) => isDoneStatus(p, row.properties[p.id]))) continue;
    const named = people.flatMap((p) => (Array.isArray(row.properties[p.id]) ? (row.properties[p.id] as unknown[]) : []));
    const recipients = [...new Set((named.length ? named : [row.createdBy]).filter((id): id is string => typeof id === "string"))];
    if (!recipients.length) continue;
    // Claim it first: another server, or the next sweep, finds it taken.
    const claimed = await db.insert(rowReminder).values({ rowId: row.id, propertyId, date }).onConflictDoNothing().returning();
    if (!claimed.length) continue;
    told += await notify(recipients, row, propertyId, date, propertyAccess);
  }
  return told;
}

/**
 * Rows whose date is a day (or a range of days) starting on the day the latest 9:00 gone by
 * reminds of.
 */
async function dueDays({ id: propertyId, databaseId, workspaceId, reminder }: ReminderProperty, now: Date): Promise<Due[]> {
  const day = dayString(dueReminderDay(reminder, now.getTime()));
  const at = reminderInstant(day, reminder);
  if (now.getTime() - at > LATE_MS || at < Date.parse(reminder.since)) return [];
  const value = sql`${page.properties} ->> ${propertyId}::text`;
  const rows = await db
    .select(CANDIDATE_COLUMNS)
    .from(page)
    .where(
      and(
        ...liveRows(workspaceId, databaseId),
        sql`(${value} = ${day} or ${value} like ${`${day}/%`})`,
        notReminded(propertyId, sql`${day}`),
      ),
    );
  return rows.map((row) => ({ row, date: day, at }));
}

/**
 * Rows whose date is a time (or a range of times) whose reminder time, `daysBefore` days before it
 * at the same time on the clock where the reminder was set, has come within LATE_MS. Times are
 * stored as UTC timestamps, which compare as text; a day either side of the window covers changes
 * of clocks, and each row's own reminder time is checked here.
 */
async function dueTimes({ id: propertyId, databaseId, workspaceId, reminder }: ReminderProperty, now: Date): Promise<Due[]> {
  const ahead = (reminder.daysBefore + 1) * DAY_MS;
  const from = new Date(now.getTime() - LATE_MS - DAY_MS + reminder.daysBefore * DAY_MS).toISOString();
  const to = new Date(now.getTime() + ahead).toISOString();
  const start = sql`split_part(${page.properties} ->> ${propertyId}::text, '/', 1)`;
  const rows = await db
    .select(CANDIDATE_COLUMNS)
    .from(page)
    .where(
      and(
        ...liveRows(workspaceId, databaseId),
        sql`${start} like '____-__-__T%'`,
        sql`${start} > ${from}`,
        sql`${start} <= ${to}`,
        notReminded(propertyId, start),
      ),
    );
  const since = Date.parse(reminder.since);
  return rows.flatMap((row) => {
    const value = parseDateValue(row.properties[propertyId]);
    if (!value?.time) return [];
    const at = Date.parse(shiftDateValue(value.start, -reminder.daysBefore, reminder.timeZone)!);
    if (at > now.getTime() || now.getTime() - at > LATE_MS || at < since) return [];
    return [{ row, date: value.start, at }];
  });
}

/** Tells those of `userIds` who may open the row and see its date. Returns how many. */
async function notify(
  userIds: string[],
  row: { id: string; workspaceId: string; properties: Record<string, unknown> },
  propertyId: string,
  day: string,
  propertyAccess: (userId: string) => Promise<PropertyAccess>,
): Promise<number> {
  // People (not agents) who can open the row, then those of them who see the date.
  const opening = await pageRecipients(userIds, row.id);
  const sees = await Promise.all(opening.map(async (id) => atLeast((await propertyAccess(id)).levelOf(propertyId, row), "view")));
  const allowed = opening.filter((_, i) => sees[i]);
  if (!allowed.length) return 0;
  const emailDueAt = mailStatus() === "disabled" ? null : new Date();
  const inserted = await db
    .insert(notification)
    .values(
      allowed.map((userId) => ({
        userId,
        workspaceId: row.workspaceId,
        kind: "reminder" as const,
        pageId: row.id,
        propertyId,
        date: day,
        emailDueAt,
      })),
    )
    .returning({ id: notification.id });
  signalInbox(row.workspaceId);
  pushNotifications(inserted.map((n) => n.id));
  return allowed.length;
}

/** Server only: sends date reminders as they fall due. Returns a function that stops it. */
export function startDateReminders() {
  return startSweep(SWEEP_MS, () => deliverDateReminders(), "could not deliver date reminders");
}

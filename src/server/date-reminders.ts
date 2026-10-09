import { and, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { databaseProperty, notification, page, rowReminder, type DateReminder, type SelectOption } from "@/db/schema";
import { dueReminderDay, reminderInstant } from "@/lib/date-options";
import { atLeast } from "@/lib/property-access";
import { statusGroupOf } from "@/lib/properties";
import { dayString, localDay } from "@/lib/time-zone";
import { pageAccessOf } from "@/server/access";
import { agentUserIds } from "@/server/agents/users";
import { loadProperties } from "@/server/derived";
import { mailStatus } from "@/server/mail";
import { signalInbox } from "@/server/notifications";
import { propertyAccessFor, type PropertyAccess } from "@/server/property-access";
import { pushNotifications } from "@/server/push";

/**
 * Reminders on date properties (see lib/date-options): a date property with a reminder tells the
 * people of each row, `daysBefore` days before the row's date at 9:00 in the reminder's zone, in
 * the inbox, by email and as a push notification. The people are those the row's person properties
 * name, or whoever added the row when they name nobody; each only while they can open the row and
 * see the date. Rows that are done (a status in the "done" group), trashed or templates don't
 * remind. Each sweep looks at the rows whose date reminds at the latest 9:00 gone by; row_reminder
 * keeps one reminder per row and date. A reminder time missed by more than LATE_MS (a server that
 * was down) is skipped, as are those that had passed when the reminder was set or the row added.
 */

/** How late a reminder may still go. */
export const LATE_MS = 2 * 3_600_000;
/** How often reminders are looked for. */
const SWEEP_MS = 60_000;
/** How often row_reminder drops what it no longer needs (see pruneRowReminders). */
const PRUNE_EVERY_MS = 3_600_000;
let prunedAt = 0;

type ReminderProperty = { id: string; databaseId: string; reminder: DateReminder };

/** Sends the reminders due at `now`. Returns how many people were told. */
export async function deliverDateReminders(now = new Date()): Promise<number> {
  const rows = await db
    .select({ id: databaseProperty.id, databaseId: databaseProperty.databaseId, options: databaseProperty.options })
    .from(databaseProperty)
    .innerJoin(page, eq(page.id, databaseProperty.databaseId))
    .where(
      and(
        eq(databaseProperty.type, "date"),
        isNotNull(sql`${databaseProperty.options} -> 'date' -> 'reminder'`),
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
      told += await remindProperty({ id: row.id, databaseId: row.databaseId, reminder }, now);
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

async function remindProperty({ id: propertyId, databaseId, reminder }: ReminderProperty, now: Date): Promise<number> {
  const day = dayString(dueReminderDay(reminder, now.getTime()));
  const at = reminderInstant(day, reminder);
  if (now.getTime() - at > LATE_MS || at < Date.parse(reminder.since)) return 0;

  const rows = await db
    .select({ id: page.id, workspaceId: page.workspaceId, properties: page.properties, createdBy: page.createdBy, createdAt: page.createdAt })
    .from(page)
    .where(
      and(
        eq(page.parentId, databaseId),
        isNull(page.archivedAt),
        eq(page.isTemplate, false),
        eq(page.inTemplate, false),
        sql`${page.properties} ->> ${propertyId}::text = ${day}`,
      ),
    );
  // A row added after its reminder time doesn't remind about it.
  const candidates = rows.filter((row) => row.createdAt.getTime() <= at);
  if (!candidates.length) return 0;

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
  for (const row of candidates) {
    const done = statuses.some((p) => {
      const option = (p.options.options ?? []).find((o: SelectOption) => o.id === row.properties[p.id]);
      return option !== undefined && statusGroupOf(option) === "done";
    });
    if (done) continue;
    const named = people.flatMap((p) => (Array.isArray(row.properties[p.id]) ? (row.properties[p.id] as unknown[]) : []));
    const recipients = [...new Set((named.length ? named : [row.createdBy]).filter((id): id is string => typeof id === "string"))];
    if (!recipients.length) continue;
    // Claim it first: another server, or the next sweep, finds it taken.
    const claimed = await db.insert(rowReminder).values({ rowId: row.id, propertyId, date: day }).onConflictDoNothing().returning();
    if (!claimed.length) continue;
    told += await notify(recipients, row, propertyId, day, propertyAccess);
  }
  return told;
}

/** Tells those of `userIds` who may open the row and see its date. Returns how many. */
async function notify(
  userIds: string[],
  row: { id: string; workspaceId: string; properties: Record<string, unknown> },
  propertyId: string,
  day: string,
  propertyAccess: (userId: string) => Promise<PropertyAccess>,
): Promise<number> {
  const agents = await agentUserIds(userIds);
  const allowed: string[] = [];
  for (const userId of userIds) {
    if (agents.has(userId) || (await pageAccessOf(userId, row.id)).level === "none") continue;
    const access = await propertyAccess(userId);
    if (atLeast(access.levelOf(propertyId, row), "view")) allowed.push(userId);
  }
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
  let sweeping = false;
  const sweep = async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      await deliverDateReminders();
    } catch (error) {
      console.error("could not deliver date reminders", error);
    } finally {
      sweeping = false;
    }
  };
  void sweep();
  const timer = setInterval(() => void sweep(), SWEEP_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

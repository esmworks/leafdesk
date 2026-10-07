import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { notification, pendingAssignmentEmail, userPreference, type NotificationKind, type PreferenceKind } from "@/db/schema";

/**
 * What each person wants to hear about, and where: in the inbox, by email, or both. Account-wide,
 * like the other preferences; everything is on until the person turns it off.
 */

export type NotificationChannel = "inbox" | "email";
export type NotificationPreferences = Record<PreferenceKind, Record<NotificationChannel, boolean>>;

const COLUMNS = {
  assignment: { inbox: "assignmentInbox", email: "assignmentEmails" },
  page_shared: { inbox: "shareInbox", email: "shareEmails" },
  comment: { inbox: "commentInbox", email: "commentEmails" },
  mention: { inbox: "mentionInbox", email: "mentionEmails" },
  reminder: { inbox: "reminderInbox", email: "reminderEmails" },
  access_request: { inbox: "accessRequestInbox", email: "accessRequestEmails" },
  join_request: { inbox: "joinRequestInbox", email: "joinRequestEmails" },
  automation: { inbox: "automationInbox", email: "automationEmails" },
} as const satisfies Record<PreferenceKind, Record<NotificationChannel, keyof typeof userPreference.$inferSelect>>;

const KINDS = Object.keys(COLUMNS) as PreferenceKind[];

export async function getNotificationPreferences(userId: string): Promise<NotificationPreferences> {
  const [row] = await db.select().from(userPreference).where(eq(userPreference.userId, userId));
  return Object.fromEntries(
    KINDS.map((kind) => [kind, { inbox: row?.[COLUMNS[kind].inbox] ?? true, email: row?.[COLUMNS[kind].email] ?? true }]),
  ) as NotificationPreferences;
}

/** Whether this person wants emails about `kind` (on unless they turned them off). */
export async function wantsEmail(userId: string, kind: PreferenceKind) {
  return (await getNotificationPreferences(userId))[kind].email;
}

/** The kinds this person keeps in their inbox (calls waiting for approval always). */
export async function inboxKinds(userId: string): Promise<NotificationKind[]> {
  const prefs = await getNotificationPreferences(userId);
  return [...KINDS.filter((kind) => prefs[kind].inbox), "agent_approval"];
}

export async function setNotificationPreference(userId: string, kind: PreferenceKind, channel: NotificationChannel, on: boolean) {
  const column = COLUMNS[kind][channel];
  await db
    .insert(userPreference)
    .values({ userId, [column]: on })
    .onConflictDoUpdate({ target: userPreference.userId, set: { [column]: on, updatedAt: new Date() } });
  if (channel !== "email" || on) return;
  // Turning emails off also drops what is already waiting.
  if (kind === "assignment") {
    await db.delete(pendingAssignmentEmail).where(eq(pendingAssignmentEmail.userId, userId));
  } else {
    await db
      .update(notification)
      .set({ emailDueAt: null })
      .where(and(eq(notification.userId, userId), eq(notification.kind, kind), isNotNull(notification.emailDueAt)));
  }
}

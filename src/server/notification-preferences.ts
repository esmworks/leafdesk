import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { notification, pendingAssignmentEmail, userPreference, type NotificationKind, type PreferenceKind } from "@/db/schema";

/**
 * What each person wants to hear about, and where: in the inbox, by email, as push notifications
 * on the devices that turned them on, or any of these. Account-wide, like the other preferences;
 * everything is on until the person turns it off. Push follows the inbox: what doesn't show there
 * isn't pushed either.
 */

export type NotificationChannel = "inbox" | "email" | "push";
export const NOTIFICATION_CHANNELS: readonly NotificationChannel[] = ["inbox", "email", "push"];
export type NotificationPreferences = Record<PreferenceKind, Record<NotificationChannel, boolean>>;

const COLUMNS = {
  assignment: { inbox: "assignmentInbox", email: "assignmentEmails", push: "assignmentPush" },
  page_shared: { inbox: "shareInbox", email: "shareEmails", push: "sharePush" },
  comment: { inbox: "commentInbox", email: "commentEmails", push: "commentPush" },
  mention: { inbox: "mentionInbox", email: "mentionEmails", push: "mentionPush" },
  reminder: { inbox: "reminderInbox", email: "reminderEmails", push: "reminderPush" },
  access_request: { inbox: "accessRequestInbox", email: "accessRequestEmails", push: "accessRequestPush" },
  join_request: { inbox: "joinRequestInbox", email: "joinRequestEmails", push: "joinRequestPush" },
  automation: { inbox: "automationInbox", email: "automationEmails", push: "automationPush" },
} as const satisfies Record<PreferenceKind, Record<NotificationChannel, keyof typeof userPreference.$inferSelect>>;

const KINDS = Object.keys(COLUMNS) as PreferenceKind[];

/**
 * The choices stored in a person's preferences row (none yet: everything on). `push` is what the
 * person chose for push; whether a push goes out also needs the inbox (see wantsPush).
 */
export function preferencesFrom(row: Partial<typeof userPreference.$inferSelect> | undefined): NotificationPreferences {
  return Object.fromEntries(
    KINDS.map((kind) => [
      kind,
      { inbox: row?.[COLUMNS[kind].inbox] ?? true, email: row?.[COLUMNS[kind].email] ?? true, push: row?.[COLUMNS[kind].push] ?? true },
    ]),
  ) as NotificationPreferences;
}

export async function getNotificationPreferences(userId: string): Promise<NotificationPreferences> {
  const [row] = await db.select().from(userPreference).where(eq(userPreference.userId, userId));
  return preferencesFrom(row);
}

/**
 * Whether a notification of `kind` is pushed to the person's devices: only what shows in their
 * inbox, unless they turned push off for the kind. An agent's call waiting for approval, which
 * always shows to owners, is always pushed.
 */
export function pushWanted(preferences: NotificationPreferences, kind: NotificationKind) {
  if (kind === "agent_approval") return true;
  return preferences[kind].inbox && preferences[kind].push;
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

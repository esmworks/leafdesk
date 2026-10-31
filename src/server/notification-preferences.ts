import { and, eq, getTableColumns, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { isOwnerKind, notification, OWNER_KINDS, pendingAssignmentEmail, userPreference, type NotificationKind, type PreferenceKind } from "@/db/schema";

/**
 * What each person wants to hear about, and where: in the inbox, by email, as push notifications
 * on the devices that turned them on, in the Telegram chat they linked, or any of these.
 * Account-wide, like the other preferences; everything is on until the person turns it off, but
 * push and Telegram messages about reactions, which wait until turned on. Push
 * and Telegram follow the inbox: what doesn't show there isn't sent there either.
 */

export type NotificationChannel = "inbox" | "email" | "push" | "telegram";
export const NOTIFICATION_CHANNELS: readonly NotificationChannel[] = ["inbox", "email", "push", "telegram"];
export type NotificationPreferences = Record<PreferenceKind, Record<NotificationChannel, boolean>>;

const COLUMNS = {
  assignment: { inbox: "assignmentInbox", email: "assignmentEmails", push: "assignmentPush", telegram: "assignmentTelegram" },
  page_shared: { inbox: "shareInbox", email: "shareEmails", push: "sharePush", telegram: "shareTelegram" },
  comment: { inbox: "commentInbox", email: "commentEmails", push: "commentPush", telegram: "commentTelegram" },
  mention: { inbox: "mentionInbox", email: "mentionEmails", push: "mentionPush", telegram: "mentionTelegram" },
  reminder: { inbox: "reminderInbox", email: "reminderEmails", push: "reminderPush", telegram: "reminderTelegram" },
  access_request: { inbox: "accessRequestInbox", email: "accessRequestEmails", push: "accessRequestPush", telegram: "accessRequestTelegram" },
  join_request: { inbox: "joinRequestInbox", email: "joinRequestEmails", push: "joinRequestPush", telegram: "joinRequestTelegram" },
  automation: { inbox: "automationInbox", email: "automationEmails", push: "automationPush", telegram: "automationTelegram" },
  row_update: { inbox: "rowUpdateInbox", email: "rowUpdateEmails", push: "rowUpdatePush", telegram: "rowUpdateTelegram" },
  page_updated: { inbox: "pageUpdateInbox", email: "pageUpdateEmails", push: "pageUpdatePush", telegram: "pageUpdateTelegram" },
  row_email: { inbox: "rowEmailInbox", email: "rowEmailEmails", push: "rowEmailPush", telegram: "rowEmailTelegram" },
  review: { inbox: "reviewInbox", email: "reviewEmails", push: "reviewPush", telegram: "reviewTelegram" },
  follow_up: { inbox: "followUpInbox", email: "followUpEmails", push: "followUpPush", telegram: "followUpTelegram" },
  reaction: { inbox: "reactionInbox", email: "reactionEmails", push: "reactionPush", telegram: "reactionTelegram" },
  verification: { inbox: "verificationInbox", email: "verificationEmails", push: "verificationPush", telegram: "verificationTelegram" },
  ai_reminder: { inbox: "aiReminderInbox", email: "aiReminderEmails", push: "aiReminderPush", telegram: "aiReminderTelegram" },
} as const satisfies Record<PreferenceKind, Record<NotificationChannel, keyof typeof userPreference.$inferSelect>>;

const KINDS = Object.keys(COLUMNS) as PreferenceKind[];

/** A choice nobody made yet: the column's default (on, but for reactions' push and Telegram). */
const columns = getTableColumns(userPreference);
const defaultOf = (column: keyof typeof columns) => columns[column].default !== false;

/**
 * The choices stored in a person's preferences row (none yet: everything on). `push` is what the
 * person chose for push; whether a push goes out also needs the inbox (see wantsPush).
 */
export function preferencesFrom(row: Partial<typeof userPreference.$inferSelect> | undefined): NotificationPreferences {
  return Object.fromEntries(
    KINDS.map((kind) => [
      kind,
      {
        inbox: row?.[COLUMNS[kind].inbox] ?? defaultOf(COLUMNS[kind].inbox),
        email: row?.[COLUMNS[kind].email] ?? defaultOf(COLUMNS[kind].email),
        push: row?.[COLUMNS[kind].push] ?? defaultOf(COLUMNS[kind].push),
        telegram: row?.[COLUMNS[kind].telegram] ?? defaultOf(COLUMNS[kind].telegram),
      },
    ]),
  ) as NotificationPreferences;
}

export async function getNotificationPreferences(userId: string): Promise<NotificationPreferences> {
  const [row] = await db.select().from(userPreference).where(eq(userPreference.userId, userId));
  return preferencesFrom(row);
}

/**
 * Whether a notification of `kind` is pushed to the person's devices: only what shows in their
 * inbox, unless they turned push off for the kind. An agent's call or notes waiting for an owner,
 * which always show to owners, are always pushed.
 */
export function pushWanted(preferences: NotificationPreferences, kind: NotificationKind) {
  if (isOwnerKind(kind)) return true;
  return preferences[kind].inbox && preferences[kind].push;
}

/** Whether a notification of `kind` goes to the person's Telegram chat: as for push (pushWanted). */
export function telegramWanted(preferences: NotificationPreferences, kind: NotificationKind) {
  if (isOwnerKind(kind)) return true;
  return preferences[kind].inbox && preferences[kind].telegram;
}

/** Whether this person wants emails about `kind` (on unless they turned them off). */
export async function wantsEmail(userId: string, kind: PreferenceKind) {
  return (await getNotificationPreferences(userId))[kind].email;
}

/** The kinds this person keeps in their inbox (what waits for an owner always). */
export async function inboxKinds(userId: string): Promise<NotificationKind[]> {
  const prefs = await getNotificationPreferences(userId);
  return [...KINDS.filter((kind) => prefs[kind].inbox), ...OWNER_KINDS];
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

"use server";

import {
  archiveNotifications,
  cancelReminder,
  dueReminders,
  listInbox,
  listPending,
  markRead,
  markUnread,
  recentArrivals,
  snoozeNotification,
  unarchiveNotifications,
  unreadCount,
  unsnoozeNotification,
} from "@/server/notifications";
import { findMembership } from "@/server/access";
import { requireUserId } from "@/server/session";
import { workspaceSettings } from "@/server/workspaces";

/**
 * The inbox, only the email that came in on rows (`tab` "email"), the archived notifications
 * (`tab` "archived") or what is still to come (`tab` "scheduled": AI reminders and snoozed
 * notifications, soonest first), and whether the workspace has email on rows turned on (the Email
 * tab shows only then). `unread`: only the notifications not read yet.
 */
export async function listInboxAction(workspaceId: string, tab: "all" | "email" | "archived" | "scheduled" = "all", unread = false) {
  const userId = await requireUserId();
  // The inbox is the person's own wherever they are; the workspace's setting is for its people.
  const [items, settings, membership] = await Promise.all([
    tab === "scheduled"
      ? listPending(userId, String(workspaceId))
      : listInbox(userId, workspaceId, tab === "email" ? ["row_email"] : undefined, tab === "archived", unread === true),
    workspaceSettings(workspaceId),
    findMembership(userId, String(workspaceId)),
  ]);
  return { items, email: membership ? settings.email : false };
}

const ids = (list: unknown) =>
  Array.isArray(list) ? list.filter((id): id is string => typeof id === "string").slice(0, 500) : [];

/** Archives the given notifications. */
export async function archiveAction(workspaceId: string, notificationIds: string[]) {
  const userId = await requireUserId();
  await archiveNotifications(userId, String(workspaceId), ids(notificationIds));
}

/** Archives every read notification of the inbox. */
export async function archiveReadAction(workspaceId: string) {
  const userId = await requireUserId();
  return archiveNotifications(userId, String(workspaceId), "read");
}

/** Moves archived notifications back to the inbox. */
export async function unarchiveAction(workspaceId: string, notificationIds: string[]) {
  const userId = await requireUserId();
  await unarchiveNotifications(userId, String(workspaceId), ids(notificationIds));
}

/** The agents' reminders that came and wait to be seen, for the window over the page. */
export async function dueRemindersAction(workspaceId: string) {
  const userId = await requireUserId();
  return dueReminders(userId, String(workspaceId));
}

/** What people just sent the user, for the cards over the page. */
export async function arrivalsAction(workspaceId: string) {
  const userId = await requireUserId();
  return recentArrivals(userId, String(workspaceId));
}

export async function unreadCountAction(workspaceId: string) {
  const userId = await requireUserId();
  return unreadCount(userId, workspaceId);
}

/** Marks the given notifications read, or the whole inbox without ids. */
export async function markReadAction(workspaceId: string, notificationIds?: string[]) {
  const userId = await requireUserId();
  await markRead(userId, workspaceId, notificationIds);
}

/** Marks the given notifications unread again. */
export async function markUnreadAction(workspaceId: string, notificationIds: string[]) {
  const userId = await requireUserId();
  if (!Array.isArray(notificationIds) || !notificationIds.every((id) => typeof id === "string")) return;
  await markUnread(userId, workspaceId, notificationIds.slice(0, 500));
}

/** Snoozes a notification until `until` (ISO, the viewer's choice); false when that can't be done. */
export async function snoozeAction(notificationId: string, until: string) {
  const userId = await requireUserId();
  return snoozeNotification(userId, notificationId, new Date(until));
}

/** Cancels one of the user's AI reminders that hasn't come yet; false when there is none. */
export async function cancelReminderAction(notificationId: string) {
  const userId = await requireUserId();
  if (typeof notificationId !== "string") return false;
  return cancelReminder(userId, notificationId);
}

/** Brings a snoozed notification back to the inbox now; false when none waits. */
export async function unsnoozeAction(notificationId: string) {
  const userId = await requireUserId();
  if (typeof notificationId !== "string") return false;
  return unsnoozeNotification(userId, notificationId);
}

"use server";

import {
  archiveNotifications,
  listInbox,
  markRead,
  markUnread,
  snoozeNotification,
  unarchiveNotifications,
  unreadCount,
} from "@/server/notifications";
import { requireUserId } from "@/server/session";
import { workspaceSettings } from "@/server/workspaces";

/**
 * The inbox, only the email that came in on rows (`tab` "email") or the archived notifications
 * (`tab` "archived"), and whether the workspace has email on rows turned on (the Email tab shows
 * only then). `unread`: only the notifications not read yet.
 */
export async function listInboxAction(workspaceId: string, tab: "all" | "email" | "archived" = "all", unread = false) {
  const userId = await requireUserId();
  const [items, settings] = await Promise.all([
    listInbox(userId, workspaceId, tab === "email" ? ["row_email"] : undefined, tab === "archived", unread === true),
    workspaceSettings(workspaceId),
  ]);
  return { items, email: settings.email };
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

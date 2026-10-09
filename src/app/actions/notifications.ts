"use server";

import { listInbox, markRead, snoozeNotification, unreadCount } from "@/server/notifications";
import { requireUserId } from "@/server/session";

export async function listInboxAction(workspaceId: string) {
  const userId = await requireUserId();
  return listInbox(userId, workspaceId);
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

/** Snoozes a notification until `until` (ISO, the viewer's choice); false when that can't be done. */
export async function snoozeAction(notificationId: string, until: string) {
  const userId = await requireUserId();
  return snoozeNotification(userId, notificationId, new Date(until));
}

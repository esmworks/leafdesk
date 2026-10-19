"use server";

import { listInbox, markRead, snoozeNotification, unreadCount } from "@/server/notifications";
import { requireUserId } from "@/server/session";
import { workspaceSettings } from "@/server/workspaces";

/**
 * The inbox, or only the email that came in on rows (`tab` "email"), and whether the workspace has
 * email on rows turned on (the Email tab shows only then).
 */
export async function listInboxAction(workspaceId: string, tab: "all" | "email" = "all") {
  const userId = await requireUserId();
  const [items, settings] = await Promise.all([listInbox(userId, workspaceId, tab === "email" ? ["row_email"] : undefined), workspaceSettings(workspaceId)]);
  return { items, email: settings.email };
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

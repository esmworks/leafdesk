"use server";

import { isOwnerKind, NOTIFICATION_KINDS, type PreferenceKind } from "@/db/schema";
import { isDesktopLinks } from "@/lib/desktop-links";
import { setDesktopLinks } from "@/server/desktop-links";
import { NOTIFICATION_CHANNELS, setNotificationPreference, type NotificationChannel } from "@/server/notification-preferences";
import { requireUserId } from "@/server/session";

/** Turns one kind of notification on or off in the inbox, by email or as push notifications, on every device. */
export async function setNotificationPreferenceAction(kind: PreferenceKind, channel: NotificationChannel, on: boolean) {
  const userId = await requireUserId();
  if (!NOTIFICATION_KINDS.includes(kind) || isOwnerKind(kind) || !NOTIFICATION_CHANNELS.includes(channel) || typeof on !== "boolean") {
    throw new Error("Unknown notification preference");
  }
  await setNotificationPreference(userId, kind, channel, on);
}

/** Whether links opened in a browser offer to go on to the desktop app, go there at once, or neither. */
export async function setDesktopLinksAction(value: string | null) {
  const userId = await requireUserId();
  if (!isDesktopLinks(value)) throw new Error("Unknown desktop links preference");
  await setDesktopLinks(userId, value);
}

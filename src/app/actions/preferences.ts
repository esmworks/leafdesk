"use server";

import { NOTIFICATION_KINDS, type PreferenceKind } from "@/db/schema";
import { NOTIFICATION_CHANNELS, setNotificationPreference, type NotificationChannel } from "@/server/notification-preferences";
import { requireUserId } from "@/server/session";

/** Turns one kind of notification on or off in the inbox, by email or as push notifications, on every device. */
export async function setNotificationPreferenceAction(kind: PreferenceKind, channel: NotificationChannel, on: boolean) {
  const userId = await requireUserId();
  if (!NOTIFICATION_KINDS.includes(kind) || (kind as string) === "agent_approval" || !NOTIFICATION_CHANNELS.includes(channel) || typeof on !== "boolean") {
    throw new Error("Unknown notification preference");
  }
  await setNotificationPreference(userId, kind, channel, on);
}

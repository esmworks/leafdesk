"use server";

import { NOTIFICATION_KINDS, type PreferenceKind } from "@/db/schema";
import { setNotificationPreference, type NotificationChannel } from "@/server/notification-preferences";
import { requireUserId } from "@/server/session";

/** Turns one kind of notification on or off in the inbox or by email, on every device. */
export async function setNotificationPreferenceAction(kind: PreferenceKind, channel: NotificationChannel, on: boolean) {
  const userId = await requireUserId();
  if (!NOTIFICATION_KINDS.includes(kind) || (kind as string) === "agent_approval" || (channel !== "inbox" && channel !== "email") || typeof on !== "boolean") {
    throw new Error("Unknown notification preference");
  }
  await setNotificationPreference(userId, kind, channel, on);
}

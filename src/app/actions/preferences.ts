"use server";

import { getIconPreferences, isIconColor, isSkinTone, setIconPreferences, type IconPreferences } from "@/server/icon-preferences";
import { isOwnerKind, NOTIFICATION_KINDS, type PreferenceKind } from "@/db/schema";
import { isDesktopLinks } from "@/lib/desktop-links";
import { setDesktopLinks } from "@/server/desktop-links";
import { isOpenOnStart } from "@/lib/open-on-start";
import { setOpenOnStart } from "@/server/open-on-start";
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

/** Whether the app starts on the workspace's home page or on the page opened last. */
export async function setOpenOnStartAction(value: string | null) {
  const userId = await requireUserId();
  if (!isOpenOnStart(value)) throw new Error("Unknown start page preference");
  await setOpenOnStart(userId, value);
}

/** The icon picker's remembered skin tone and icon color (server/icon-preferences.ts). */
export async function getIconPreferencesAction(): Promise<IconPreferences> {
  const userId = await requireUserId();
  return getIconPreferences(userId);
}

/** Remembers the icon picker's skin tone or icon color (null forgets it); what is left out stays. */
export async function setIconPreferencesAction(patch: { skinTone?: number | null; iconColor?: string | null }) {
  const userId = await requireUserId();
  if (!patch || typeof patch !== "object") throw new Error("Unknown icon preference");
  const { skinTone, iconColor } = patch;
  if (skinTone !== undefined && skinTone !== null && !isSkinTone(skinTone)) throw new Error("Unknown skin tone");
  if (iconColor !== undefined && iconColor !== null && !isIconColor(iconColor)) throw new Error("Unknown icon color");
  await setIconPreferences(userId, {
    ...(skinTone !== undefined ? { skinTone } : {}),
    ...(iconColor !== undefined ? { iconColor: iconColor as IconPreferences["iconColor"] } : {}),
  });
}

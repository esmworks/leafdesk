import { createTranslator } from "next-intl";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { notification, telegramLink } from "@/db/schema";
import { telegramMessages } from "@/i18n/messages/telegram";
import { env } from "@/lib/env";
import { formatIsoDate } from "@/lib/mentions";
import { pushPayload } from "@/lib/push";
import { escapeHtml } from "@/lib/telegram-format";
import { AccessError, workspacesHiddenFromApp } from "@/server/access";
import { runAsConnectedApp } from "@/server/connected-app";
import { recipientLocale } from "@/server/mail/locale";
import { emailTranslator } from "@/server/mail/templates";
import { getNotificationPreferences, telegramWanted } from "@/server/notification-preferences";
import { listNotifications, markRead, snoozeNotification } from "@/server/notifications";
import { sendMessage, TelegramApiError } from "./api";
import { setTelegramNotifications } from "./links";

/**
 * Inbox notifications in Telegram: each new one also goes, as a message, to the Telegram chat its
 * recipient linked (links.ts), when they left notifications on there and the kind on in their
 * preferences (user_preference's `…Telegram` columns, which follow the inbox as push does). Called
 * with the push notifications (server/push.ts), after the notification is saved; it never holds up
 * or fails what caused it.
 *
 * A message says what a push notification says (lib/push.ts pushPayload: the page and who did
 * what, never what a comment, a value or an email says, since a lock screen shows it to whoever
 * holds the phone), names the workspace, links to where the inbox leads, and has buttons to mark it
 * read or snooze it for an hour. The chat is a connected app's: notifications of a workspace that
 * turned connected apps off don't go there. A chat that blocked the bot gets nothing more: its
 * notifications are turned off until the person turns them on again in the settings.
 */

export async function deliverTelegram(ids: string[]): Promise<void> {
  if (!ids.length || !env.telegramBotToken) return;
  const rows = await db
    .select({ id: notification.id, userId: notification.userId, kind: notification.kind, locale: notification.emailLocale })
    .from(notification)
    .where(and(inArray(notification.id, ids), isNull(notification.readAt)));
  if (!rows.length) return;
  const links = await db
    .select()
    .from(telegramLink)
    .where(and(inArray(telegramLink.userId, [...new Set(rows.map((r) => r.userId))]), eq(telegramLink.notifications, true)));
  await Promise.all(
    links.map(async (link) => {
      const preferences = await getNotificationPreferences(link.userId);
      const theirs = rows.filter((r) => r.userId === link.userId && telegramWanted(preferences, r.kind));
      if (!theirs.length) return;
      const items = await runAsConnectedApp({ userId: link.userId }, async () => {
        const [listed, hidden] = await Promise.all([
          listNotifications(link.userId, { ids: theirs.map((r) => r.id), unreadOnly: true }),
          workspacesHiddenFromApp(link.userId),
        ]);
        return listed.filter((item) => !hidden.has(item.workspaceId));
      });
      if (!items.length) return;
      const locale = await recipientLocale(link.userId, theirs.find((r) => r.locale)?.locale);
      const te = emailTranslator(locale);
      const texts = (key: string, values?: Record<string, string | number>) => te(`push.${key}` as Parameters<typeof te>[0], values);
      const t = createTranslator({ locale, messages: { telegram: telegramMessages[locale] }, namespace: "telegram.notify" });
      for (const item of items) {
        const payload = pushPayload(item, texts, (date, timeZone) => formatIsoDate(date, locale, "medium", timeZone));
        if (!payload) continue;
        const text = [
          `<b>${escapeHtml(payload.title)}</b>`,
          escapeHtml(payload.body),
          `<i>${escapeHtml(item.workspaceName)}</i> · <a href="${escapeHtml(`${env.appUrl}${payload.url}`)}">${escapeHtml(t("open"))}</a>`,
        ].join("\n");
        const keyboard = {
          inline_keyboard: [
            [
              { text: t("markRead"), callback_data: `nr:${item.id}` },
              ...(payload.snooze ? [{ text: payload.snooze, callback_data: `nz:${item.id}` }] : []),
            ],
          ],
        };
        try {
          await sendMessage(link.chatId, text, { keyboard });
        } catch (error) {
          // 403: the person blocked the bot or deleted the chat; stop until they turn it on again.
          if (error instanceof TelegramApiError && error.code === 403) {
            await setTelegramNotifications(link.userId, false);
            return;
          }
          throw error;
        }
      }
    }),
  );
}

/** How long the Snooze button puts a notification away for, as in the inbox's quickest choice. */
export const SNOOZE_MS = 60 * 60_000;

/**
 * A notification's button pressed in Telegram: marks it read, or snoozes it for SNOOZE_MS. False
 * when it isn't the person's or no longer can be (gone, or in a workspace they left or that
 * turned connected apps off).
 */
export async function answerNotification(userId: string, notificationId: string, action: "read" | "snooze"): Promise<boolean> {
  const [found] = await db
    .select({ workspaceId: notification.workspaceId })
    .from(notification)
    .where(and(eq(notification.id, notificationId), eq(notification.userId, userId)))
    .limit(1);
  if (!found) return false;
  return runAsConnectedApp({ userId }, async () => {
    if ((await workspacesHiddenFromApp(userId)).has(found.workspaceId)) return false;
    if (action === "snooze") return snoozeNotification(userId, notificationId, new Date(Date.now() + SNOOZE_MS));
    try {
      await markRead(userId, found.workspaceId, [notificationId]);
      return true;
    } catch (error) {
      if (error instanceof AccessError) return false;
      throw error;
    }
  });
}

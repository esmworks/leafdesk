import { env } from "@/lib/env";
import { chatNotificationsOn, createChatLinkCode, linkView, setChatNotifications, unlinkChat, type ChatLinkView } from "@/server/chat-apps/links";
import { callApi, type TelegramUser } from "./api";

/**
 * Telegram links (server/chat-apps/links.ts) as the settings make them: a one-time code opens the
 * bot (`https://t.me/<bot>?start=<code>`), and the bot links the Telegram account that sends
 * `/start <code>` to the code's user.
 */

export { LINK_CODE_TTL_MS } from "@/server/chat-apps/links";

/** What the settings show: whether the server has a bot, its name, and the person's link. */
export type TelegramStatus = { enabled: boolean; bot: string | null; link: ChatLinkView | null };

/** The bot's @username, asked of Telegram once per process (and again after a failure). */
let botName: Promise<string> | null = null;
export function botUsername(): Promise<string> {
  botName ??= callApi<TelegramUser>("getMe").then(
    (me) => me.username ?? "",
    (error) => {
      botName = null;
      throw error;
    },
  );
  return botName;
}

export async function getTelegramStatus(userId: string): Promise<TelegramStatus> {
  if (!env.telegramBotToken) return { enabled: false, bot: null, link: null };
  const [link, bot] = await Promise.all([linkView("telegram", userId), botUsername().catch(() => null)]);
  return { enabled: true, bot, link };
}

/** Whether the person's notifications go to a Telegram chat they linked (see chat-apps/notify.ts). */
export const telegramNotificationsOn = (userId: string) => chatNotificationsOn("telegram", userId);

/** Turns sending the person's notifications to their linked Telegram chat on or off. */
export const setTelegramNotifications = (userId: string, on: boolean) => setChatNotifications("telegram", userId, on);

/**
 * A new link code for the person (replacing one they had), and the address that opens the bot
 * with it. A session a sign-in policy holds back can't make one (createChatLinkCode).
 */
export async function createLinkCode(userId: string): Promise<{ url: string; expiresAt: Date }> {
  if (!env.telegramBotToken) throw new Error("Telegram is not set up on this server");
  const { code, expiresAt } = await createChatLinkCode("telegram", userId);
  return { url: `https://t.me/${await botUsername()}?start=${code}`, expiresAt };
}

/** Unlinks the person's Telegram account, telling them there; false when none was linked. */
export const unlinkTelegram = (userId: string, notice?: string) => unlinkChat("telegram", userId, notice);

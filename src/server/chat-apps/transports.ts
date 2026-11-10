import { env } from "@/lib/env";
import { telegramTransport } from "@/server/telegram/transport";
import type { ChatChannel, Transport } from "./transport";

/** The chat apps this server has a bot in (set up through its env), by channel. */

export function chatAppOn(channel: ChatChannel): boolean {
  if (channel === "telegram") return Boolean(env.telegramBotToken);
  return false;
}

/** Whether any chat app is set up: notifications and routines' summaries look for links only then. */
export const anyChatApp = () => chatAppOn("telegram");

/** The transport of a chat app set up here, else null (its links wait until it is again). */
export function transportOf(channel: ChatChannel): Transport | null {
  if (!chatAppOn(channel)) return null;
  return channel === "telegram" ? telegramTransport : null;
}

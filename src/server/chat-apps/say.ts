import { createTranslator } from "next-intl";
import { DEFAULT_LOCALE, negotiateLocale, type Locale } from "@/i18n/config";
import { telegramMessages } from "@/i18n/messages/telegram";
import { sourceHref, type ChatSourceView, type ChatStepView } from "@/lib/ai-chat";
import { env } from "@/lib/env";
import { pageLabel } from "@/lib/labels";
import { escapeHtml, packMessages } from "@/lib/telegram-format";
import { savedLocale } from "@/server/mail/locale";
import type { ChatLinkRow } from "./links";
import type { Buttons, ChatChannel, Transport } from "./transport";
import { transportOf } from "./transports";

/** The bot's texts and how it sends them, shared by the bot (bot.ts) and its chats with agents (agent-chat.ts). */

const baseTranslator = (locale: Locale) => createTranslator({ locale, messages: { telegram: telegramMessages[locale] }, namespace: "telegram" });
type BaseTranslator = ReturnType<typeof baseTranslator>;
export type TextKey = Parameters<BaseTranslator>[0];
export type Translator = (key: TextKey, values?: Record<string, string | number>) => string;

/** Commands named in the texts (`/new`), which Slack's app takes as `/leafdesk new`. */
const NAMED_COMMAND = /(^|[\s(“"«„'‘「（])\/(new|workspace|agent|mode|stop|notifications|unlink|help)\b/g;

/**
 * The bot's texts in a language, as a chat app shows them: in Slack, the texts kept for it under
 * `telegram.slack.*` take the place of those that speak of Telegram, and commands are written as
 * its slash command takes them.
 */
export function translatorFor(locale: Locale, channel: ChatChannel = "telegram"): Translator {
  const t = baseTranslator(locale);
  if (channel !== "slack") return (key, values) => t(key, values as never);
  return (key, values) => {
    const own = `slack.${key}` as TextKey;
    return t(t.has(own) ? own : key, values as never).replace(NAMED_COMMAND, "$1/leafdesk $2");
  };
}

/** The person's language: the one they last used Leafdesk in, else their chat app's. */
export async function localeOf(userId: string | null, languageCode?: string): Promise<Locale> {
  const saved = userId ? await savedLocale(userId).catch(() => null) : null;
  return saved ?? (languageCode ? negotiateLocale(languageCode) : DEFAULT_LOCALE);
}

/**
 * A translated text as HTML with its values put in as given HTML: the text is escaped, the values
 * aren't (escape them with escapeHtml unless they are markup).
 */
export function html(t: Translator, key: TextKey, values: Record<string, string> = {}): string {
  const tokens = Object.fromEntries(Object.keys(values).map((name, i) => [name, `\u0001${i}\u0001`]));
  const list = Object.values(values);
  return escapeHtml(t(key, tokens)).replace(/\u0001(\d+)\u0001/g, (_, i: string) => list[Number(i)]);
}

/** A chat the bot writes in: a chat app's transport and the chat's id there. */
export type Chat = { transport: Transport; id: string };

/** The link's own chat; throws when its chat app isn't set up here any more (nothing can reach it). */
export function chatOf(link: Pick<ChatLinkRow, "channel" | "chatId">): Chat {
  const transport = transportOf(link.channel);
  if (!transport) throw new Error(`${link.channel} is not set up on this server`);
  return { transport, id: link.chatId };
}

/** Sends messages of the HTML subset, the buttons under the last; the last one's id. */
export async function sendHtml(chat: Chat, messages: string[], buttons?: Buttons): Promise<string | null> {
  let last: string | null = null;
  for (const [i, text] of messages.entries()) last = await chat.transport.send(chat.id, text, i === messages.length - 1 && buttons ? { buttons } : {});
  return last;
}

export const send = (chat: Chat, text: string, buttons?: Buttons) => sendHtml(chat, [text], buttons);

/** Blocks of HTML (lib/telegram-format.ts) packed into as few messages as the chat app's length allows. */
export const packFor = (chat: Chat, blocks: string[]) => packMessages(blocks, chat.transport.messageLimit);

/** A page of the workspace as an address in the app. */
export const appPageUrl = (source: Pick<ChatSourceView, "workspaceId" | "pageId" | "blockId">) => {
  const href = sourceHref(source);
  return href ? `${env.appUrl}${href}` : null;
};

/** The pages an answer made or changed (and changes declined), one line each, linked: an empty string when none. */
export function changeLines(t: Translator, steps: readonly { kind: string }[]): string {
  return steps
    .flatMap((step) => {
      if (step.kind !== "write") return [];
      const write = step as Extract<ChatStepView, { kind: "write" }>;
      // A link only to the row or page made or changed: a declined new one has none.
      const page = write.page ?? (write.action === "updateRow" || write.action === "editPage" ? write.target : null);
      const title = escapeHtml(pageLabel(write.title ?? page?.title ?? "", t("approval.aPage")));
      const href = page ? appPageUrl({ workspaceId: page.workspaceId, pageId: page.pageId, blockId: null }) : null;
      return [html(t, `changed.${write.outcome}`, { what: href ? `<a href="${escapeHtml(href)}">${title}</a>` : title })];
    })
    .join("\n");
}

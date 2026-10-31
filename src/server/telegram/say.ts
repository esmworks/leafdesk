import { createTranslator } from "next-intl";
import { DEFAULT_LOCALE, negotiateLocale, type Locale } from "@/i18n/config";
import { telegramMessages } from "@/i18n/messages/telegram";
import { sourceHref, type ChatSourceView, type ChatStepView } from "@/lib/ai-chat";
import { env } from "@/lib/env";
import { pageLabel } from "@/lib/labels";
import { escapeHtml, htmlToText } from "@/lib/telegram-format";
import { savedLocale } from "@/server/mail/locale";
import { sendMessage, TelegramApiError, type InlineKeyboard } from "./api";

/** The bot's texts and how it sends them, shared by the bot (bot.ts) and its chats with agents (agent-chat.ts). */

export type Translator = ReturnType<typeof translatorFor>;

export function translatorFor(locale: Locale) {
  return createTranslator({ locale, messages: { telegram: telegramMessages[locale] }, namespace: "telegram" });
}

/** The person's language: the one they last used Leafdesk in, else their Telegram app's. */
export async function localeOf(userId: string | null, languageCode?: string): Promise<Locale> {
  const saved = userId ? await savedLocale(userId).catch(() => null) : null;
  return saved ?? (languageCode ? negotiateLocale(languageCode) : DEFAULT_LOCALE);
}

/**
 * A translated text as HTML with its values put in as given HTML: the text is escaped, the values
 * aren't (escape them with escapeHtml unless they are markup).
 */
export function html(t: Translator, key: Parameters<Translator>[0], values: Record<string, string> = {}): string {
  const tokens = Object.fromEntries(Object.keys(values).map((name, i) => [name, `\u0001${i}\u0001`]));
  const list = Object.values(values);
  return escapeHtml(t(key, tokens)).replace(/\u0001(\d+)\u0001/g, (_, i: string) => list[Number(i)]);
}

/** Sends HTML messages, each again as plain text when Telegram can't parse its markup. */
export async function sendHtml(chatId: string, messages: string[], keyboard?: InlineKeyboard): Promise<number | null> {
  let last: number | null = null;
  for (const [i, text] of messages.entries()) {
    const options = i === messages.length - 1 && keyboard ? { keyboard } : {};
    try {
      last = await sendMessage(chatId, text, options);
    } catch (error) {
      if (!(error instanceof TelegramApiError && error.code === 400)) throw error;
      last = await sendMessage(chatId, htmlToText(text), { ...options, plain: true });
    }
  }
  return last;
}

export const send = (chatId: string, text: string, keyboard?: InlineKeyboard) => sendHtml(chatId, [text], keyboard);

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

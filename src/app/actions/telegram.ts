"use server";

import { getTranslations } from "next-intl/server";
import type { ActionResult } from "@/app/actions/workspaces";
import { createTranslator } from "next-intl";
import { telegramMessages } from "@/i18n/messages/telegram";
import { createLinkCode, getTelegramStatus, unlinkTelegram, type TelegramStatus } from "@/server/telegram/links";
import { savedLocale } from "@/server/mail/locale";
import { DEFAULT_LOCALE } from "@/i18n/config";
import { requireUserId } from "@/server/session";

// Settings > Apps > Telegram: linking the person's Telegram account to the AI chat (see
// server/telegram). Failures come back translated: Next.js hides thrown messages in production.

async function run<T>(fn: (userId: string) => Promise<T>): Promise<ActionResult<T>> {
  const userId = await requireUserId();
  try {
    return { ok: true, data: await fn(userId) };
  } catch (error) {
    console.error("[telegram action]", error instanceof Error ? error.message : error);
    const t = await getTranslations("account.telegram");
    return { ok: false, error: t("unreachable") };
  }
}

export async function getTelegramStatusAction(): Promise<ActionResult<TelegramStatus>> {
  return run((userId) => getTelegramStatus(userId));
}

/** A link that opens the bot with a new one-time code (see createLinkCode). */
export async function createTelegramLinkAction(): Promise<ActionResult<{ url: string; expiresAt: string }>> {
  return run(async (userId) => {
    const { url, expiresAt } = await createLinkCode(userId);
    return { url, expiresAt: expiresAt.toISOString() };
  });
}

/** Unlinks the person's Telegram account and tells them so there, in their language. */
export async function unlinkTelegramAction(): Promise<ActionResult<TelegramStatus>> {
  return run(async (userId) => {
    const locale = (await savedLocale(userId)) ?? DEFAULT_LOCALE;
    const t = createTranslator({ locale, messages: { telegram: telegramMessages[locale] }, namespace: "telegram" });
    await unlinkTelegram(userId, t("unlinkedInSettings"));
    return getTelegramStatus(userId);
  });
}

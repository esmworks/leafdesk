"use server";

import { getTranslations } from "next-intl/server";
import type { ActionResult } from "@/app/actions/workspaces";
import { createTranslator } from "next-intl";
import { telegramMessages } from "@/i18n/messages/telegram";
import { createLinkCode, getTelegramStatus, setTelegramNotifications, unlinkTelegram, type TelegramStatus } from "@/server/telegram/links";
import { savedLocale } from "@/server/mail/locale";
import { DEFAULT_LOCALE } from "@/i18n/config";
import { WorkspacePolicyError } from "@/server/access";
import { policyGatePath, requireUserId } from "@/server/session";

// Settings > Apps > Telegram: linking the person's Telegram account to the AI chat (see
// server/telegram). Failures come back translated: Next.js hides thrown messages in production.

async function run<T>(fn: (userId: string) => Promise<T>): Promise<ActionResult<T>> {
  const userId = await requireUserId();
  try {
    return { ok: true, data: await fn(userId) };
  } catch (error) {
    return failed(error);
  }
}

async function failed(error: unknown): Promise<{ ok: false; error: string }> {
  console.error("[telegram action]", error instanceof Error ? error.message : error);
  const t = await getTranslations("account.telegram");
  return { ok: false, error: t("unreachable") };
}

export async function getTelegramStatusAction(): Promise<ActionResult<TelegramStatus>> {
  return run((userId) => getTelegramStatus(userId));
}

export type TelegramLinkResult =
  | ActionResult<{ url: string; expiresAt: string }>
  /** A workspace's sign-in policy holds the session back: `gate` is where it meets the policy. */
  | { ok: false; error: "policy"; gate: string };

/** A link that opens the bot with a new one-time code (see createLinkCode). */
export async function createTelegramLinkAction(): Promise<TelegramLinkResult> {
  const userId = await requireUserId();
  try {
    const { url, expiresAt } = await createLinkCode(userId);
    return { ok: true, data: { url, expiresAt: expiresAt.toISOString() } };
  } catch (error) {
    if (error instanceof WorkspacePolicyError) return { ok: false, error: "policy", gate: policyGatePath(error.workspaceId, error.hold) };
    return failed(error);
  }
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

/** Turns the person's notifications in their linked Telegram chat on or off. */
export async function setTelegramNotificationsAction(on: boolean): Promise<ActionResult<TelegramStatus>> {
  return run(async (userId) => {
    if (typeof on !== "boolean") throw new Error("on must be true or false");
    await setTelegramNotifications(userId, on);
    return getTelegramStatus(userId);
  });
}

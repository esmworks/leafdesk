"use server";

import { getTranslations } from "next-intl/server";
import type { ActionResult } from "@/app/actions/workspaces";
import { createTranslator } from "next-intl";
import { telegramMessages } from "@/i18n/messages/telegram";
import { createSlackLinkCode, getSlackStatus, setSlackNotifications, unlinkSlack, type SlackStatus } from "@/server/slack/links";
import { savedLocale } from "@/server/mail/locale";
import { DEFAULT_LOCALE } from "@/i18n/config";
import { WorkspacePolicyError } from "@/server/access";
import { policyGatePath, requireUserId } from "@/server/session";

// Settings > Apps > Slack: linking the person's Slack account to the AI chat (see server/slack).
// Failures come back translated: Next.js hides thrown messages in production.

async function run<T>(fn: (userId: string) => Promise<T>): Promise<ActionResult<T>> {
  const userId = await requireUserId();
  try {
    return { ok: true, data: await fn(userId) };
  } catch (error) {
    return failed(error);
  }
}

async function failed(error: unknown): Promise<{ ok: false; error: string }> {
  console.error("[slack action]", error instanceof Error ? error.message : error);
  const t = await getTranslations("account.slack");
  return { ok: false, error: t("unreachable") };
}

export async function getSlackStatusAction(): Promise<ActionResult<SlackStatus>> {
  return run((userId) => getSlackStatus(userId));
}

export type SlackLinkResult =
  | ActionResult<{ command: string; expiresAt: string }>
  /** A workspace's sign-in policy holds the session back: `gate` is where it meets the policy. */
  | { ok: false; error: "policy"; gate: string };

/** The command that links the person's Slack account with a new one-time code (see createSlackLinkCode). */
export async function createSlackLinkAction(): Promise<SlackLinkResult> {
  const userId = await requireUserId();
  try {
    const { command, expiresAt } = await createSlackLinkCode(userId);
    return { ok: true, data: { command, expiresAt: expiresAt.toISOString() } };
  } catch (error) {
    if (error instanceof WorkspacePolicyError) return { ok: false, error: "policy", gate: policyGatePath(error.workspaceId, error.hold) };
    return failed(error);
  }
}

/** Unlinks the person's Slack account and tells them so there, in their language. */
export async function unlinkSlackAction(): Promise<ActionResult<SlackStatus>> {
  return run(async (userId) => {
    const locale = (await savedLocale(userId)) ?? DEFAULT_LOCALE;
    const t = createTranslator({ locale, messages: { telegram: telegramMessages[locale] }, namespace: "telegram" });
    await unlinkSlack(userId, t("unlinkedInSettings"));
    return getSlackStatus(userId);
  });
}

/** Turns the person's notifications in their direct message with the Slack app on or off. */
export async function setSlackNotificationsAction(on: boolean): Promise<ActionResult<SlackStatus>> {
  return run(async (userId) => {
    if (typeof on !== "boolean") throw new Error("on must be true or false");
    await setSlackNotifications(userId, on);
    return getSlackStatus(userId);
  });
}

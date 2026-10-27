"use server";

import { getTranslations } from "next-intl/server";
import { LegalHoldError } from "@/lib/legal-hold";
import type { Letterhead } from "@/lib/letterheads";
import { AccessError } from "@/server/access";
import type { PdfTheme } from "@/lib/pdf-themes";
import { isAiError } from "@/server/ai";
import { createLetterhead, deleteLetterhead, LetterheadError, listLetterheads, setDefaultLetterhead, setLetterheadTheme, updateLetterhead } from "@/server/letterheads";
import { MAX_THEME_INSTRUCTION, suggestPdfTheme } from "@/server/pdf-theme-ai";
import { requireUserId } from "@/server/session";

type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string; code?: string; problems?: string[] };

// Expected failures are returned, translated, since Next hides thrown messages in production.
async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (error) {
    if (error instanceof LegalHoldError) return { ok: false, error: (await getTranslations("settings.legalHolds.errors"))(error.code), code: error.code };
    if (isAiError(error)) {
      const t = await getTranslations();
      const seconds = error.retryAfterMs ? Math.ceil(error.retryAfterMs / 1000) : 0;
      return { ok: false, error: error.code === "invalid" ? t("settings.letterheads.errors.aiTheme") : t(`ai.errors.${error.code}`, { seconds }), code: error.code };
    }
    const code = error instanceof LetterheadError ? error.code : error instanceof AccessError ? "notFound" : null;
    if (!code) throw error;
    const t = await getTranslations("settings.letterheads.errors");
    return { ok: false, error: t(code), code, ...(error instanceof LetterheadError && error.problems.length ? { problems: error.problems } : {}) };
  }
}

const id = (value: unknown) => (typeof value === "string" && value.length <= 100 ? value : "");

/** The workspace's letterheads, for the PDF dialog and Settings; none for guests. */
export async function listLetterheadsAction(workspaceId: string): Promise<ActionResult<Letterhead[]>> {
  const userId = await requireUserId();
  return run(() => listLetterheads(userId, id(workspaceId)));
}

export async function createLetterheadAction(workspaceId: string, fields: unknown): Promise<ActionResult<Letterhead>> {
  const userId = await requireUserId();
  return run(() => createLetterhead(userId, id(workspaceId), fields));
}

export async function updateLetterheadAction(letterheadId: string, fields: unknown): Promise<ActionResult<Letterhead>> {
  const userId = await requireUserId();
  return run(() => updateLetterhead(userId, id(letterheadId), fields));
}

export async function deleteLetterheadAction(letterheadId: string): Promise<ActionResult> {
  const userId = await requireUserId();
  return run(async () => {
    await deleteLetterhead(userId, id(letterheadId));
    return undefined;
  });
}

export async function setDefaultLetterheadAction(letterheadId: string, isDefault: boolean): Promise<ActionResult> {
  const userId = await requireUserId();
  return run(async () => {
    await setDefaultLetterhead(userId, id(letterheadId), isDefault === true);
    return undefined;
  });
}

/** Gives a letterhead a theme, or with null takes it off (server/letterheads.ts setLetterheadTheme). */
export async function setLetterheadThemeAction(letterheadId: string, theme: unknown): Promise<ActionResult<Letterhead>> {
  const userId = await requireUserId();
  return run(() => setLetterheadTheme(userId, id(letterheadId), theme ?? null));
}

/** A theme changed as the owner asks, checked, not saved (server/pdf-theme-ai.ts). */
export async function suggestPdfThemeAction(letterheadId: string, current: unknown, instruction: string): Promise<ActionResult<PdfTheme>> {
  const userId = await requireUserId();
  return run(() => suggestPdfTheme(userId, id(letterheadId), { current: current ?? null, instruction: typeof instruction === "string" ? instruction.slice(0, MAX_THEME_INSTRUCTION) : "" }));
}

"use server";

import { getTranslations } from "next-intl/server";
import type { Letterhead } from "@/lib/letterheads";
import { AccessError } from "@/server/access";
import { createLetterhead, deleteLetterhead, LetterheadError, listLetterheads, setDefaultLetterhead, updateLetterhead } from "@/server/letterheads";
import { requireUserId } from "@/server/session";

type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string; code?: string };

// Expected failures are returned, translated, since Next hides thrown messages in production.
async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (error) {
    const code = error instanceof LetterheadError ? error.code : error instanceof AccessError ? "notFound" : null;
    if (!code) throw error;
    const t = await getTranslations("settings.letterheads.errors");
    return { ok: false, error: t(code), code };
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

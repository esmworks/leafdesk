"use server";

import { getTranslations } from "next-intl/server";
import type { ActionResult } from "@/app/actions/workspaces";
import type { AiAccountInput, AiAccountView, WorkspaceAiView } from "@/lib/ai-accounts";
import { AccessError } from "@/server/access";
import {
  addAiAccount,
  AiAccountError,
  deleteAiAccount,
  setDefaultAiAccount,
  setWorkspaceAiAccount,
  testAiAccount,
  updateAiAccount,
} from "@/server/ai-accounts";
import { requireUserId } from "@/server/session";

// Settings > Apps > AI (the person's own AI accounts) and the workspace's AI account (see
// server/ai-accounts.ts). Expected failures come back translated: Next.js hides thrown messages in
// production.

async function run<T>(fn: (userId: string) => Promise<T>): Promise<ActionResult<T>> {
  const userId = await requireUserId();
  try {
    return { ok: true, data: await fn(userId) };
  } catch (error) {
    const t = await getTranslations("ai.accounts.errors");
    if (error instanceof AiAccountError) return { ok: false, error: t(error.code, { message: error.detail ?? "" }), code: error.code };
    if (error instanceof AccessError) return { ok: false, error: t("ownersOnly"), code: "ownersOnly" };
    console.error("[ai account action]", error);
    const tc = await getTranslations("common");
    return { ok: false, error: tc("genericError") };
  }
}

export async function addAiAccountAction(input: AiAccountInput): Promise<ActionResult<AiAccountView[]>> {
  return run((userId) => addAiAccount(userId, input));
}

export async function updateAiAccountAction(id: string, input: AiAccountInput): Promise<ActionResult<AiAccountView[]>> {
  return run((userId) => updateAiAccount(userId, id, input));
}

export async function testAiAccountAction(id: string): Promise<ActionResult<AiAccountView[]>> {
  return run((userId) => testAiAccount(userId, id));
}

export async function setDefaultAiAccountAction(id: string): Promise<ActionResult<AiAccountView[]>> {
  return run((userId) => setDefaultAiAccount(userId, id));
}

export async function deleteAiAccountAction(id: string): Promise<ActionResult<AiAccountView[]>> {
  return run((userId) => deleteAiAccount(userId, id));
}

export async function setWorkspaceAiAccountAction(workspaceId: string, accountId: string | null): Promise<ActionResult<WorkspaceAiView | null>> {
  return run((userId) => setWorkspaceAiAccount(userId, workspaceId, accountId));
}

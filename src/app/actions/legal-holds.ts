"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { LegalHoldError } from "@/lib/legal-hold";
import { AccessError } from "@/server/access";
import { legalHoldCandidates, releaseLegalHold, setLegalHold } from "@/server/legal-hold";
import { requireUserId } from "@/server/session";

/** A failure carries its message, in the viewer's language, and its code. */
export type LegalHoldResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string; code: string };

async function run<T>(fn: (userId: string) => Promise<T>): Promise<LegalHoldResult<T>> {
  const userId = await requireUserId();
  try {
    return { ok: true, data: await fn(userId) };
  } catch (error) {
    const t = await getTranslations("settings.legalHolds.errors");
    if (error instanceof LegalHoldError) return { ok: false, error: t(error.code), code: error.code };
    if (error instanceof AccessError) return { ok: false, error: t("ownersOnly"), code: "ownersOnly" };
    throw error;
  }
}

const refresh = (workspaceId: string) => revalidatePath(`/w/${workspaceId}/settings`);

/** Who a new hold may be put on (Settings > Security > Legal holds). Owners only. */
export async function legalHoldCandidatesAction(workspaceId: string) {
  return run((userId) => legalHoldCandidates(userId, workspaceId));
}

export async function setLegalHoldAction(workspaceId: string, input: { name: string; reason: string; userIds: string[] }) {
  const result = await run((userId) => setLegalHold(userId, workspaceId, input));
  if (result.ok) refresh(workspaceId);
  return result;
}

export async function releaseLegalHoldAction(workspaceId: string, holdId: string) {
  const result = await run((userId) => releaseLegalHold(userId, workspaceId, typeof holdId === "string" ? holdId : ""));
  if (result.ok) refresh(workspaceId);
  return result;
}

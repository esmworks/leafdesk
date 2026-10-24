"use server";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";
import { AccessError } from "@/server/access";
import { dismissSensitiveFinding } from "@/server/sensitive-content";
import { requireUserId } from "@/server/session";

export type SensitiveFindingResult = { ok: true } | { ok: false; error: string };

/** Dismisses an open finding of sensitive content (Settings > Security). Owners only. */
export async function dismissSensitiveFindingAction(workspaceId: string, findingId: string): Promise<SensitiveFindingResult> {
  const userId = await requireUserId();
  const t = await getTranslations();
  if (typeof workspaceId !== "string" || typeof findingId !== "string") return { ok: false, error: t("common.genericError") };
  try {
    await dismissSensitiveFinding(userId, workspaceId, findingId);
    revalidatePath(`/w/${workspaceId}/settings`);
    return { ok: true };
  } catch (error) {
    if (error instanceof AccessError) return { ok: false, error: t("settings.sensitiveContent.errors.gone") };
    console.error("[dismiss sensitive finding]", error);
    return { ok: false, error: t("common.genericError") };
  }
}

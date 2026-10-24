"use server";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";
import { checkedUntil, isVerificationDuration, verificationEnd, type VerificationDuration, type VerificationView } from "@/lib/verification";
import { AccessError } from "@/server/access";
import { requireUserId } from "@/server/session";
import { setPageVerification, VerificationError } from "@/server/verification";

export type VerificationResult = { ok: true; data: VerificationView | null } | { ok: false; error: string };

/** How long to verify for: a duration, through a time (the end of a day the person chose, in their zone), or with no end. */
export type VerificationChoice = { duration: VerificationDuration } | { until: string } | { forever: true };

/**
 * Verifies the page (full access, see server/verification), or removes its verification
 * (`choice` null).
 */
export async function setPageVerificationAction(workspaceId: string, pageId: string, choice: VerificationChoice | null): Promise<VerificationResult> {
  const userId = await requireUserId();
  const t = await getTranslations();
  let until: Date | null | undefined;
  if (choice === null) until = undefined;
  else if ("forever" in choice && choice.forever === true) until = null;
  else if ("duration" in choice && isVerificationDuration(choice.duration)) until = verificationEnd(choice.duration, new Date());
  else if ("until" in choice && typeof choice.until === "string") {
    until = checkedUntil(new Date(choice.until));
    if (!until) return { ok: false, error: t("page.verification.errors.invalidEnd") };
  } else return { ok: false, error: t("common.genericError") };
  try {
    const { verification } = await setPageVerification(userId, String(pageId), until);
    revalidatePath(`/w/${workspaceId}/p/${pageId}`);
    return { ok: true, data: verification };
  } catch (error) {
    if (error instanceof VerificationError) return { ok: false, error: t(`page.verification.errors.${error.code}`) };
    if (error instanceof AccessError) return { ok: false, error: t("database.errors.accessDenied") };
    console.error("[set page verification]", error);
    return { ok: false, error: t("common.genericError") };
  }
}

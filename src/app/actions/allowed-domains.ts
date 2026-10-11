"use server";

import { revalidatePath } from "next/cache";
import { AccessError } from "@/server/access";
import { AllowedDomainError, type AllowedDomainErrorCode, type AllowedDomainStatus, verifyAllowedDomain } from "@/server/allowed-domains";
import { requireUserId } from "@/server/session";

export type AllowedDomainActionResult =
  | { ok: true; data: AllowedDomainStatus[] }
  | { ok: false; error: AllowedDomainErrorCode | "ownersOnly" | "generic"; detail?: string };

/** Checks the DNS record of one allowed domain; expected failures come back as codes the settings row translates. */
export async function verifyAllowedDomainAction(workspaceId: string, domain: string): Promise<AllowedDomainActionResult> {
  const userId = await requireUserId();
  try {
    const data = await verifyAllowedDomain(userId, String(workspaceId), String(domain ?? ""));
    revalidatePath(`/w/${workspaceId}/settings`, "page");
    return { ok: true, data };
  } catch (error) {
    if (error instanceof AllowedDomainError) return { ok: false, error: error.code, detail: error.detail };
    if (error instanceof AccessError) return { ok: false, error: "ownersOnly" };
    console.error("verifying an allowed domain failed", error);
    return { ok: false, error: "generic" };
  }
}

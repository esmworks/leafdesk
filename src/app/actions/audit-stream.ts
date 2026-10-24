"use server";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";
import { AccessError } from "@/server/access";
import {
  AuditStreamError,
  removeAuditStream,
  replaceAuditStreamSecret,
  saveAuditStream,
  sendAuditStreamTest,
  type StreamSendResult,
} from "@/server/audit-stream";
import { requireUserId } from "@/server/session";

export type AuditStreamResult<T = null> = { ok: true; data: T } | { ok: false; error: string };

async function run<T>(workspaceId: unknown, what: string, work: (userId: string, workspaceId: string) => Promise<T>): Promise<AuditStreamResult<T>> {
  const userId = await requireUserId();
  const t = await getTranslations();
  if (typeof workspaceId !== "string") return { ok: false, error: t("common.genericError") };
  try {
    const data = await work(userId, workspaceId);
    revalidatePath(`/w/${workspaceId}/settings`);
    return { ok: true, data };
  } catch (error) {
    if (error instanceof AuditStreamError) return { ok: false, error: t(`settings.eventStream.errors.${error.code}`) };
    if (error instanceof AccessError) return { ok: false, error: t("settings.eventStream.errors.ownersOnly") };
    console.error(`[${what}]`, error);
    return { ok: false, error: t("common.genericError") };
  }
}

/** Sets up streaming, or changes its address or whether it is on; a new stream answers its secret, shown once. */
export async function saveAuditStreamAction(workspaceId: string, input: { url?: unknown; enabled?: unknown }) {
  const patch = input && typeof input === "object" ? { url: input.url, enabled: input.enabled } : {};
  return run(workspaceId, "save audit stream", async (userId, id) => {
    const { secret } = await saveAuditStream(userId, id, {
      ...(typeof patch.url === "string" ? { url: patch.url } : {}),
      ...(typeof patch.enabled === "boolean" ? { enabled: patch.enabled } : {}),
    });
    return { secret };
  });
}

export async function replaceAuditStreamSecretAction(workspaceId: string) {
  return run(workspaceId, "replace audit stream secret", (userId, id) => replaceAuditStreamSecret(userId, id));
}

export async function removeAuditStreamAction(workspaceId: string) {
  return run(workspaceId, "remove audit stream", async (userId, id) => {
    await removeAuditStream(userId, id);
    return null;
  });
}

/** Sends a test event now and says how the address answered. */
export async function sendAuditStreamTestAction(workspaceId: string): Promise<AuditStreamResult<StreamSendResult>> {
  return run(workspaceId, "test audit stream", (userId, id) => sendAuditStreamTest(userId, id));
}

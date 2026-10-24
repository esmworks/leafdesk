"use server";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";
import { isPageWebhookScope, type DeliveryCode, type DeliveryStatus } from "@/lib/page-webhooks";
import { AccessError } from "@/server/access";
import { sendTestDelivery } from "@/server/page-webhooks/deliver";
import {
  createPageWebhook,
  deletePageWebhook,
  PageWebhookError,
  pageWebhookSecretFor,
  updatePageWebhook,
  type PageWebhookInput,
} from "@/server/page-webhooks/manage";
import { requireUserId } from "@/server/session";

export type PageWebhookResult<T = null> = { ok: true; data: T } | { ok: false; error: string };

/** What the settings form sends, narrowed by hand: strings, a list of strings, a known scope. */
function narrowInput(value: unknown): PageWebhookInput | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.name !== "string" || typeof v.url !== "string" || !Array.isArray(v.events) || !isPageWebhookScope(v.scope)) return null;
  return {
    name: v.name,
    url: v.url,
    events: v.events.filter((e): e is string => typeof e === "string"),
    scope: v.scope,
    teamspaceId: typeof v.teamspaceId === "string" ? v.teamspaceId : null,
    pageId: typeof v.pageId === "string" ? v.pageId : null,
    enabled: typeof v.enabled === "boolean" ? v.enabled : undefined,
  };
}

async function run<T>(workspaceId: string, what: string, work: () => Promise<T>): Promise<PageWebhookResult<T>> {
  const t = await getTranslations();
  try {
    const data = await work();
    revalidatePath(`/w/${workspaceId}/settings`);
    return { ok: true, data };
  } catch (error) {
    if (error instanceof PageWebhookError) return { ok: false, error: t(`settings.webhooks.errors.${error.code}`) };
    if (error instanceof AccessError) return { ok: false, error: t("settings.webhooks.errors.ownersOnly") };
    console.error(`[${what}]`, error);
    return { ok: false, error: t("common.genericError") };
  }
}

/** Adds a page webhook (owners); answers its signing secret, shown once here. */
export async function createPageWebhookAction(workspaceId: string, input: unknown): Promise<PageWebhookResult<{ id: string; secret: string }>> {
  const userId = await requireUserId();
  const narrowed = narrowInput(input);
  if (typeof workspaceId !== "string" || !narrowed) return { ok: false, error: (await getTranslations())("common.genericError") };
  return run(workspaceId, "create page webhook", async () => {
    const { webhook, secret } = await createPageWebhook(userId, workspaceId, narrowed);
    return { id: webhook.id, secret };
  });
}

/** Changes a page webhook: the whole form, or only whether it is on (`{ enabled }`). */
export async function updatePageWebhookAction(workspaceId: string, webhookId: string, input: unknown): Promise<PageWebhookResult> {
  const userId = await requireUserId();
  const onlySwitch = input && typeof input === "object" && Object.keys(input).length === 1 && typeof (input as { enabled?: unknown }).enabled === "boolean";
  const patch = onlySwitch ? { enabled: (input as { enabled: boolean }).enabled } : narrowInput(input);
  if (typeof workspaceId !== "string" || typeof webhookId !== "string" || !patch) return { ok: false, error: (await getTranslations())("common.genericError") };
  return run(workspaceId, "update page webhook", async () => {
    await updatePageWebhook(userId, webhookId, patch);
    return null;
  });
}

export async function deletePageWebhookAction(workspaceId: string, webhookId: string): Promise<PageWebhookResult> {
  const userId = await requireUserId();
  return run(workspaceId, "delete page webhook", async () => {
    await deletePageWebhook(userId, String(webhookId));
    return null;
  });
}

/** The webhook's signing secret; with `rotate`, a new one (the old one stops at once). */
export async function pageWebhookSecretAction(workspaceId: string, webhookId: string, rotate: boolean): Promise<PageWebhookResult<string>> {
  const userId = await requireUserId();
  return run(workspaceId, "page webhook secret", () => pageWebhookSecretFor(userId, String(webhookId), rotate === true));
}

export type TestDeliveryView = { status: DeliveryStatus | "pending"; code: DeliveryCode | null; httpStatus: number | null };

/** Sends a test ping now and says how the address answered. */
export async function testPageWebhookAction(workspaceId: string, webhookId: string): Promise<PageWebhookResult<TestDeliveryView>> {
  const userId = await requireUserId();
  return run(workspaceId, "test page webhook", async () => {
    const result = await sendTestDelivery(userId, String(webhookId));
    return {
      status: result?.status ?? "failed",
      code: result && "code" in result ? (result.code ?? null) : null,
      httpStatus: result && "httpStatus" in result ? (result.httpStatus ?? null) : null,
    };
  });
}

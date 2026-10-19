"use server";

import { getTranslations } from "next-intl/server";
import type { ActionResult } from "@/app/actions/workspaces";
import type { S3StorageInput, StorageSettingsView } from "@/lib/workspace-storage";
import { AccessError } from "@/server/access";
import { beginStorageOAuth, connectStorage, disconnectStorage, retestStorage, StorageSettingsError, testStorage } from "@/server/storage/settings";
import { requireUserId } from "@/server/session";

// Settings > Storage (see server/storage/settings.ts), for owners. Expected failures come back
// translated: Next.js hides thrown messages in production.

async function run<T>(fn: (userId: string) => Promise<T>): Promise<ActionResult<T>> {
  const userId = await requireUserId();
  try {
    return { ok: true, data: await fn(userId) };
  } catch (error) {
    const t = await getTranslations("settings.storage.errors");
    if (error instanceof StorageSettingsError) {
      return { ok: false, error: t(error.code, { message: error.detail ?? "" }), code: error.code };
    }
    if (error instanceof AccessError) return { ok: false, error: t("accessDenied"), code: "accessDenied" };
    console.error("[storage action]", error);
    const tc = await getTranslations("common");
    return { ok: false, error: tc("genericError") };
  }
}

/** Tries the settings with a test object, without keeping them. */
export async function testStorageAction(workspaceId: string, kind: string, input: S3StorageInput): Promise<ActionResult<undefined>> {
  return run(async (userId) => {
    await testStorage(userId, workspaceId, kind, input);
    return undefined;
  });
}

export async function connectStorageAction(workspaceId: string, kind: string, input: S3StorageInput): Promise<ActionResult<StorageSettingsView>> {
  return run((userId) => connectStorage(userId, workspaceId, kind, input));
}

/** Begins signing in to Google Drive or Dropbox: the address to send the browser to. */
export async function beginStorageOAuthAction(workspaceId: string, kind: string): Promise<ActionResult<{ url: string }>> {
  return run((userId) => beginStorageOAuth(userId, workspaceId, kind));
}

export async function retestStorageAction(workspaceId: string): Promise<ActionResult<StorageSettingsView>> {
  return run((userId) => retestStorage(userId, workspaceId));
}

export async function disconnectStorageAction(workspaceId: string): Promise<ActionResult<StorageSettingsView>> {
  return run((userId) => disconnectStorage(userId, workspaceId));
}

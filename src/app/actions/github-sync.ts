"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import type { ActionResult } from "@/app/actions/databases";
import { isDatabaseErrorCode, PropertyValueError } from "@/lib/properties";
import { AccessError } from "@/server/access";
import {
  getGithubSetup,
  GithubSyncError,
  removeGithubSetup,
  rotateGithubSecret,
  saveGithubSetup,
  type GithubSetupInput,
  type GithubSetupState,
} from "@/server/github-sync/manage";
import { requireUserId } from "@/server/session";

// A database's GitHub setup (see server/github-sync): full access to the database only. Expected
// failures come back translated: Next.js hides thrown messages.

async function run<T>(fn: (userId: string) => Promise<T>): Promise<ActionResult<T>> {
  const userId = await requireUserId();
  try {
    return { ok: true, data: await fn(userId) };
  } catch (error) {
    const t = await getTranslations();
    if (error instanceof GithubSyncError) return { ok: false, error: t(`database.github.errors.${error.code}`) };
    if (error instanceof PropertyValueError && isDatabaseErrorCode(error.code)) return { ok: false, error: t(`database.errors.${error.code}`, error.params ?? {}) };
    if (error instanceof AccessError) return { ok: false, error: t("database.errors.accessDenied") };
    console.error("[github action]", error);
    return { ok: false, error: t("common.genericError") };
  }
}

const text = (value: unknown) => (typeof value === "string" ? value : null);

export async function getGithubSetupAction(databaseId: string): Promise<ActionResult<GithubSetupState>> {
  return run((userId) => getGithubSetup(userId, String(databaseId)));
}

/** Sets up or changes where links go and how statuses move; a new link property is made when asked. */
export async function saveGithubSetupAction(workspaceId: string, databaseId: string, input: GithubSetupInput): Promise<ActionResult<GithubSetupState>> {
  return run(async (userId) => {
    const state = await saveGithubSetup(userId, String(databaseId), {
      linkPropertyId: text(input?.linkPropertyId),
      newLinkProperty: text(input?.newLinkProperty),
      statusPropertyId: text(input?.statusPropertyId),
      opened: text(input?.opened),
      merged: text(input?.merged),
      closed: text(input?.closed),
    });
    // A new link property shows in the database's views.
    if (input?.newLinkProperty) revalidatePath(`/w/${workspaceId}/p/${databaseId}`);
    return state;
  });
}

export async function rotateGithubSecretAction(databaseId: string): Promise<ActionResult<GithubSetupState>> {
  return run((userId) => rotateGithubSecret(userId, String(databaseId)));
}

export async function removeGithubSetupAction(databaseId: string): Promise<ActionResult<undefined>> {
  return run(async (userId) => {
    await removeGithubSetup(userId, String(databaseId));
    return undefined;
  });
}

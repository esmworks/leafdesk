"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import {
  AdminError,
  type AdminErrorCode,
  clearWorkspaceNetworks,
  requirePasswordReset,
  requirePasswordResetForEveryone,
  signOutEveryone,
  signOutUser,
} from "@/server/instance-admin";
import { getSession } from "@/server/session";

/**
 * The admin page's actions (/admin). Each server function checks that the session belongs to an
 * instance admin; anyone else gets `notFound` and nothing happens. Expected failures come back
 * translated, with their code for scripts.
 */
export type AdminResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string; code: AdminErrorCode };

async function run<T>(fn: () => Promise<T>): Promise<AdminResult<T>> {
  try {
    const data = await fn();
    revalidatePath("/admin");
    return { ok: true, data };
  } catch (error) {
    if (!(error instanceof AdminError)) throw error;
    const t = await getTranslations("admin.errors");
    return { ok: false, error: t(error.code), code: error.code };
  }
}

export async function signOutUserAction(userId: string) {
  const current = await getSession();
  return run(() => signOutUser(current, typeof userId === "string" ? userId : ""));
}

export async function signOutEveryoneAction() {
  const current = await getSession();
  return run(() => signOutEveryone(current));
}

export async function requirePasswordResetAction(userId: string) {
  const current = await getSession();
  return run(() => requirePasswordReset(current, typeof userId === "string" ? userId : ""));
}

export async function requirePasswordResetForEveryoneAction() {
  const current = await getSession();
  return run(() => requirePasswordResetForEveryone(current));
}

export async function clearWorkspaceNetworksAction(workspaceId: string) {
  const current = await getSession();
  return run(() => clearWorkspaceNetworks(current, typeof workspaceId === "string" ? workspaceId : ""));
}

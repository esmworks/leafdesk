"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import type { ActionResult } from "@/app/actions/workspaces";
import { AccessError } from "@/server/access";
import { revalidateAccountPages } from "@/server/account-pages";
import { revokeConnectedApp } from "@/server/mcp/grants";
import { requireUserId } from "@/server/session";
import { ApprovedAppsFullError, disconnectWorkspaceApp, setWorkspaceAppApproved } from "@/server/workspace-apps";

/** Disconnects an OAuth client: removes the user's consent and revokes its tokens. */
export async function revokeConnectedAppAction(clientId: string) {
  const userId = await requireUserId();
  await revokeConnectedApp(userId, clientId);
  revalidateAccountPages();
}

/**
 * A workspace owner disconnects one person's app or revokes their API token (Settings > Security):
 * it goes from all of that person's workspaces.
 */
export async function disconnectWorkspaceAppAction(
  workspaceId: string,
  target: { kind: "connected_app" | "api_token"; userId: string; id: string },
): Promise<ActionResult> {
  const userId = await requireUserId();
  const kind = target.kind === "api_token" ? "api_token" : "connected_app";
  try {
    await disconnectWorkspaceApp(userId, String(workspaceId), { kind, userId: String(target.userId), id: String(target.id) });
  } catch (error) {
    if (!(error instanceof AccessError)) throw error;
    const t = await getTranslations("settings.security.workspaceApps");
    return { ok: false, error: t("gone") };
  }
  revalidatePath(`/w/${workspaceId}/settings`);
  revalidateAccountPages();
  return { ok: true, data: undefined };
}

/**
 * A workspace owner approves an app for the workspace, or withdraws the approval (Settings >
 * Security): where only approved apps may come, it reaches the workspace or stops reaching it.
 */
export async function setWorkspaceAppApprovedAction(workspaceId: string, clientId: string, approve: boolean): Promise<ActionResult> {
  const userId = await requireUserId();
  try {
    await setWorkspaceAppApproved(userId, String(workspaceId), String(clientId), approve === true);
  } catch (error) {
    if (!(error instanceof AccessError) && !(error instanceof ApprovedAppsFullError)) throw error;
    const t = await getTranslations("settings.security.workspaceApps");
    return { ok: false, error: t(error instanceof ApprovedAppsFullError ? "approvedFull" : "gone") };
  }
  revalidatePath(`/w/${workspaceId}/settings`);
  return { ok: true, data: undefined };
}

"use server";

import type { SettingsSearchItem } from "@/lib/settings-search";
import { AccessError } from "@/server/access";
import { settingsSearchIndex } from "@/server/settings-search";
import { requireUserId } from "@/server/session";

export type SettingsSearchResult = { ok: true; data: SettingsSearchItem[] } | { ok: false; error: string };

/** The settings this person can see in a workspace, for the command list (Cmd/Ctrl+K, then ">"). */
export async function settingsSearchAction(workspaceId: string): Promise<SettingsSearchResult> {
  const userId = await requireUserId();
  if (typeof workspaceId !== "string") return { ok: false, error: "workspace" };
  try {
    return { ok: true, data: await settingsSearchIndex(userId, workspaceId) };
  } catch (error) {
    if (error instanceof AccessError) return { ok: false, error: "access" };
    throw error;
  }
}

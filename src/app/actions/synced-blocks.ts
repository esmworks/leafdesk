"use server";

import { AccessError } from "@/server/access";
import { requireUserId } from "@/server/session";
import * as synced from "@/server/synced-blocks";

/**
 * What the synced blocks of a page may show this user of their source pages (see
 * server/synced-blocks syncedSources): one call for every source page the page shows blocks of.
 */
export async function syncedSourcesAction(pageIds: string[]): Promise<synced.SyncedSource[]> {
  const userId = await requireUserId();
  if (!Array.isArray(pageIds)) return [];
  return [...(await synced.syncedSources(userId, pageIds.filter((id) => typeof id === "string"))).values()];
}

/** The pages a synced block shows on that the user can see, and how many others; null without access to its page. */
export async function syncedReferencesAction(sourceId: string, syncId: string) {
  const userId = await requireUserId();
  try {
    return await synced.syncedReferences(userId, String(sourceId), String(syncId));
  } catch (error) {
    if (error instanceof AccessError) return null;
    throw error;
  }
}

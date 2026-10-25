"use server";

import { AccessError } from "@/server/access";
import { tagSuggestions, type TagSuggestion } from "@/server/page-tags";
import { requireUserId } from "@/server/session";

/**
 * The tags of the workspace's pages the person can open that start with `prefix` (without its `#`),
 * on the most pages first: what the search box and the editor offer while a `#tag` is typed. None
 * when they can't be had (no access, a sign-in policy holding the person back): it's only a hint.
 */
export async function tagSuggestionsAction(workspaceId: string, prefix: string): Promise<TagSuggestion[]> {
  const userId = await requireUserId();
  if (typeof workspaceId !== "string" || typeof prefix !== "string" || prefix.length > 200) return [];
  try {
    return await tagSuggestions(userId, workspaceId, prefix);
  } catch (error) {
    if (!(error instanceof AccessError)) console.error("[tag suggestions]", error);
    return [];
  }
}

"use server";

import { AccessError } from "@/server/access";
import { relatedPages, type RelatedPage } from "@/server/related-pages";
import { requireUserId } from "@/server/session";

/** The pages closest in meaning to this one that the user can open (server/related-pages); empty when there are none to offer. */
export async function relatedPagesAction(pageId: string): Promise<RelatedPage[]> {
  const userId = await requireUserId();
  if (typeof pageId !== "string") return [];
  try {
    return await relatedPages(userId, pageId);
  } catch (error) {
    if (error instanceof AccessError) return [];
    throw error;
  }
}

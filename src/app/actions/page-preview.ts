"use server";

import type { PagePreview } from "@/lib/page-preview";
import { AccessError } from "@/server/access";
import { pagePreview } from "@/server/page-preview";
import { requireUserId } from "@/server/session";

/**
 * The card a page mention or link shows on hover (server/page-preview), or null when the user may
 * not open the page (nothing about it, not even its title, comes back), it is in the trash, or
 * the id is no page's.
 */
export async function pagePreviewAction(pageId: string): Promise<PagePreview | null> {
  const userId = await requireUserId();
  if (typeof pageId !== "string" || !pageId || pageId.length > 128) return null;
  try {
    return await pagePreview(userId, pageId);
  } catch (error) {
    if (error instanceof AccessError) return null;
    throw error;
  }
}

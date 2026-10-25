import { eq } from "drizzle-orm";
import { db } from "@/db";
import { userPreference } from "@/db/schema";
import { isOpenOnStart, type OpenOnStart } from "@/lib/open-on-start";
import { recentlyViewedPages } from "@/server/page-views";

/** What the app opens on when the person starts it (lib/open-on-start.ts); account-wide. */
export async function getOpenOnStart(userId: string): Promise<OpenOnStart> {
  const [row] = await db.select({ openOnStart: userPreference.openOnStart }).from(userPreference).where(eq(userPreference.userId, userId));
  return isOpenOnStart(row?.openOnStart) ? row.openOnStart : "home";
}

export async function setOpenOnStart(userId: string, value: OpenOnStart) {
  await db
    .insert(userPreference)
    .values({ userId, openOnStart: value })
    .onConflictDoUpdate({ target: userPreference.userId, set: { openOnStart: value, updatedAt: new Date() } });
}

/**
 * Where switching to the workspace leads: for those who start on the page they opened last, the
 * page they opened last in this workspace; null for its home page (also while their views there
 * aren't recorded, or there is none).
 */
export async function workspaceResumePath(userId: string, workspaceId: string): Promise<string | null> {
  if ((await getOpenOnStart(userId)) !== "last_page") return null;
  const [last] = (await recentlyViewedPages(userId, workspaceId, 1)) ?? [];
  return last ? `/w/${workspaceId}/p/${last.id}` : null;
}

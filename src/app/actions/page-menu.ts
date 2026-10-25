"use server";

import { revalidatePath } from "next/cache";
import { duplicatePage } from "@/server/duplicate";
import { setDatabaseLocked } from "@/server/databases";
import { getPageHeaderInfo, listFavorites, setFavorite } from "@/server/page-meta";
import { setPageOutdated } from "@/server/page-outdated";
import { setPageLocked } from "@/server/pages";
import { listWatches, setWatching } from "@/server/page-watch";
import { setFollowing } from "@/server/row-follow";
import { requireUserId } from "@/server/session";

export async function getPageHeaderAction(pageId: string) {
  const userId = await requireUserId();
  return getPageHeaderInfo(userId, pageId);
}

export async function setFavoriteAction(pageId: string, favorite: boolean) {
  const userId = await requireUserId();
  await setFavorite(userId, pageId, favorite);
}

/** Follows a database row, or stops following it (server/row-follow). */
export async function setFollowingAction(rowId: string, following: boolean) {
  const userId = await requireUserId();
  return setFollowing(userId, rowId, following);
}

/** Watches a page, or mutes it (server/page-watch). */
export async function setWatchingAction(pageId: string, watching: boolean) {
  const userId = await requireUserId();
  return setWatching(userId, pageId, watching);
}

/** The pages and teamspaces the user watches, for their notification settings. */
export async function listWatchesAction() {
  const userId = await requireUserId();
  return listWatches(userId);
}

export async function listFavoritesAction(workspaceId: string) {
  const userId = await requireUserId();
  return listFavorites(userId, workspaceId);
}

export async function setDatabaseLockedAction(workspaceId: string, databaseId: string, locked: boolean) {
  const userId = await requireUserId();
  await setDatabaseLocked(userId, databaseId, locked);
  revalidatePath(`/w/${workspaceId}/p/${databaseId}`);
}

export async function setPageLockedAction(workspaceId: string, pageId: string, locked: boolean) {
  const userId = await requireUserId();
  await setPageLocked(userId, pageId, locked);
  revalidatePath(`/w/${workspaceId}/p/${pageId}`);
}

/** Archives a page or unarchives it (server/page-outdated): full access only. */
export async function setPageOutdatedAction(workspaceId: string, pageId: string, outdated: boolean) {
  const userId = await requireUserId();
  const found = await setPageOutdated(userId, pageId, outdated);
  revalidatePath(`/w/${workspaceId}/p/${pageId}`);
  if (found.parentId) revalidatePath(`/w/${workspaceId}/p/${found.parentId}`);
}

/** Copies the page beside the original; `withoutRows` leaves the rows of its databases behind. */
export async function duplicatePageAction(
  pageId: string,
  options: { withoutRows?: boolean } = {},
): Promise<{ ok: true; id: string; workspaceId: string } | { ok: false }> {
  const userId = await requireUserId();
  try {
    const copy = await duplicatePage({ userId }, pageId, { withoutRows: options.withoutRows === true });
    return { ok: true, ...copy };
  } catch (error) {
    console.error("[duplicate page]", error);
    return { ok: false };
  }
}

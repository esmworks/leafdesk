"use server";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";
import { duplicatePage } from "@/server/duplicate";
import { setDatabaseLocked } from "@/server/databases";
import { getPageHeaderInfo, listFavorites, setFavorite } from "@/server/page-meta";
import { setPageLocked } from "@/server/pages";
import { requireUserId } from "@/server/session";

export async function getPageHeaderAction(pageId: string) {
  const userId = await requireUserId();
  return getPageHeaderInfo(userId, pageId);
}

export async function setFavoriteAction(pageId: string, favorite: boolean) {
  const userId = await requireUserId();
  await setFavorite(userId, pageId, favorite);
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

export async function duplicatePageAction(
  pageId: string,
): Promise<{ ok: true; id: string; workspaceId: string } | { ok: false }> {
  const userId = await requireUserId();
  const t = await getTranslations("page.header");
  try {
    const copy = await duplicatePage({ userId }, pageId, t("duplicateSuffix"));
    return { ok: true, ...copy };
  } catch (error) {
    console.error("[duplicate page]", error);
    return { ok: false };
  }
}

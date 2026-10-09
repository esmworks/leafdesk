"use server";

import { revalidatePath } from "next/cache";
import type { PageKind } from "@/db/schema";
import type { PageBackground } from "@/lib/page-background";
import { hasLevel } from "@/server/access";
import * as pages from "@/server/pages";
import { requireUserId } from "@/server/session";
import { databaseSeedNames } from "./seed-names";

export async function createPageAction(input: {
  workspaceId: string;
  parentId?: string | null;
  kind?: PageKind;
  title?: string;
  /** Top-level pages: a teamspace, null for a private page, undefined for the default teamspace. */
  teamspaceId?: string | null;
}) {
  const userId = await requireUserId();
  const seedNames = input.kind === "database" ? await databaseSeedNames() : undefined;
  const created = await pages.createPage({ userId }, { ...input, seedNames });
  return { id: created.id };
}

/** A quick note (app/share): a private page at the top of the workspace, with the text as its content. */
export async function createQuickNoteAction(input: { workspaceId: string; title: string; markdown: string }) {
  const userId = await requireUserId();
  const created = await pages.createPage(
    { userId },
    { workspaceId: input.workspaceId, title: input.title, markdown: input.markdown, teamspaceId: null },
  );
  return { id: created.id };
}

/** `locked`: the page is locked, so its title stays (lib/page-lock); other failures throw. */
export async function renamePageAction(pageId: string, title: string): Promise<{ ok: true } | { ok: false; locked: true }> {
  const userId = await requireUserId();
  try {
    await pages.renamePage({ userId }, pageId, title);
  } catch (error) {
    if ((error as { code?: unknown }).code === "pageLocked") return { ok: false, locked: true };
    throw error;
  }
  return { ok: true };
}

export async function setPageIconAction(pageId: string, icon: string | null) {
  const userId = await requireUserId();
  await pages.setPageIcon(userId, pageId, icon);
}

export async function setPageBackgroundAction(pageId: string, background: PageBackground | null) {
  const userId = await requireUserId();
  await pages.setPageBackground(userId, pageId, background);
}

export async function archivePageAction(pageId: string) {
  const userId = await requireUserId();
  const p = await pages.archivePage(userId, pageId);
  revalidatePath(`/w/${p.workspaceId}`, "layout");
}

export async function restorePageAction(pageId: string) {
  const userId = await requireUserId();
  await pages.restorePage(userId, pageId);
}

export async function deletePagePermanentlyAction(pageId: string) {
  const userId = await requireUserId();
  await pages.deletePagePermanently(userId, pageId);
}

/** `teamspaceId` (top level only): the teamspace to move it to, null for the private pages. */
export async function movePageAction(pageId: string, parentId: string | null, position?: number, teamspaceId?: string | null) {
  const userId = await requireUserId();
  await pages.movePage(userId, pageId, parentId, position, teamspaceId);
}

/** The sidebar's tree and the teamspaces it has sections for. */
export async function getSidebarAction(workspaceId: string) {
  const userId = await requireUserId();
  return pages.getSidebar(userId, workspaceId);
}

export async function listTrashAction(workspaceId: string) {
  const userId = await requireUserId();
  const rows = await pages.listTrash(userId, workspaceId);
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    icon: r.icon,
    kind: r.kind,
    archivedAt: new Date(r.archived_at),
    /** When the retention cleanup deletes it for good; null when the workspace keeps trashed pages. */
    deletesAt: r.deletesAt,
    canRestore: hasLevel(r.level, "edit"),
    canDelete: hasLevel(r.level, "full"),
  }));
}

export async function searchAction(workspaceId: string, query: string) {
  const userId = await requireUserId();
  return pages.searchWithQuery(userId, workspaceId, query);
}

/** What the search box shows before anything is typed: the pages last edited. */
export async function recentSearchAction(workspaceId: string) {
  const userId = await requireUserId();
  return pages.recentPages(userId, workspaceId, 8);
}

export async function listSnapshotsAction(pageId: string) {
  const userId = await requireUserId();
  return pages.listSnapshots(userId, pageId);
}

export async function getSnapshotAction(snapshotId: string) {
  const userId = await requireUserId();
  return pages.getSnapshot(userId, snapshotId);
}

export async function diffSnapshotAction(snapshotId: string, against: "current" | "previous") {
  const userId = await requireUserId();
  // Loaded on demand: it brings the BlockNote server editor along.
  const { diffSnapshot } = await import("@/server/page-history");
  return diffSnapshot(userId, snapshotId, against === "previous" ? "previous" : "current");
}

export async function restoreSnapshotAction(snapshotId: string) {
  const userId = await requireUserId();
  await pages.restoreSnapshot({ userId }, snapshotId);
}

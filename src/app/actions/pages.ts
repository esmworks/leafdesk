"use server";

import { revalidatePath } from "next/cache";
import { getTimeZone, getTranslations } from "next-intl/server";
import type { PageKind } from "@/db/schema";
import { LegalHoldError } from "@/lib/legal-hold";
import type { PageBackground } from "@/lib/page-background";
import { readSearchFilters, readSearchSort } from "@/lib/search-filters";
import { hasLevel } from "@/server/access";
import * as pages from "@/server/pages";
import { getPageSiblings } from "@/server/page-siblings";
import { renameVersion, saveVersion, versionSaveState } from "@/server/page-versions";
import { recentlyViewedPages } from "@/server/page-views";
import { searchFilterOptions } from "@/server/search-filter-options";
import { requireUserId } from "@/server/session";
import { databaseSeedNames } from "./seed-names";

/** The longest content a new page is created with here (a quick note's text). */
const MAX_NEW_PAGE_MARKDOWN = 500_000;

export async function createPageAction(input: {
  workspaceId: string;
  parentId?: string | null;
  kind?: PageKind;
  title?: string;
  /** Top-level pages: a teamspace, null for a private page, undefined for the default teamspace. */
  teamspaceId?: string | null;
  /** The page's content (a quick note's text, see app/share). */
  markdown?: string;
}) {
  const userId = await requireUserId();
  // Only what the app sends: a request can put anything in the arguments, and createPage takes
  // more than these (an icon, row values, a template flag).
  const kind: PageKind = input.kind === "database" ? "database" : "page";
  const markdown = typeof input.markdown === "string" ? input.markdown : undefined;
  if (markdown && markdown.length > MAX_NEW_PAGE_MARKDOWN) {
    throw new Error(`A new page's content can be at most ${MAX_NEW_PAGE_MARKDOWN} characters`);
  }
  const seedNames = kind === "database" ? await databaseSeedNames() : undefined;
  const created = await pages.createPage(
    { userId },
    {
      workspaceId: String(input.workspaceId),
      parentId: typeof input.parentId === "string" ? input.parentId : null,
      kind,
      title: typeof input.title === "string" ? input.title : undefined,
      teamspaceId: input.teamspaceId === null || typeof input.teamspaceId === "string" ? input.teamspaceId : undefined,
      markdown,
      seedNames,
    },
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

/** A legal hold that keeps the page comes back as a message to show; other failures throw. */
export async function deletePagePermanentlyAction(pageId: string): Promise<{ ok: true } | { ok: false; error: string; code: string }> {
  const userId = await requireUserId();
  try {
    await pages.deletePagePermanently(userId, pageId);
    return { ok: true };
  } catch (error) {
    if (!(error instanceof LegalHoldError)) throw error;
    return { ok: false, error: (await getTranslations("settings.legalHolds.errors"))(error.code), code: error.code };
  }
}

/**
 * `teamspaceId` (top level only): the teamspace to move it to, null for the private pages. Returns
 * where the page was, which moving it to again undoes the move.
 */
export async function movePageAction(pageId: string, parentId: string | null, position?: number, teamspaceId?: string | null) {
  const userId = await requireUserId();
  return pages.movePage(userId, pageId, parentId, position, teamspaceId);
}

/** The pages directly under a page that the user can open, in the sidebar's order (subpages blocks). */
export async function listSubpagesAction(workspaceId: string, pageId: string) {
  const userId = await requireUserId();
  const rows = await pages.listChildren(userId, workspaceId, pageId);
  return rows.map(({ id, kind, title, icon }) => ({ id, kind, title, icon }));
}

/** The pages beside a page that the user can see, for its breadcrumb (server/page-siblings). */
export async function getPageSiblingsAction(pageId: string) {
  const userId = await requireUserId();
  return getPageSiblings(userId, String(pageId));
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
    /** A row merged into another one: that row (its title null when the user can't see it). */
    mergedInto: r.mergedInto,
  }));
}

/** `includeOutdated`: archived pages too (server/page-outdated), marked as such. */
/**
 * The search box's query, with its filters (lib/search-filters) and order; a date filter counts in
 * the person's days.
 */
export async function searchAction(workspaceId: string, query: string, includeOutdated = false, filters?: unknown, sort?: unknown) {
  const userId = await requireUserId();
  return pages.searchWithQuery(userId, workspaceId, String(query), 20, {
    includeOutdated: includeOutdated === true,
    filters: readSearchFilters(filters),
    sort: readSearchSort(sort),
    timeZone: await getTimeZone(),
  });
}

/**
 * What the search box shows before anything is typed: the pages the person opened last, or the
 * pages last edited while their views aren't recorded or they haven't opened any yet.
 */
export async function recentSearchAction(workspaceId: string): Promise<{ source: "viewed" | "edited"; pages: pages.RecentPage[] }> {
  const userId = await requireUserId();
  const viewed = await recentlyViewedPages(userId, workspaceId, 8);
  if (viewed?.length) return { source: "viewed", pages: viewed };
  return { source: "edited", pages: await pages.recentPages(userId, workspaceId, 8) };
}

/** The teamspaces and people the search box's filters offer. */
export async function searchFilterOptionsAction(workspaceId: string) {
  const userId = await requireUserId();
  return searchFilterOptions(userId, String(workspaceId));
}

/** `named`: only the versions someone named (lib/page-versions). */
export async function listSnapshotsAction(pageId: string, named?: boolean) {
  const userId = await requireUserId();
  return pages.listSnapshots(userId, String(pageId), { named: named === true });
}

/** Whether Save version would save a new version or offer to name the newest (server/page-versions). */
export async function versionSaveStateAction(pageId: string) {
  const userId = await requireUserId();
  return versionSaveState(userId, String(pageId));
}

type VersionResult<T> = { ok: true; data: T } | { ok: false; error: "invalidName" | "inTrash" };

/** Refusals the version name prompt explains; anything else throws. */
function versionRefusal(error: unknown): VersionResult<never> {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "invalidVersionName") return { ok: false, error: "invalidName" };
  if (code === "pageInTrash") return { ok: false, error: "inTrash" };
  throw error;
}

/** Saves the page as a version named `name` (unnamed when empty), or names the newest when nothing changed. */
export async function saveVersionAction(
  pageId: string,
  name: string,
): Promise<VersionResult<{ id: string; renamed: boolean; name: string | null }>> {
  const userId = await requireUserId();
  try {
    return { ok: true, data: await saveVersion({ userId }, String(pageId), name) };
  } catch (error) {
    return versionRefusal(error);
  }
}

/** Names a saved version, or clears its name when `name` is empty. */
export async function renameVersionAction(snapshotId: string, name: string): Promise<VersionResult<{ id: string; name: string | null }>> {
  const userId = await requireUserId();
  try {
    const renamed = await renameVersion(userId, String(snapshotId), name);
    return { ok: true, data: { id: String(snapshotId), name: renamed.name } };
  } catch (error) {
    return versionRefusal(error);
  }
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

/** The AI changes waiting for review on the page (server/page-review.ts), or null. */
export async function getPageReviewAction(pageId: string) {
  const userId = await requireUserId();
  // Loaded on demand: it brings the BlockNote server editor along.
  const { getPageReview } = await import("@/server/page-review");
  return getPageReview(userId, String(pageId));
}

/** Keeps or undoes one AI change on the page, or all of them (`changeId` null). */
export async function decidePageReviewAction(pageId: string, version: string, changeId: string | null, decision: "keep" | "undo") {
  const userId = await requireUserId();
  const { decidePageReview } = await import("@/server/page-review");
  return decidePageReview(
    { userId },
    String(pageId),
    String(version),
    typeof changeId === "string" ? changeId : null,
    decision === "undo" ? "undo" : "keep",
  );
}

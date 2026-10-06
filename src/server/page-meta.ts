import { and, asc, eq, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { page, pageFavorite, type PageKind, user } from "@/db/schema";
import { countAccessRequests } from "@/server/access-requests";
import { aiAvailable } from "@/server/ai-writing";
import { AccessError, isGuest, pageVisibleTo, requireMembership, resolvePageAccess, type AccessLevel } from "@/server/access";
import { exportAllowed, topLevelAccess } from "@/server/workspaces";

/** What the page header shows: who made and last changed the page, the viewer's access and star. */
export type PageHeaderInfo = {
  level: AccessLevel;
  /** Guests can't move pages to the top of the workspace. */
  guest: boolean;
  /** Whether they may add pages at the top, e.g. a copy of a top-level page. */
  topLevel: boolean;
  createdAt: Date;
  createdBy: string | null;
  updatedAt: Date;
  updatedBy: string | null;
  favorite: boolean;
  locked: boolean;
  /**
   * Set when the page is a template or lies under one: pages made from it copy it. "workspace"
   * for the template picker's pages, "row" for a database's row templates, "inside" below either.
   */
  template: "workspace" | "row" | "inside" | null;
  /** The AI writing assistant is available: the server has a provider and the workspace has AI on. */
  ai: boolean;
  /** The workspace lets people export its pages (the menu's export and print entries). */
  exportable: boolean;
  /** Requests for access waiting on the page; counted for those who can answer them (full access), else 0. */
  accessRequests: number;
};

export async function getPageHeaderInfo(userId: string, pageId: string): Promise<PageHeaderInfo> {
  const { page: found, level } = await resolvePageAccess(userId, pageId);
  if (!found || level === "none") throw new AccessError();
  const creator = alias(user, "creator");
  const editor = alias(user, "editor");
  const [[names], [star], membership, topLevel, ai, exportable, accessRequests] = await Promise.all([
    db
      .select({ createdBy: creator.name, updatedBy: editor.name })
      .from(page)
      .leftJoin(creator, eq(creator.id, page.createdBy))
      .leftJoin(editor, eq(editor.id, page.updatedBy))
      .where(eq(page.id, pageId)),
    db
      .select({ pageId: pageFavorite.pageId })
      .from(pageFavorite)
      .where(and(eq(pageFavorite.userId, userId), eq(pageFavorite.pageId, pageId))),
    requireMembership(userId, found.workspaceId),
    topLevelAccess(userId, found.workspaceId),
    aiAvailable(found.workspaceId),
    exportAllowed(found.workspaceId),
    level === "full" ? countAccessRequests(pageId) : 0,
  ]);
  return {
    level,
    guest: isGuest(membership.role),
    topLevel: topLevel !== null,
    createdAt: found.createdAt,
    createdBy: names?.createdBy ?? null,
    updatedAt: found.updatedAt,
    updatedBy: names?.updatedBy ?? null,
    favorite: Boolean(star),
    locked: Boolean(found.lockedAt),
    template: found.isTemplate ? (found.parentId ? "row" : "workspace") : found.inTemplate ? "inside" : null,
    ai,
    exportable,
    accessRequests,
  };
}

/** Stars or unstars a page for the user. Anyone who can see a page may star it. */
export async function setFavorite(userId: string, pageId: string, favorite: boolean) {
  const { page: found, level } = await resolvePageAccess(userId, pageId);
  if (!found || level === "none") throw new AccessError();
  if (favorite) {
    await db.insert(pageFavorite).values({ userId, pageId }).onConflictDoNothing();
  } else {
    await db.delete(pageFavorite).where(and(eq(pageFavorite.userId, userId), eq(pageFavorite.pageId, pageId)));
  }
  return { workspaceId: found.workspaceId };
}

/** Whether the user starred the page; the caller has checked they can see it. */
export async function isFavorite(userId: string, pageId: string): Promise<boolean> {
  const [star] = await db
    .select({ pageId: pageFavorite.pageId })
    .from(pageFavorite)
    .where(and(eq(pageFavorite.userId, userId), eq(pageFavorite.pageId, pageId)))
    .limit(1);
  return Boolean(star);
}

export type FavoritePage = {
  id: string;
  title: string;
  icon: string | null;
  kind: PageKind;
  teamspaceId: string | null;
  updatedAt: Date;
};

/**
 * The user's starred pages in a workspace, oldest star first. Pages in the trash or no longer
 * visible to them are left out (the star comes back if the page does).
 */
export async function listFavorites(userId: string, workspaceId: string): Promise<FavoritePage[]> {
  await requireMembership(userId, workspaceId);
  return db
    .select({ id: page.id, title: page.title, icon: page.icon, kind: page.kind, teamspaceId: page.teamspaceId, updatedAt: page.updatedAt })
    .from(pageFavorite)
    .innerJoin(page, eq(page.id, pageFavorite.pageId))
    .where(
      and(
        eq(pageFavorite.userId, userId),
        eq(page.workspaceId, workspaceId),
        isNull(page.archivedAt),
        eq(page.inTemplate, false),
        pageVisibleTo(userId),
      ),
    )
    .orderBy(asc(pageFavorite.createdAt));
}

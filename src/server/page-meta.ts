import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { page, pageFavorite, type PageKind, user } from "@/db/schema";
import type { VoiceNoteLimits } from "@/lib/voice-notes";
import { countAccessRequests } from "@/server/access-requests";
import { aiAvailable } from "@/server/ai-writing";
import { voiceNoteLimits } from "@/server/voice-notes";
import { AccessError, isGuest, pageVisibleTo, requireMembership, resolvePageAccess, type AccessLevel } from "@/server/access";
import { isOutdated, outdatedState, type OutdatedState } from "@/server/page-outdated";
import { isWatching } from "@/server/page-watch";
import { isFollowing } from "@/server/row-follow";
import { skillDescriptionProperty } from "@/server/skills";
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
  /** The body's words (runs of characters between spaces) and characters, line breaks left out. */
  words: number;
  characters: number;
  favorite: boolean;
  locked: boolean;
  /**
   * Set when the page is a template or lies under one: pages made from it copy it. "workspace"
   * for the template picker's pages, "row" for a database's row templates, "inside" below either.
   */
  template: "workspace" | "row" | "inside" | null;
  /** The AI writing assistant is available: the server has a provider and the workspace has AI on. */
  ai: boolean;
  /** Voice notes work here: the recording limits, null when the server can't transcribe or AI is off. */
  voice: VoiceNoteLimits | null;
  /** The workspace lets people export its pages (the menu's export and print entries). */
  exportable: boolean;
  /** Requests for access waiting on the page; counted for those who can answer them (full access), else 0. */
  accessRequests: number;
  /**
   * Set when the page is a skill: what it is for (empty until someone writes it), and for a row of
   * a skills database the name of the property that holds it (server/skills), else null.
   */
  skill: { description: string; property: string | null } | null;
  /** Databases: whether it is a skills database, whose rows are skills (server/skills). */
  skillDatabase: boolean;
  /** Database rows: whether the user hears about others' changes to it (server/row-follow); null for other pages. */
  following: boolean | null;
  /** Other pages: whether the user hears about others' edits and new comment threads (server/page-watch); null for rows and templates. */
  watching: boolean | null;
  /** Set when the page is archived, itself or through a page above it: by whom, when (server/page-outdated). */
  outdated: OutdatedState | null;
};

export async function getPageHeaderInfo(userId: string, pageId: string): Promise<PageHeaderInfo> {
  const { page: found, level } = await resolvePageAccess(userId, pageId);
  if (!found || level === "none") throw new AccessError();
  const creator = alias(user, "creator");
  const editor = alias(user, "editor");
  const isSkill = found.isSkill && !found.inTemplate;
  const [[names], [star], membership, topLevel, ai, voice, exportable, accessRequests, following, watching, outdated, skillProperty] = await Promise.all([
    db
      .select({
        createdBy: creator.name,
        updatedBy: editor.name,
        words: sql<number>`(select count(*) from regexp_matches(${page.contentText}, '\\S+', 'g'))`.mapWith(Number),
        characters: sql<number>`char_length(regexp_replace(${page.contentText}, '[\\r\\n]', '', 'g'))`.mapWith(Number),
      })
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
    voiceNoteLimits(found.workspaceId),
    exportAllowed(found.workspaceId),
    level === "full" ? countAccessRequests(pageId) : 0,
    found.parentId ? isFollowing(userId, pageId) : null,
    isWatching(userId, pageId),
    outdatedState(userId, pageId),
    isSkill && found.parentId ? skillDescriptionProperty(found.parentId) : null,
  ]);
  return {
    level,
    guest: isGuest(membership.role),
    topLevel: topLevel !== null,
    createdAt: found.createdAt,
    createdBy: names?.createdBy ?? null,
    updatedAt: found.updatedAt,
    updatedBy: names?.updatedBy ?? null,
    words: names?.words ?? 0,
    characters: names?.characters ?? 0,
    favorite: Boolean(star),
    locked: Boolean(found.lockedAt),
    template: found.isTemplate ? (found.parentId ? "row" : "workspace") : found.inTemplate ? "inside" : null,
    ai,
    voice,
    exportable,
    accessRequests,
    skill: isSkill ? { description: found.skillDescription, property: skillProperty?.name ?? null } : null,
    skillDatabase: found.kind === "database" && found.isSkillDatabase,
    following,
    watching,
    outdated,
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
  /** Archived, itself or through a page above it (server/page-outdated): still listed, the user starred it. */
  outdated: boolean;
};

/**
 * The user's starred pages in a workspace, oldest star first. Pages in the trash or no longer
 * visible to them are left out (the star comes back if the page does).
 */
export async function listFavorites(userId: string, workspaceId: string): Promise<FavoritePage[]> {
  await requireMembership(userId, workspaceId);
  return db
    .select({
      id: page.id,
      title: page.title,
      icon: page.icon,
      kind: page.kind,
      teamspaceId: page.teamspaceId,
      updatedAt: page.updatedAt,
      outdated: isOutdated(workspaceId),
    })
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

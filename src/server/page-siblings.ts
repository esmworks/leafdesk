import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { page, type PageKind } from "@/db/schema";
import { accessRank, childVisibleTo, levelFromRank, requirePageAccess } from "@/server/access";
import { getTree, type TreeNode } from "@/server/pages";

/** The most rows of a database listed beside one of them; the database itself lists the rest. */
export const SIBLING_ROW_LIMIT = 50;

export type SiblingPage = { id: string; title: string; icon: string | null; kind: PageKind };

export type PageSiblings = {
  /** The pages beside it, itself included while it isn't in the trash, in the sidebar's order. */
  pages: SiblingPage[];
  /** For a database row: its database, when the user can see it. */
  database: SiblingPage | null;
  /** A database row: its database has more rows than `pages` lists. */
  more: boolean;
};

const siblingColumns = { id: page.id, title: page.title, icon: page.icon, kind: page.kind };

/**
 * The pages beside a page, for jumping sideways from the breadcrumb: the other subpages of its
 * parent, the other rows of its database (in their own order, at most SIBLING_ROW_LIMIT), or for
 * a page at the top level, the other top-level pages of the sidebar section it shows in. Only
 * pages the user can see; a page they can't see is refused the way a missing one is.
 */
export async function getPageSiblings(userId: string, pageId: string): Promise<PageSiblings> {
  const target = await requirePageAccess(userId, pageId, "view");
  const none: PageSiblings = { pages: [], database: null, more: false };
  if (!target.parentId) {
    return { ...none, pages: topLevelSiblings(await getTree(userId, target.workspaceId), target) };
  }
  const [parent] = await db
    .select({ ...siblingColumns, level: accessRank(userId, sql`${page.id}`) })
    .from(page)
    .where(eq(page.id, target.parentId));
  if (parent?.kind === "database") {
    // Row templates aren't rows: the database's views leave them out too.
    const rows = await db
      .select(siblingColumns)
      .from(page)
      .where(
        and(eq(page.parentId, parent.id), eq(page.isTemplate, false), isNull(page.archivedAt), childVisibleTo(userId, parent.id)),
      )
      .orderBy(asc(page.position), asc(page.createdAt))
      .limit(SIBLING_ROW_LIMIT + 1);
    const { level, ...database } = parent;
    return {
      pages: rows.slice(0, SIBLING_ROW_LIMIT),
      database: levelFromRank(level) === "none" ? null : database,
      more: rows.length > SIBLING_ROW_LIMIT,
    };
  }
  // In the sidebar's order (getTree). A page of a template lists the pages beside it there.
  const pages = await db
    .select(siblingColumns)
    .from(page)
    .where(
      and(
        eq(page.parentId, target.parentId),
        isNull(page.archivedAt),
        eq(page.inTemplate, target.inTemplate),
        childVisibleTo(userId, target.parentId),
      ),
    )
    .orderBy(asc(page.position), asc(page.createdAt));
  return { ...none, pages };
}

/**
 * The top-level pages of the sidebar section `target` shows in (a teamspace, private pages or
 * pages shared with the user), in the sidebar's order. A page the sidebar doesn't list (one of a
 * teamspace the user hasn't joined, a template) stands alone.
 */
export function topLevelSiblings(
  tree: TreeNode[],
  target: { id: string; title: string; icon: string | null; kind: PageKind; archivedAt: Date | null },
): SiblingPage[] {
  const node = tree.find((n) => n.id === target.id);
  if (!node) return target.archivedAt ? [] : [{ id: target.id, title: target.title, icon: target.icon, kind: target.kind }];
  return tree
    .filter((n) => n.parentId === null && n.section === node.section)
    .map((n) => ({ id: n.id, title: n.title, icon: n.icon, kind: n.kind }));
}

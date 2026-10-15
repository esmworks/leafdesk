import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { page, pagePublication } from "@/db/schema";
import { accessRank, requirePageAccess } from "@/server/access";
import type { PageBlock } from "@/server/blocknote";
import { getCollab } from "@/server/collab/bridge";
import { chainTo } from "@/server/publication";
import { bodyDatabaseIds } from "@/server/published-body";
import { publishingOn } from "@/server/workspaces";

export type LeftOutDatabase = { id: string; title: string; icon: string | null };

/**
 * The databases the page's body shows (database blocks and dashboard widgets) that its published
 * page leaves out because they don't lie under it: a published page shows a database only when it
 * is published with the page, reachable from it like a subpage (see publication.ts publishedEmbed).
 * Asked for whoever published the page, or for the user when it isn't published yet.
 *
 * Lists only live databases the user can see, so it names nothing they couldn't open; trashed ones
 * are left out too, since moving them wouldn't help. Empty while the workspace has publishing off,
 * when nothing is shown anyway.
 */
export async function databasesLeftOut(userId: string, pageId: string): Promise<LeftOutDatabase[]> {
  const target = await requirePageAccess(userId, pageId, "view");
  if (target.kind !== "page" || !(await publishingOn(target.workspaceId))) return [];
  const ids = bodyDatabaseIds((await getCollab().readBlocks(pageId)).blocks as PageBlock[]);
  if (!ids.length) return [];

  const [databases, [published]] = await Promise.all([
    db
      .select({ id: page.id, title: page.title, icon: page.icon })
      .from(page)
      .where(and(inArray(page.id, ids), eq(page.kind, "database"), isNull(page.archivedAt), sql`${accessRank(userId, sql`${page.id}`)} > 0`)),
    db.select({ publishedBy: pagePublication.publishedBy }).from(pagePublication).where(eq(pagePublication.pageId, pageId)).limit(1),
  ]);
  const publisher = published?.publishedBy ?? userId;
  const shown = await Promise.all(databases.map(async (d) => (await chainTo(publisher, d.id, pageId)) !== null));
  const leftOut = databases.filter((_, i) => !shown[i]);
  return leftOut.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
}

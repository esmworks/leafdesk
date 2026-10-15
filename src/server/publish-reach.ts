import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { page, pagePublication } from "@/db/schema";
import { accessRank, requirePageAccess } from "@/server/access";
import type { PageBlock } from "@/server/blocknote";
import { getCollab } from "@/server/collab/bridge";
import { chainTo, publishBlocker, PublishError } from "@/server/publication";
import { bodyDatabaseIds } from "@/server/published-body";
import { publishingOn } from "@/server/workspaces";

/** `shown`: the publisher chose to show it on the published page anyway. */
export type OutsideDatabase = { id: string; title: string; icon: string | null; shown: boolean };

/**
 * The databases the page's body shows (database blocks and dashboard widgets) that don't lie under
 * it, so its published page doesn't show them unless the publisher chooses to (see
 * setOutsideDatabases): a published page shows a database it doesn't hold only that way (see
 * publication.ts publishedEmbed). Asked for whoever published the page, or for the user when it
 * isn't published yet.
 *
 * Lists only live databases of the page's workspace the user can see, so it names nothing they
 * couldn't open; trashed ones are left out too. Empty while the workspace has publishing off, when
 * nothing is shown anyway.
 */
export async function outsideDatabases(userId: string, pageId: string): Promise<OutsideDatabase[]> {
  const target = await requirePageAccess(userId, pageId, "view");
  if (target.kind !== "page" || !(await publishingOn(target.workspaceId))) return [];
  const ids = bodyDatabaseIds((await getCollab().readBlocks(pageId)).blocks as PageBlock[]);
  if (!ids.length) return [];

  const [databases, [published]] = await Promise.all([
    db
      .select({ id: page.id, title: page.title, icon: page.icon })
      .from(page)
      .where(
        and(
          inArray(page.id, ids),
          eq(page.kind, "database"),
          eq(page.workspaceId, target.workspaceId),
          isNull(page.archivedAt),
          eq(page.inTemplate, false),
          sql`${accessRank(userId, sql`${page.id}`)} > 0`,
        ),
      ),
    db
      .select({ publishedBy: pagePublication.publishedBy, outside: pagePublication.outsideDatabaseIds })
      .from(pagePublication)
      .where(eq(pagePublication.pageId, pageId))
      .limit(1),
  ]);
  const publisher = published?.publishedBy ?? userId;
  const under = await Promise.all(databases.map(async (d) => (await chainTo(publisher, d.id, pageId)) !== null));
  return databases
    .filter((_, i) => !under[i])
    .sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id))
    .map((d) => ({ ...d, shown: published?.outside.includes(d.id) ?? false }));
}

/**
 * Which of the page's outside databases (see outsideDatabases) its publication shows; needs what
 * publishing needs. Ids that aren't among them right now are dropped, as are the ones chosen
 * before that the body no longer shows.
 */
export async function setOutsideDatabases(userId: string, pageId: string, databaseIds: string[]): Promise<void> {
  const blocker = await publishBlocker(userId, pageId);
  if (blocker) throw new PublishError("You can't change what this page publishes", blocker === "needsFullAccess" ? undefined : blocker);
  const wanted = new Set(databaseIds);
  const shown = (await outsideDatabases(userId, pageId)).filter((d) => wanted.has(d.id)).map((d) => d.id);
  const updated = await db
    .update(pagePublication)
    .set({ outsideDatabaseIds: shown })
    .where(eq(pagePublication.pageId, pageId))
    .returning({ pageId: pagePublication.pageId });
  if (!updated.length) throw new PublishError("The page isn't published");
}

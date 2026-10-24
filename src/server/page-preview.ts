import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { page, user } from "@/db/schema";
import { PREVIEW_EXCERPT, PREVIEW_PROPERTIES, previewExcerpt, previewValueText, type PagePreview } from "@/lib/page-preview";
import { requirePageAccess } from "@/server/access";
import { getRow } from "@/server/databases";
import { displayProperties } from "@/server/mcp/query";
import { getBreadcrumbs } from "@/server/pages";

/**
 * What the card a page mention or link shows on hover holds (lib/page-preview): the page's icon,
 * title, the pages above it, who last edited it and when, and the start of its text, or for a
 * database row its first values (as property access lets the viewer see them). Throws AccessError
 * (or a sign-in policy's error) when the viewer may not open the page, the same whether it exists
 * or not; null for a page in the trash, which mentions show as deleted.
 */
export async function pagePreview(userId: string, pageId: string): Promise<PagePreview | null> {
  const found = await requirePageAccess(userId, pageId, "view");
  if (found.archivedAt) return null;
  const [crumbs, [details], parent] = await Promise.all([
    getBreadcrumbs(userId, pageId),
    db
      .select({ editedBy: user.name, excerpt: sql<string>`left(${page.contentText}, ${PREVIEW_EXCERPT * 2})` })
      .from(page)
      .leftJoin(user, eq(user.id, sql`coalesce(${page.updatedBy}, ${page.createdBy})`))
      .where(eq(page.id, pageId))
      .limit(1),
    found.parentId
      ? db.select({ kind: page.kind }).from(page).where(eq(page.id, found.parentId)).limit(1).then((rows) => rows[0] ?? null)
      : null,
  ]);
  let properties: PagePreview["properties"] = [];
  if (parent?.kind === "database") {
    const row = await getRow(userId, pageId);
    const values = displayProperties(row.properties, row.row.properties, { relations: row.relations, people: row.people });
    properties = Object.entries(values)
      .map(([name, value]) => ({ name, value: previewValueText(value) }))
      .filter((p) => p.value)
      .slice(0, PREVIEW_PROPERTIES);
  }
  return {
    id: found.id,
    workspaceId: found.workspaceId,
    title: found.title,
    icon: found.icon,
    kind: found.kind,
    path: crumbs.filter((c) => c.id !== pageId),
    editedBy: details?.editedBy ?? null,
    editedAt: found.updatedAt.toISOString(),
    excerpt: found.kind === "database" ? "" : previewExcerpt(details?.excerpt ?? ""),
    properties,
  };
}

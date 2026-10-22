"use server";

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { page, type PageKind } from "@/db/schema";
import type { PageBackground } from "@/lib/page-background";
import { parsePageBackground } from "@/lib/page-background";
import { pageStyleFromYdoc, type PageStyle } from "@/lib/page-style";
import { rowPanelStamp } from "@/lib/row-panel";
import { AccessError, pageVisibleTo } from "@/server/access";
import { getPageHeaderInfo, type PageHeaderInfo } from "@/server/page-meta";
import { getBreadcrumbs, getPage } from "@/server/pages";
import { requireUserId } from "@/server/session";

export type RowPanelPage = {
  workspaceId: string;
  page: {
    id: string;
    parentId: string | null;
    title: string;
    icon: string | null;
    background: PageBackground | null;
    kind: PageKind;
    archived: boolean;
    isRow: boolean;
  };
  /** The database the row belongs to; null once the page is no longer a row of one. */
  databaseId: string | null;
  info: PageHeaderInfo;
  crumbs: { id: string; title: string; icon: string | null; kind: PageKind }[];
  style: PageStyle;
};

/**
 * What the row page shows, for the row panel beside a view (as app/w/[workspaceId]/p/[pageId]
 * loads it). A row that doesn't exist, that the user may not see, or that a workspace sign-in
 * policy holds back looks the same: unavailable. A database opens only as its own page.
 */
export async function loadRowPanelAction(
  rowId: string,
): Promise<{ ok: true; data: RowPanelPage } | { ok: false; reason: "unavailable" | "database" } | { ok: false; reason: "merged"; rowId: string }> {
  const userId = await requireUserId();
  try {
    const p = await getPage(userId, String(rowId));
    if (p.kind === "database") return { ok: false, reason: "database" };
    // A row merged into another one opens that row (as its page does), if the user may see it.
    if (p.archivedAt && p.mergedIntoId) {
      const kept = await getPage(userId, p.mergedIntoId).catch((error) => {
        if (error instanceof AccessError) return null;
        throw error;
      });
      if (kept && !kept.archivedAt) return { ok: false, reason: "merged", rowId: kept.id };
    }
    const [crumbs, info] = await Promise.all([getBreadcrumbs(userId, p.id), getPageHeaderInfo(userId, p.id)]);
    const parent = crumbs.length > 1 ? crumbs[crumbs.length - 2] : null;
    const isRow = parent?.kind === "database";
    return {
      ok: true,
      data: {
        workspaceId: p.workspaceId,
        page: {
          id: p.id,
          parentId: p.parentId,
          title: p.title,
          icon: p.icon,
          background: parsePageBackground(p.background),
          kind: p.kind,
          archived: Boolean(p.archivedAt),
          isRow,
        },
        databaseId: isRow ? parent.id : null,
        info,
        crumbs,
        style: pageStyleFromYdoc(p.ydoc),
      },
    };
  } catch (error) {
    if (error instanceof AccessError) return { ok: false, reason: "unavailable" };
    throw error;
  }
}

/**
 * The row's stamp (rowPanelStamp) without loading the row: the panel loads it again only when
 * this changed, not at every change of the workspace's page tree.
 */
export async function rowPanelStampAction(rowId: string): Promise<string> {
  const userId = await requireUserId();
  const [row] = await db
    .select({ parentId: page.parentId, archivedAt: page.archivedAt })
    .from(page)
    .where(and(eq(page.id, String(rowId)), pageVisibleTo(userId)));
  return rowPanelStamp(row ? { parentId: row.parentId, archived: Boolean(row.archivedAt) } : null);
}

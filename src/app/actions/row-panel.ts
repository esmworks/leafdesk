"use server";

import type { PageKind } from "@/db/schema";
import type { PageBackground } from "@/lib/page-background";
import { parsePageBackground } from "@/lib/page-background";
import { pageStyleFromYdoc, type PageStyle } from "@/lib/page-style";
import { AccessError } from "@/server/access";
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
): Promise<{ ok: true; data: RowPanelPage } | { ok: false; reason: "unavailable" | "database" }> {
  const userId = await requireUserId();
  try {
    const p = await getPage(userId, String(rowId));
    if (p.kind === "database") return { ok: false, reason: "database" };
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

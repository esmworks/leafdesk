import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { getTranslations } from "next-intl/server";
import { db } from "@/db";
import { page, type PageKind } from "@/db/schema";
import { DEFAULT_PAGE_STYLE, pageStyleFromYdoc, type PageStyle } from "@/lib/page-style";
import { printOrder } from "@/lib/print";
import { pageVisibleTo, requirePageAccess } from "@/server/access";
import type { PageBlock } from "@/server/blocknote";
import { getCollab } from "@/server/collab/bridge";
import { assertExportAllowed, recordExport } from "@/server/export";
import { resolvePageRefs } from "@/server/mentions";
import { getBreadcrumbs } from "@/server/pages";
import {
  publishedDatabase,
  publishedRow,
  type PublishedBlock,
  type PublishedChild,
  type PublishedCrumb,
  type PublishedDatabase,
  type PublishedPage,
} from "@/server/publication";
import { bodySegmentsFromBlocks, type BodySegment, type PublishedPageRef } from "@/server/published-body";

/**
 * The print view (`/print/<pageId>`, the page menu's "Export as PDF"): a page, and with `subpages`
 * the pages under it, drawn the way published pages are (server/published-body.ts), for the
 * browser to save as PDF.
 *
 * It reads as the signed-in person, not as a publisher: the page needs view access (checked by
 * `requirePageAccess`, so a page they can't open reads the same as a missing one), subpages and
 * database rows they can't see are left out, and pages the body mentions or links to print as
 * the titles they may see ("No access" otherwise), never as links. Bodies are read from the live
 * document when it is open, so edits made a moment ago are in.
 *
 * Like a published page, database blocks and row pages show every property but people and
 * relations (see publication.ts publicProperties).
 */

export type PrintSection = {
  id: string;
  title: string;
  icon: string | null;
  kind: PageKind;
  updatedAt: Date;
  /** Typeface and small text print as in the app; paper has no full width. */
  style: PageStyle;
  /** How deep it lies under the printed page (0 for that page). */
  depth: number;
  body: PublishedBlock[];
  /** From the top of the workspace down to this page, for breadcrumb blocks. */
  crumbs: PublishedCrumb[];
  /** Live subpages it would list (not rows, nor inline databases its body shows). */
  children: PublishedChild[];
  database: PublishedDatabase | null;
  row: PublishedPage["row"];
};

export type PrintDocument = {
  workspaceId: string;
  sections: PrintSection[];
  /** Subpages were asked for and some were left out (see PRINT_MAX_PAGES). */
  truncated: boolean;
};

/** How pages the body mentions read in print, in the reader's language (English outside a request). */
async function refLabels() {
  try {
    const [t, tc] = await Promise.all([getTranslations("page.mention"), getTranslations("common")]);
    return { untitled: tc("untitled"), noAccess: t("noAccess"), deleted: t("deleted") };
  } catch {
    return { untitled: "Untitled", noAccess: "No access", deleted: "Deleted page" };
  }
}

/** Mentions and page links as the titles `userId` may see, never as links. */
async function printRefs(userId: string, pageIds: string[]): Promise<Map<string, PublishedPageRef>> {
  const labels = await refLabels();
  const refs = await resolvePageRefs(userId, pageIds);
  return new Map(
    refs.map((ref) => [
      ref.id,
      {
        text: ref.status === "ok" ? ref.title.trim() || labels.untitled : ref.status === "noAccess" ? labels.noAccess : labels.deleted,
        href: null,
      },
    ]),
  );
}

/** The database a block shows, when `userId` can open it (and it isn't in the trash). */
async function printedEmbed(userId: string, databaseId: string, view: Parameters<typeof publishedDatabase>[2]) {
  try {
    const found = await requirePageAccess(userId, databaseId, "view");
    if (found.kind !== "database" || found.archivedAt) return null;
    return { id: found.id, title: found.title, icon: found.icon, table: await publishedDatabase(userId, found.id, { ...view, reader: userId }) };
  } catch {
    return null;
  }
}

async function liveChildren(userId: string, parentId: string): Promise<PublishedChild[]> {
  return db
    .select({ id: page.id, title: page.title, icon: page.icon, kind: page.kind })
    .from(page)
    .where(and(eq(page.parentId, parentId), isNull(page.archivedAt), eq(page.inTemplate, false), pageVisibleTo(userId)))
    .orderBy(asc(page.position), asc(page.createdAt));
}

/**
 * Live pages under `rootId` that `userId` can see, down to 32 levels, without going into
 * databases (their rows print as the database's table) or past a page they can't see.
 */
async function subtree(userId: string, rootId: string) {
  const rows = await db.execute<{ id: string; parent_id: string | null; position: number; created_at: string }>(sql`
    with recursive tree as (
      select id, parent_id, kind, position, created_at, 0 as depth from ${page} where id = ${rootId}
      union all
      select p.id, p.parent_id, p.kind, p.position, p.created_at, t.depth + 1
      from ${page} p join tree t on p.parent_id = t.id
      where t.kind <> 'database' and t.depth < 32 and p.archived_at is null and not p.in_template
        and ${pageVisibleTo(userId, "p")}
    )
    select id, parent_id, position, created_at from tree
  `);
  return [...rows].map((r) => ({ id: r.id, parentId: r.parent_id, position: Number(r.position), createdAt: r.created_at }));
}

async function printSection(userId: string, pageId: string, depth: number, index: number): Promise<PrintSection> {
  const target = await requirePageAccess(userId, pageId, "view");
  const parent = target.parentId
    ? (await db.select({ kind: page.kind }).from(page).where(eq(page.id, target.parentId)).limit(1))[0]
    : undefined;
  const isDatabase = target.kind === "database";
  const [content, crumbs, children, database, row] = await Promise.all([
    isDatabase ? Promise.resolve(null) : getCollab().readBlocks(target.id),
    getBreadcrumbs(userId, target.id),
    isDatabase ? Promise.resolve([]) : liveChildren(userId, target.id),
    isDatabase ? publishedDatabase(userId, target.id, { reader: userId }) : Promise.resolve(null),
    parent?.kind === "database" && target.parentId ? publishedRow(target, target.parentId, userId) : Promise.resolve(null),
  ]);
  const segments = content
    ? await bodySegmentsFromBlocks(content.blocks as PageBlock[], {
        resolvePages: (ids) => printRefs(userId, ids),
        // Headings of every printed page share the document; the first page keeps plain anchors.
        anchorPrefix: index === 0 ? "" : `p${index + 1}-`,
      })
    : [];
  // Database blocks, in columns too, as the databases the reader can open.
  const resolve = (list: BodySegment[]): Promise<PublishedBlock[]> =>
    Promise.all(
      list.map(async (segment): Promise<PublishedBlock> => {
        if (segment.kind === "columns") {
          return {
            kind: "columns",
            columns: await Promise.all(segment.columns.map(async (column) => ({ width: column.width, segments: await resolve(column.segments) }))),
          };
        }
        if (segment.kind !== "embed") return segment;
        return {
          kind: "embed",
          type: segment.type,
          database: await printedEmbed(userId, segment.databaseId, segment.type === "linkedView" ? { linked: segment.view } : {}),
        };
      }),
    );
  const body = await resolve(segments);
  const shown = new Set<string>();
  const collect = (list: PublishedBlock[]) => {
    for (const b of list) {
      if (b.kind === "columns") b.columns.forEach((c) => collect(c.segments));
      else if (b.kind === "embed" && b.type === "database" && b.database) shown.add(b.database.id);
    }
  };
  collect(body);
  return {
    id: target.id,
    title: content?.title || target.title,
    icon: target.icon,
    kind: target.kind,
    updatedAt: target.updatedAt,
    // As last stored: the collab server stores an edit within seconds.
    style: isDatabase ? DEFAULT_PAGE_STYLE : pageStyleFromYdoc(target.ydoc),
    depth,
    body,
    crumbs,
    // An inline database shown in the body isn't listed again below it.
    children: children.filter((child) => !shown.has(child.id)),
    database,
    row,
  };
}

/**
 * What `/print/<pageId>` shows. Throws AccessError when `userId` can't view the page, and an
 * ExportError (`disabled`) while the workspace has export turned off: printing to PDF is an export.
 * With `subpages`, the pages under it follow it in sidebar order, up to PRINT_MAX_PAGES in all.
 */
export async function printDocument(userId: string, pageId: string, { subpages = false }: { subpages?: boolean } = {}): Promise<PrintDocument> {
  const root = await requirePageAccess(userId, pageId, "view");
  await assertExportAllowed(root.workspaceId);
  const { pages, truncated } =
    subpages && root.kind !== "database" ? printOrder(root.id, await subtree(userId, root.id)) : { pages: [{ id: root.id, depth: 0 }], truncated: false };
  // One page at a time: each reads its document and renders HTML, and they come in order anyway.
  const sections: PrintSection[] = [];
  for (const [index, entry] of pages.entries()) {
    try {
      sections.push(await printSection(userId, entry.id, entry.depth, index));
    } catch (error) {
      // A subpage moved or hidden since the tree was read is left out; the page itself is not.
      if (index === 0) throw error;
    }
  }
  // Opening the print view is how a page is exported as PDF.
  await recordExport(userId, { workspaceId: root.workspaceId, page: { id: root.id, title: root.title }, format: "pdf", pages: sections.length });
  return { workspaceId: root.workspaceId, sections, truncated };
}

import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { getTranslations } from "next-intl/server";
import { db } from "@/db";
import { databaseProperty, databaseView, page, pagePublication, user, workspace, type CardSize, type PageKind, type ViewConfig, type ViewType } from "@/db/schema";
import type { ChartAccumulate, ChartType, DateOptions, FormulaConfig, PropertyOptions, PropertyType } from "@/db/schema/app";
import type { AggregateResult } from "@/lib/aggregate";
import {
  canStack,
  chartAccumulateOf,
  chartData,
  chartGroupProperty,
  chartMeasure,
  chartTypeOf,
  isStackable,
  measureRows,
  withoutRows,
  type ChartData,
  type ChartMeasure,
} from "@/lib/chart";
import { timestampDay } from "@/lib/time-zone";
import { PG_MARKDOWN_IMAGE_PATTERN } from "@/lib/cover";
import type { FormulaStyle } from "@/lib/formula";
import { LIST_WIDGET_ROWS, type DashboardWidget, type WidgetColor, type WidgetSpan } from "@/lib/dashboard";
import type { EmbedBlockType, LinkedView } from "@/lib/embed-blocks";
import { arrangeGroups, boardGroupProperty, groupRowsBy, isGroupable, type GroupValue } from "@/lib/grouping";
import { parsePageBackground, type PageBackground } from "@/lib/page-background";
import { DEFAULT_PAGE_STYLE, pageStyleFromYdoc, type PageStyle } from "@/lib/page-style";
import { applyView, computedValues, isHiddenInView, orderProperties } from "@/lib/properties";
import { coverProperty, galleryCover } from "@/lib/views";
import { firstImageFile } from "@/lib/files";
import { withoutDeleted } from "@/lib/deleted-schema";
import { hideReferences, unknownProperties } from "@/lib/property-access-rows";
import { holdsOptions, holdsPeople, UNPUBLISHED_PROPERTY_TYPES } from "@/lib/property-types";
import { unknownToVisitors } from "@/lib/published-copy";
import { publishedHref, type PublishedLinks } from "@/lib/site";
import { AccessError, accessRank, pageVisibleTo, requireMembership, requirePageAccess } from "@/server/access";
import { recordAudit } from "@/server/audit";
import { deletedPropertyIds, rowCovers, type DatabaseProperty } from "@/server/databases";
import { formulasReadingRelated } from "@/lib/derived";
import { computeDerived, withAllFormulaTypes } from "@/server/derived";
import { publishedPageRefs } from "@/server/mentions";
import { propertyAccessFor } from "@/server/property-access";
import { canPublish, publishingOn } from "@/server/workspaces";
import type { BodyHeading, BodySegment, PublishedBookmark, PublishedColumn } from "@/server/published-body";
import type { EmbedTarget } from "@/lib/web-blocks";

/**
 * Publish to web: a published page and its live subpages can be read by anyone holding the link
 * (`/s/<token>/…`), without signing in. Publishing needs full access to the page and the
 * workspace's publishing policy (`canPublish`); unpublishing needs full access, and owners can take
 * any page of their workspace offline. Reading one needs only the token, while the workspace has
 * publishing on: turned off, nothing of it is served (see chainTo), but nothing is deleted either.
 *
 * A publication shows only what its publisher can see right now: subpages or rows restricted from
 * them stay private, and it stops working once they lose access to the page or leave.
 *
 * Databases the body shows from outside the page (dashboard widgets, linked views) are left out,
 * unless the publisher chose to show them (`outsideDatabaseIds`, see server/publish-reach.ts): then
 * those blocks show them, and nothing else does (see outsideShown).
 */

/** Deepest subpage reachable from a published page; deeper pages are not served. */
const MAX_DEPTH = 32;

export class PublishError extends Error {
  constructor(
    message: string,
    readonly code?: "notAllowed" | "publishingOff",
  ) {
    super(message);
    this.name = "PublishError";
  }
}

export async function getPublication(userId: string, pageId: string) {
  await requirePageAccess(userId, pageId, "view");
  const [row] = await db
    .select({
      token: pagePublication.token,
      indexable: pagePublication.indexable,
      inSite: pagePublication.inSite,
      allowDuplicate: pagePublication.allowDuplicate,
      createdAt: pagePublication.createdAt,
    })
    .from(pagePublication)
    .where(eq(pagePublication.pageId, pageId))
    .limit(1);
  return row ?? null;
}

/** Why the user can't publish in the workspace: publishing is off there, or not for them. */
async function workspaceBlocker(userId: string, workspaceId: string): Promise<"notAllowed" | "publishingOff" | null> {
  if (!(await publishingOn(workspaceId))) return "publishingOff";
  return (await canPublish(userId, workspaceId)) ? null : "notAllowed";
}

/** What publishing needs in the workspace, as a PublishError when it is refused. */
async function assertWorkspaceAllows(userId: string, workspaceId: string) {
  const blocker = await workspaceBlocker(userId, workspaceId);
  if (blocker === "publishingOff") throw new PublishError("Publishing to the web is turned off in this workspace", blocker);
  if (blocker) throw new PublishError("This workspace lets only owners publish pages", blocker);
}

/** Why the user can't publish this page, or null when they can. */
export async function publishBlocker(
  userId: string,
  pageId: string,
): Promise<"needsFullAccess" | "notAllowed" | "publishingOff" | null> {
  let p;
  try {
    p = await requirePageAccess(userId, pageId, "full");
  } catch (error) {
    if (error instanceof AccessError) return "needsFullAccess";
    throw error;
  }
  return workspaceBlocker(userId, p.workspaceId);
}

export async function publishPage(userId: string, pageId: string): Promise<{ token: string; indexable: boolean }> {
  const p = await requirePageAccess(userId, pageId, "full");
  await assertWorkspaceAllows(userId, p.workspaceId);
  if (p.archivedAt) throw new PublishError("Pages in the trash can't be published");
  if (p.inTemplate) throw new PublishError("Templates can't be published");
  const published = await db
    .insert(pagePublication)
    .values({ pageId, token: randomBytes(32).toString("base64url"), publishedBy: userId })
    .onConflictDoNothing({ target: pagePublication.pageId })
    .returning({ pageId: pagePublication.pageId });
  if (published.length) {
    await recordAudit({ workspaceId: p.workspaceId, actorId: userId, action: "page.published", target: { type: "page", id: pageId, label: p.title } });
  }
  // Already published (or published concurrently): keep the existing link.
  const [row] = await db
    .select({ token: pagePublication.token, indexable: pagePublication.indexable })
    .from(pagePublication)
    .where(eq(pagePublication.pageId, pageId))
    .limit(1);
  if (!row) throw new PublishError("Could not publish the page");
  return row;
}

export async function unpublishPage(userId: string, pageId: string): Promise<void> {
  const p = await requirePageAccess(userId, pageId, "full");
  const removed = await db.delete(pagePublication).where(eq(pagePublication.pageId, pageId)).returning({ pageId: pagePublication.pageId });
  if (removed.length) {
    await recordAudit({ workspaceId: p.workspaceId, actorId: userId, action: "page.unpublished", target: { type: "page", id: pageId, label: p.title } });
  }
}

/** Changing what a publication shows asks for what publishing does. */
async function requirePublishRights(userId: string, pageId: string) {
  const p = await requirePageAccess(userId, pageId, "full");
  await assertWorkspaceAllows(userId, p.workspaceId);
  return p;
}

/**
 * A publication's options:
 * - `indexable`: search engines may index the page and its subpages (off by default);
 * - `inSite`: the workspace's site lists it (see server/site.ts; off by default);
 * - `allowDuplicate`: signed-in visitors may copy it into a workspace of theirs (off by default).
 */
export type PublicationOptions = { indexable: boolean; inSite: boolean; allowDuplicate: boolean };

/** Changes some options of a page's publication; needs what publishing needs. */
export async function updatePublication(userId: string, pageId: string, patch: Partial<PublicationOptions>): Promise<void> {
  await requirePublishRights(userId, pageId);
  const clean: Partial<PublicationOptions> = {};
  for (const key of ["indexable", "inSite", "allowDuplicate"] as const) {
    if (patch[key] === undefined) continue;
    if (typeof patch[key] !== "boolean") throw new PublishError(`${key} must be true or false`);
    clean[key] = patch[key];
  }
  if (!Object.keys(clean).length) return;
  const updated = await db
    .update(pagePublication)
    .set(clean)
    .where(eq(pagePublication.pageId, pageId))
    .returning({ pageId: pagePublication.pageId });
  if (!updated.length) throw new PublishError("The page isn't published");
}

/** Lets search engines index a published page and its subpages, or keeps them out (the default). */
export async function setPublicationIndexable(userId: string, pageId: string, indexable: boolean): Promise<void> {
  await updatePublication(userId, pageId, { indexable });
}

export type WebView = { id: string; name: string; type: ViewType; published: boolean };

/**
 * The database's views that can be shown on the web (forms show no rows), with the ones published
 * pages show marked: the views picked for it, else the first one. Null for pages that aren't databases.
 */
export async function getWebViews(userId: string, databaseId: string): Promise<WebView[] | null> {
  const p = await requirePageAccess(userId, databaseId, "view");
  if (p.kind !== "database") return null;
  const views = await readableViews(databaseId);
  const shown = new Set(webViews(views).map((v) => v.id));
  return views.map((v) => ({ id: v.id, name: v.name, type: v.type, published: shown.has(v.id) }));
}

/** Picks the views published pages show for this database, wherever it is published. */
export async function setWebViews(userId: string, databaseId: string, viewIds: string[]): Promise<void> {
  const p = await requirePublishRights(userId, databaseId);
  if (p.kind !== "database") throw new PublishError("Only databases have views");
  const views = await readableViews(databaseId);
  const known = new Set(views.map((v) => v.id));
  const picked = [...new Set(viewIds)];
  if (!picked.length) throw new PublishError("Pick at least one view");
  if (picked.some((id) => !known.has(id))) throw new PublishError("Pick views of this database");
  await db
    .update(databaseView)
    .set({ published: inArray(databaseView.id, picked) })
    // A deleted view keeps its place on the web for a restore.
    .where(and(eq(databaseView.databaseId, databaseId), isNull(databaseView.deletedAt)));
}

export type WorkspacePublication = {
  pageId: string;
  /** Null when the owner can't see the page: they may take it offline, not read it. */
  title: string | null;
  icon: string | null;
  /**
   * Site path, only for pages the owner can see (the link would show the page to them) and that are
   * still served: not in the trash, and publishing is on.
   */
  url: string | null;
  inTrash: boolean;
  /** Search engines may index it. */
  indexable: boolean;
  /** The workspace's site lists it. */
  inSite: boolean;
  /** Visitors may duplicate it. */
  allowDuplicate: boolean;
  publishedBy: string | null;
  createdAt: Date;
};

/** Every published page of the workspace, newest first, for owners to review. */
export async function listWorkspacePublications(userId: string, workspaceId: string): Promise<WorkspacePublication[]> {
  await requireMembership(userId, workspaceId, "owner");
  const served = await publishingOn(workspaceId);
  const rows = await db
    .select({
      pageId: page.id,
      title: page.title,
      icon: page.icon,
      archivedAt: page.archivedAt,
      token: pagePublication.token,
      indexable: pagePublication.indexable,
      inSite: pagePublication.inSite,
      allowDuplicate: pagePublication.allowDuplicate,
      publishedBy: user.name,
      createdAt: pagePublication.createdAt,
      visible: sql<boolean>`${accessRank(userId, sql`${page.id}`)} > 0`,
    })
    .from(pagePublication)
    .innerJoin(page, eq(page.id, pagePublication.pageId))
    .leftJoin(user, eq(user.id, pagePublication.publishedBy))
    .where(eq(page.workspaceId, workspaceId))
    .orderBy(desc(pagePublication.createdAt));
  return rows.map((r) => ({
    pageId: r.pageId,
    title: r.visible ? r.title : null,
    icon: r.visible ? r.icon : null,
    url: r.visible && !r.archivedAt && served ? `/s/${r.token}` : null,
    inTrash: r.archivedAt !== null,
    indexable: r.indexable,
    inSite: r.inSite,
    allowDuplicate: r.allowDuplicate,
    publishedBy: r.publishedBy,
    createdAt: r.createdAt,
  }));
}

/** Takes a page of the workspace offline, whoever published it. Owners only. */
export async function revokePublication(userId: string, workspaceId: string, pageId: string): Promise<void> {
  await requireMembership(userId, workspaceId, "owner");
  const inWorkspace = db.select({ id: page.id }).from(page).where(and(eq(page.id, pageId), eq(page.workspaceId, workspaceId)));
  const revoked = await db
    .delete(pagePublication)
    .where(and(eq(pagePublication.pageId, pageId), inArray(pagePublication.pageId, inWorkspace)))
    .returning({ publishedBy: pagePublication.publishedBy });
  for (const { publishedBy } of revoked) {
    await recordAudit({
      workspaceId,
      actorId: userId,
      action: "page.publication_revoked",
      target: { type: "page", id: pageId },
      subject: publishedBy ? { type: "user", id: publishedBy } : null,
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Public reads (no user). Everything below trusts only the token.

export type PublishedCrumb = { id: string; title: string; icon: string | null; kind: PageKind };
export type PublishedChild = { id: string; title: string; icon: string | null; kind: PageKind };
export type PublishedRow = {
  id: string;
  title: string;
  icon: string | null;
  properties: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  /** Galleries showing covers: the first image in the row's body, or of the view's files property. */
  cover?: string | null;
  /** How styled formula results show (see lib/formula style()). */
  styles?: Record<string, FormulaStyle>;
};
export type PublishedViewTab = { id: string; name: string; type: ViewType };
/** How a published view is drawn; calendars and timelines show as tables, charts as their numbers. */
export type PublishedLayout = "table" | "board" | "list" | "gallery" | "chart";
/**
 * A chart view's numbers, worked out on the server from the rows the page publishes and only its
 * public properties: one value for a number chart, else each group's (and stack segment's) value.
 * No rows ride along; visitors see the figures, as a table.
 */
export type PublishedChart = {
  chartType: ChartType;
  measure: ChartMeasure;
  accumulate: ChartAccumulate | null;
  /** The properties the chart names: what it measures, groups and stacks by. */
  properties: { id: string; name: string; type: PropertyType }[];
  groupById: string | null;
  stackById: string | null;
  rowCount: number;
  /** Number charts: the value. */
  result: AggregateResult | null;
  /** Other charts: the groups, or null when there is nothing public to group by. */
  data: ChartData<never> | null;
};
/**
 * A property as a published page sends it to the visitor's browser (see publishedProperty): what
 * drawing its values takes, and nothing of how it is worked out or set up.
 */
export type PublishedProperty = Pick<DatabaseProperty, "id" | "name" | "type"> & {
  options: Pick<PropertyOptions, "options" | "number" | "numberDisplay" | "pageVisibility"> & {
    formula?: Pick<FormulaConfig, "type">;
    date?: Pick<DateOptions, "display">;
  };
};
export type PublishedDatabase = {
  /** Visible properties of the view, in property order (relations and people are never published). */
  properties: PublishedProperty[];
  view: PublishedViewTab | null;
  /** The views visitors can switch between (see webViews); only for database pages. */
  views: PublishedViewTab[];
  layout: PublishedLayout;
  /** Live rows, filtered and sorted by the view. */
  rows: PublishedRow[];
  /**
   * Board columns, or table sections, when the view groups by a published property: the view's
   * shown groups in its order, each with the ids of its rows.
   */
  groups: { property: PublishedProperty; list: { key: string; value: GroupValue; rowIds: string[] }[] } | null;
  /** Galleries. */
  cardSize: CardSize;
  /** Charts (layout "chart"). */
  chart?: PublishedChart;
};
/**
 * A part of a published page's body: text, a database block, or a block the page draws itself (a
 * table of contents, a breadcrumb from `crumbs`, a Mermaid diagram), or columns of these.
 */
export type PublishedBlock =
  | { kind: "html"; html: string }
  | { kind: "toc"; headings: BodyHeading[] }
  | { kind: "breadcrumb" }
  | { kind: "mermaid"; source: string }
  | { kind: "bookmark"; bookmark: PublishedBookmark }
  | { kind: "webEmbed"; url: string; embed: EmbedTarget }
  | { kind: "pdf"; fileId: string; name: string; caption: string }
  | { kind: "columns"; columns: PublishedColumn<PublishedBlock>[] }
  | { kind: "dashboard"; widgets: PublishedWidget[] }
  | {
      kind: "embed";
      type: EmbedBlockType;
      /**
       * The database, when it is published with this page (it lies under the published page, or
       * the publisher chose to show it from outside; it is live and its publisher can see it).
       * Null otherwise: the block then shows nothing about it.
       */
      database: PublishedEmbed | null;
    };
/**
 * A dashboard widget on a published page: its database as its view shows it, published under the
 * same rules as a linked view (null when it isn't). List widgets carry their first rows only.
 */
export type PublishedWidget = {
  id: string;
  title: string;
  span: WidgetSpan;
  color?: WidgetColor;
  database: PublishedEmbed | null;
  /** List widgets: how many rows the list has in all. */
  rowCount: number;
};
/**
 * A database a block shows. `outside`: a database outside the published page that the publisher
 * chose to show there (see outsideShown); it is shown through the block only, without links to it
 * or its rows, which have no published address.
 */
export type PublishedEmbed = { id: string; title: string; icon: string | null; outside?: true; table: PublishedDatabase };
export type PublishedPage = {
  token: string;
  /** Search engines may index it (the publication allows it). */
  indexable: boolean;
  /** Signed-in visitors may copy it into a workspace of theirs (the publication allows it). */
  allowDuplicate: boolean;
  /** Where the page's links go: the publication's own link, or its workspace's site. */
  links: PublishedLinks;
  rootId: string;
  id: string;
  title: string;
  icon: string | null;
  /** The color and pattern behind the page (lib/page-background). */
  background: PageBackground | null;
  kind: PageKind;
  updatedAt: Date;
  /** Typeface, small text and full width the page has in the app (the defaults for databases). */
  style: PageStyle;
  /** Body HTML serialized by BlockNote from the page's own document (see published-body.ts), with its database blocks. */
  body: PublishedBlock[];
  /** From the published page down to this page, both included. */
  crumbs: PublishedCrumb[];
  /** Live subpages (not database rows, nor inline databases the body shows), in sidebar order. */
  children: PublishedChild[];
  /** Database pages. */
  database: PublishedDatabase | null;
  /** Database rows: their values, with the database's (non-relation) properties. */
  row: { properties: PublishedProperty[]; values: Record<string, unknown>; styles?: Record<string, FormulaStyle> } | null;
};

export type PublishedPageOptions = {
  /**
   * Links of a site (server/site.ts), instead of the publication's own (`/s/<token>/<page id>`).
   * Pages that other publications of the site serve (`elsewhere`) are linked to as well.
   */
  links?: PublishedLinks;
  elsewhere?: (pageId: string) => Promise<boolean>;
};

/**
 * The published page for `token`, or — with `pageId` — that page if it is a live descendant of
 * the published page. Null when the token is unknown, the published page is in the trash, or
 * `pageId` is outside the published subtree.
 */
export async function getPublishedPage(
  token: string,
  pageId?: string,
  viewId?: string,
  options: PublishedPageOptions = {},
): Promise<PublishedPage | null> {
  if (!token || token.length > 128) return null;
  const [root] = await db
    .select({
      id: page.id,
      publishedBy: pagePublication.publishedBy,
      indexable: pagePublication.indexable,
      allowDuplicate: pagePublication.allowDuplicate,
      outside: pagePublication.outsideDatabaseIds,
    })
    .from(pagePublication)
    .innerJoin(page, eq(page.id, pagePublication.pageId))
    .where(and(eq(pagePublication.token, token), isNull(page.archivedAt)))
    .limit(1);
  if (!root?.publishedBy) return null;
  const publisher = root.publishedBy;
  const links = options.links ?? { base: `/s/${token}`, homeId: root.id, site: false };

  const targetId = pageId ?? root.id;
  const crumbs = await chainTo(publisher, targetId, root.id);
  if (!crumbs) return null;

  const [target] = await db
    .select({
      id: page.id,
      title: page.title,
      icon: page.icon,
      background: page.background,
      kind: page.kind,
      parentId: page.parentId,
      properties: page.properties,
      ydoc: page.ydoc,
      createdAt: page.createdAt,
      updatedAt: page.updatedAt,
    })
    .from(page)
    .where(and(eq(page.id, targetId), isNull(page.archivedAt)))
    .limit(1);
  if (!target) return null;

  const parent = target.parentId
    ? (
        await db
          .select({ kind: page.kind })
          .from(page)
          .where(eq(page.id, target.parentId))
          .limit(1)
      )[0]
    : undefined;

  const [body, children, database, row] = await Promise.all([
    target.kind === "page" ? publishedBody(publisher, root.id, root.outside, links, target.ydoc, options.elsewhere) : Promise.resolve([]),
    target.kind === "database" ? Promise.resolve([]) : liveChildren(publisher, target.id),
    target.kind === "database" ? publishedDatabase(publisher, target.id, { viewId }) : Promise.resolve(null),
    parent?.kind === "database" && target.parentId ? publishedRow(target, target.parentId) : Promise.resolve(null),
  ]);

  return {
    token,
    indexable: root.indexable,
    allowDuplicate: root.allowDuplicate,
    links,
    rootId: root.id,
    id: target.id,
    title: target.title,
    icon: target.icon,
    background: parsePageBackground(target.background),
    kind: target.kind,
    updatedAt: target.updatedAt,
    style: target.kind === "page" ? pageStyleFromYdoc(target.ydoc) : DEFAULT_PAGE_STYLE,
    body,
    crumbs,
    // An inline database shown in the body isn't listed again below it.
    children: children.filter(
      (child) => !body.some((b) => b.kind === "embed" && b.type === "database" && b.database?.id === child.id),
    ),
    database,
    row,
  };
}

/**
 * A database row's values as a published page shows them: every property but the private ones
 * (see publicProperties) and what property access keeps from `reader` (see readerAccess). Also
 * used by the print view (server/print.ts), which passes the person printing.
 */
export async function publishedRow(
  target: { id: string; title: string; properties: Record<string, unknown>; createdAt: Date; updatedAt: Date; createdBy?: string | null },
  databaseId: string,
  reader: string | null = null,
): Promise<NonNullable<PublishedPage["row"]>> {
  const properties = await databaseProperties(databaseId);
  const access = await readerAccess(reader, databaseId, properties);
  // Public properties hold no people, so only the created and last edited times are filled in.
  const { createdBy = null, ...rest } = target;
  const [row] = await publicValues(
    [{ ...rest, createdBy, properties: { ...target.properties, ...computedValues(properties, { ...rest, createdBy: null }) } }],
    properties,
    access,
  );
  const shown = publicProperties(access.known(properties));
  return { properties: shown.map(publishedProperty), values: row.properties, ...stylesOf(row, shown) };
}

/** The styles of the formula results a published page shows (none of what it leaves out). */
function stylesOf(row: { styles?: Record<string, FormulaStyle> }, shown: { id: string }[]) {
  const styles = Object.entries(row.styles ?? {}).filter(([id]) => shown.some((p) => p.id === id));
  return styles.length ? { styles: Object.fromEntries(styles) } : {};
}

/**
 * Property access of whoever reads a published database: anonymous visitors (`reader` null) get
 * what the entries for everyone allow, capped at view; the print view reads as the person
 * printing. `gone`: properties they can't know of, left out of the columns and of the view's
 * settings (filters, sorts, grouping). Values they can't view are left out of each row before the
 * view is applied (see publicValues), so the order and the groups of rows say nothing about them
 * either. Used by copies of published pages too (server/published-duplicate.ts).
 */
export async function readerAccess(reader: string | null, databaseId: string, properties: { id: string }[]) {
  const access = await propertyAccessFor(reader, databaseId);
  const gone = reader === null ? unknownToVisitors(access, properties) : unknownProperties(access, properties);
  return {
    reader,
    access,
    gone,
    known: <P extends { id: string }>(list: P[]) => list.filter((p) => !gone.has(p.id)),
    config: (config: ViewConfig) => hideReferences(config, gone),
  };
}

type ReaderAccess = Awaited<ReturnType<typeof readerAccess>>;

/**
 * Pages from `rootId` down to `pageId` when every page on the way is live and visible to the
 * publisher, `pageId` lies within MAX_DEPTH levels under the root and the workspace has publishing
 * on; null otherwise. Templates (a database's row templates, say) count as not live: they are
 * never published. Everything public asks this: published pages, sites, their files, duplicating.
 */
export async function chainTo(publisher: string, pageId: string, rootId: string): Promise<PublishedCrumb[] | null> {
  const rows = await db.execute<{
    id: string;
    title: string;
    icon: string | null;
    kind: PageKind;
    archived: boolean;
    visible: boolean;
    served: boolean;
    depth: number;
  }>(sql`
    with recursive chain as (
      select id, parent_id, workspace_id, title, icon, kind, archived_at is not null or in_template as archived, 0 as depth
      from ${page} where id = ${pageId}
      union all
      select p.id, p.parent_id, p.workspace_id, p.title, p.icon, p.kind, p.archived_at is not null or p.in_template, c.depth + 1
      from ${page} p join chain c on p.id = c.parent_id
      where c.id <> ${rootId} and c.depth < ${MAX_DEPTH}
    )
    select c.id, c.title, c.icon, c.kind, c.archived, ${accessRank(publisher, sql`c.id`)} > 0 as visible,
      (w.settings->>'publishing') is distinct from 'off' as served, c.depth
    from chain c join ${workspace} w on w.id = c.workspace_id
    order by c.depth desc
  `);
  const list = [...rows];
  if (!list.length || list[0].id !== rootId || list.some((r) => r.archived || !r.visible || !r.served)) return null;
  return list.map((r) => ({ id: r.id, title: r.title, icon: r.icon, kind: r.kind }));
}

/**
 * Whether a published site shows any of these pages: the page or one above it is published and
 * `getPublishedPage` would serve the page under that publication (see chainTo). Used by the file
 * route, so visitors of a published page can load the files its body shows.
 */
export async function anyPagePublished(pageIds: string[]): Promise<boolean> {
  const ids = [...new Set(pageIds)];
  if (!ids.length) return false;
  const rows = await db.execute<{ start: string; root: string; published_by: string | null }>(sql`
    with recursive up as (
      select id, parent_id, id as start, 0 as depth from ${page} where ${inArray(page.id, ids)}
      union all
      select p.id, p.parent_id, up.start, up.depth + 1
      from ${page} p join up on p.id = up.parent_id
      where up.depth < ${MAX_DEPTH}
    )
    select up.start, pub.page_id as root, pub.published_by
    from up join ${pagePublication} pub on pub.page_id = up.id
  `);
  for (const row of rows) {
    if (row.published_by && (await chainTo(row.published_by, row.start, row.root))) return true;
  }
  // Rows of a database a publication shows from outside its page (gallery covers, files): served
  // while that database may be shown (outsideShown), the published page is and the row lies live
  // under the database.
  const outside = await db.execute<{ start: string; database_id: string; root: string; published_by: string | null }>(sql`
    with recursive up as (
      select id, parent_id, id as start, 0 as depth from ${page} where ${inArray(page.id, ids)}
      union all
      select p.id, p.parent_id, up.start, up.depth + 1
      from ${page} p join up on p.id = up.parent_id
      where up.depth < ${MAX_DEPTH}
    )
    select up.start, up.id as database_id, pub.page_id as root, pub.published_by
    from up join ${pagePublication} pub on up.id = any(pub.outside_database_ids)
  `);
  for (const row of outside) {
    const publisher = row.published_by;
    if (!publisher) continue;
    if (
      (await outsideShown(publisher, row.root, row.database_id)) &&
      (await chainTo(publisher, row.start, row.database_id)) &&
      (await chainTo(publisher, row.root, row.root))
    ) {
      return true;
    }
  }
  return false;
}

/** How a published page names pages it can't show, in the visitor's language (English outside a request). */
export async function mentionLabels() {
  try {
    const [t, tc] = await Promise.all([getTranslations("page.mention"), getTranslations("common")]);
    return { untitled: tc("untitled"), private: t("noAccess"), deleted: t("deleted") };
  } catch {
    return { untitled: "Untitled", private: "No access", deleted: "Deleted page" };
  }
}

/**
 * The page body with its database blocks resolved. A block's database is shown when it is
 * published with this page, i.e. reachable from the published page like any of its subpages (an
 * inline database under the page is), or when it is one of the publication's `outside` databases
 * that may still be shown (see outsideShown).
 */
async function publishedBody(
  publisher: string,
  rootId: string,
  outside: readonly string[],
  links: PublishedLinks,
  ydoc: Uint8Array | null,
  elsewhere?: (pageId: string) => Promise<boolean>,
): Promise<PublishedBlock[]> {
  const { bodySegmentsFromYdoc } = await import("@/server/published-body");
  const segments = await bodySegmentsFromYdoc(ydoc, {
    // Mentioned pages published with this page (or on their own) are links; the rest plain text.
    resolvePages: async (pageIds) => {
      return publishedPageRefs(publisher, pageIds, {
        inPublication: async (id, title) =>
          (await chainTo(publisher, id, rootId)) || (await elsewhere?.(id)) ? publishedHref(links, id, title) : null,
        labels: await mentionLabels(),
      });
    },
  });
  // Widgets and database blocks showing the same database read it once (see PublishedLoads).
  const loads = publishedLoads();
  const resolve = (list: BodySegment[]): Promise<PublishedBlock[]> =>
    Promise.all(
      list.map(async (segment): Promise<PublishedBlock> => {
        if (segment.kind === "columns") {
          return {
            kind: "columns",
            columns: await Promise.all(segment.columns.map(async (column) => ({ width: column.width, segments: await resolve(column.segments) }))),
          };
        }
        if (segment.kind === "dashboard") {
          return { kind: "dashboard", widgets: await Promise.all(segment.widgets.map((w) => publishedWidget(publisher, rootId, outside, w, loads))) };
        }
        if (segment.kind !== "embed") return segment;
        return { kind: "embed", type: segment.type, database: await publishedEmbed(publisher, rootId, outside, segment.databaseId, segment.view, loads) };
      }),
    );
  return resolve(segments);
}

async function publishedWidget(
  publisher: string,
  rootId: string,
  outside: readonly string[],
  widget: DashboardWidget,
  loads: PublishedLoads,
): Promise<PublishedWidget> {
  return widgetShowing(widget, await publishedEmbed(publisher, rootId, outside, widget.databaseId, widget.view, loads));
}

/** A widget showing `database` (published or printed), a list widget's rows cut to its first ones. */
export function widgetShowing(widget: DashboardWidget, database: PublishedEmbed | null): PublishedWidget {
  const rowCount = database?.table.rows.length ?? 0;
  const shown =
    database && widget.view.type === "list" ? { ...database, table: { ...database.table, rows: database.table.rows.slice(0, LIST_WIDGET_ROWS) } } : database;
  return { id: widget.id, title: widget.title, span: widget.span, ...(widget.color ? { color: widget.color } : {}), database: shown, rowCount };
}

async function publishedEmbed(
  publisher: string,
  rootId: string,
  outside: readonly string[],
  databaseId: string,
  view: LinkedView | null,
  loads?: PublishedLoads,
): Promise<PublishedEmbed | null> {
  // Whether the database is published with the page: asked once per database, however many views show it.
  const target = await once(loads, ["embed", publisher, rootId, databaseId], async () => {
    const [found] = await db
      .select({ id: page.id, title: page.title, icon: page.icon, kind: page.kind })
      .from(page)
      .where(and(eq(page.id, databaseId), isNull(page.archivedAt)))
      .limit(1);
    if (found?.kind !== "database") return null;
    if (await chainTo(publisher, found.id, rootId)) return found;
    return outside.includes(found.id) && (await outsideShown(publisher, rootId, found.id)) ? { ...found, outside: true as const } : null;
  });
  if (!target) return null;
  return {
    id: target.id,
    title: target.title,
    icon: target.icon,
    ...("outside" in target ? { outside: true as const } : {}),
    table: await publishedDatabase(publisher, target.id, { linked: view, loads }),
  };
}

/**
 * Whether the publication of `rootId` may show `databaseId`, one of its outside databases, right
 * now: it is a live database (not in the trash, not a template) of the published page's workspace,
 * the publisher can still see it and the workspace has publishing on. Asked on every request, so
 * losing access, trashing the database or turning publishing off hides it again.
 */
export async function outsideShown(publisher: string, rootId: string, databaseId: string): Promise<boolean> {
  const rows = await db.execute<{ id: string }>(sql`
    select d.id
    from ${page} d
    join ${page} r on r.id = ${rootId}
    join ${workspace} w on w.id = d.workspace_id
    where d.id = ${databaseId} and d.kind = 'database' and d.archived_at is null and not d.in_template
      and d.workspace_id = r.workspace_id
      and ${accessRank(publisher, sql`d.id`)} > 0
      and (w.settings->>'publishing') is distinct from 'off'
  `);
  return [...rows].length > 0;
}

async function liveChildren(publisher: string, parentId: string): Promise<PublishedChild[]> {
  return db
    .select({ id: page.id, title: page.title, icon: page.icon, kind: page.kind })
    .from(page)
    .where(and(eq(page.parentId, parentId), isNull(page.archivedAt), eq(page.inTemplate, false), pageVisibleTo(publisher)))
    .orderBy(asc(page.position), asc(page.createdAt));
}

/** A database's properties in order, with formula result types (see databases.getProperties). */
async function databaseProperties(databaseId: string) {
  const properties = await db
    .select()
    .from(databaseProperty)
    .where(and(eq(databaseProperty.databaseId, databaseId), isNull(databaseProperty.deletedAt)))
    .orderBy(asc(databaseProperty.position), asc(databaseProperty.createdAt));
  return withAllFormulaTypes(properties);
}

const PRIVATE_TYPES = UNPUBLISHED_PROPERTY_TYPES;

/**
 * The properties a published page shows: all but relations and people (see
 * UNPUBLISHED_PROPERTY_TYPES), and formulas reading related rows' properties (like rollups).
 */
function publicProperties(properties: DatabaseProperty[]) {
  const readingRelated = formulasReadingRelated(properties);
  return properties.filter((p) => !PRIVATE_TYPES.has(p.type) && !readingRelated.has(p.id));
}

/**
 * A property as visitors get it: its name, type and how its values show (options, number format
 * and display, relative dates, a formula's result type, where a row page shows it). Never a
 * formula's expression (which may name properties the visitor can't see), an AI autofill prompt,
 * a date's reminder, nor who deleted or changed it when.
 */
export function publishedProperty(prop: DatabaseProperty): PublishedProperty {
  const { options: stored } = prop;
  const options: PublishedProperty["options"] = {};
  if (holdsOptions(prop.type) && stored.options) {
    options.options = stored.options.map(({ id, name, color, group }) => ({ id, name, color, ...(group ? { group } : {}) }));
  }
  if (prop.type === "number") {
    if (stored.number) options.number = stored.number;
    if (stored.numberDisplay) options.numberDisplay = stored.numberDisplay;
  }
  if (prop.type === "date" && stored.date?.display) options.date = { display: stored.date.display };
  if (prop.type === "formula") options.formula = stored.formula?.type ? { type: stored.formula.type } : {};
  if (stored.pageVisibility) options.pageVisibility = stored.pageVisibility;
  return { id: prop.id, name: prop.name, type: prop.type, options };
}

/**
 * Rows with their formulas worked out for a public page: formulas that show people or related
 * rows get no names or titles, so nothing private reaches the page through them. Values the reader
 * may not view are left out first (and formulas and rollups reading them after), as
 * databases.withValues does for people in the app.
 */
async function publicValues<R extends { title: string; properties: Record<string, unknown>; createdBy?: string | null }>(
  rows: R[],
  properties: DatabaseProperty[],
  { access, reader }: ReaderAccess,
) {
  const derived = await computeDerived(access.strip(rows), properties, {
    lookups: async () => ({}),
    viewerId: null,
    accessFor: (databaseId) => propertyAccessFor(reader, databaseId),
  });
  return access.finish(derived);
}

/**
 * Names of the people a view sorts rows by. They only order the rows: people properties aren't
 * published, so the names never reach the page.
 */
async function sortNames(rows: { properties: Record<string, unknown> }[], props: DatabaseProperty[], config: ViewConfig) {
  const sortedBy = props.filter((p) => holdsPeople(p.type) && config.sorts?.some((s) => s.propertyId === p.id));
  const ids = [...new Set(rows.flatMap((row) => sortedBy.flatMap((p) => row.properties[p.id]).filter((v) => typeof v === "string")))];
  return ids.length ? db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, ids as string[])) : [];
}

type StoredView = typeof databaseView.$inferSelect;

/** A database's views that show rows, in their order (deleted ones left out). */
export function readableViews(databaseId: string): Promise<StoredView[]> {
  return db
    .select()
    .from(databaseView)
    .where(and(eq(databaseView.databaseId, databaseId), ne(databaseView.type, "form"), isNull(databaseView.deletedAt)))
    .orderBy(asc(databaseView.position), asc(databaseView.createdAt));
}

/** The views published pages show: the ones picked for the web, else the first. */
export function webViews<V extends { published: boolean }>(views: V[]): V[] {
  const picked = views.filter((v) => v.published);
  return picked.length ? picked : views.slice(0, 1);
}

const LAYOUTS: Partial<Record<ViewType, PublishedLayout>> = { board: "board", list: "list", gallery: "gallery" };

/**
 * What publishedDatabase reads of a database whichever view shows it, for one request: a page
 * showing a database several times (a dashboard's widgets, database blocks) reads its properties
 * and rows once, and each view filters, sorts, groups and charts them on its own. Made per request
 * (publishedLoads) and never kept beyond it: who publishes and who reads differ between requests,
 * and rows change.
 */
export type PublishedLoads = Map<string, Promise<unknown>>;
export const publishedLoads = (): PublishedLoads => new Map();

function once<T>(loads: PublishedLoads | undefined, key: unknown[], load: () => PromiseLike<T>): Promise<T> {
  // A query builder runs its query again each time it is awaited: keep the one promise of its result.
  if (!loads) return Promise.resolve(load());
  const id = JSON.stringify(key);
  let found = loads.get(id) as Promise<T> | undefined;
  if (!found) loads.set(id, (found = Promise.resolve(load())));
  return found;
}

/** A database's properties and what the reader may know of them. */
function loadSchema(loads: PublishedLoads | undefined, databaseId: string, reader: string | null) {
  return once(loads, ["schema", databaseId, reader], async () => {
    const [storedProperties, deleted] = await Promise.all([databaseProperties(databaseId), deletedPropertyIds(databaseId)]);
    const access = await readerAccess(reader, databaseId, storedProperties);
    return { storedProperties, deleted, access };
  });
}

type Schema = Awaited<ReturnType<typeof loadSchema>>;

/**
 * The live rows `publisher` can see. Whether they say if their body holds an image (for gallery
 * covers) is part of the key: few views need it, and it costs a pattern match on every row.
 */
function loadRows(loads: PublishedLoads | undefined, publisher: string, databaseId: string, withCovers: boolean) {
  return once(loads, ["rows", publisher, databaseId, withCovers], () =>
    db
      .select({
        id: page.id,
        title: page.title,
        icon: page.icon,
        properties: page.properties,
        createdBy: page.createdBy,
        updatedBy: page.updatedBy,
        createdAt: page.createdAt,
        updatedAt: page.updatedAt,
        hasImage: withCovers ? sql<boolean>`${page.contentMarkdown} ~ ${PG_MARKDOWN_IMAGE_PATTERN}` : sql<boolean>`false`,
      })
      .from(page)
      .where(and(eq(page.parentId, databaseId), eq(page.isTemplate, false), isNull(page.archivedAt), pageVisibleTo(publisher)))
      .orderBy(asc(page.position), asc(page.createdAt)),
  );
}

type StoredRow = Awaited<ReturnType<typeof loadRows>>[number];

/** The rows with their computed values and formulas, as the reader may see them (publicValues), before any view. */
function loadValues(
  loads: PublishedLoads | undefined,
  publisher: string,
  databaseId: string,
  reader: string | null,
  withCovers: boolean,
  { storedProperties, access }: Schema,
  stored: StoredRow[],
) {
  return once(loads, ["values", publisher, databaseId, reader, withCovers], () =>
    publicValues(
      stored.map(({ createdBy, updatedBy, hasImage: _, ...row }) => ({
        ...row,
        createdBy,
        properties: { ...row.properties, ...computedValues(storedProperties, { createdBy, updatedBy, ...row }) },
      })),
      storedProperties,
      access,
    ),
  );
}

/**
 * A published database's rows as one of its web views shows them (`viewId`, else the first), or as
 * `linked` (a linked view's own settings) does. Only rows `publisher` can see are listed; the
 * print view (server/print.ts) passes the person printing.
 */
export async function publishedDatabase(
  publisher: string,
  databaseId: string,
  {
    viewId,
    linked = null,
    reader = null,
    loads,
  }: {
    viewId?: string;
    linked?: LinkedView | null;
    /** Whose property access applies: null for anonymous visitors (see readerAccess). */
    reader?: string | null;
    /** What other views of the same request read already (see PublishedLoads). */
    loads?: PublishedLoads;
  } = {},
): Promise<PublishedDatabase> {
  const [schema, shownViews] = await Promise.all([
    loadSchema(loads, databaseId, reader),
    linked ? Promise.resolve([]) : readableViews(databaseId).then(webViews),
  ]);
  const { storedProperties, deleted, access } = schema;
  // Every property the reader may know of: filters and sorts may use relations and people, so
  // applyView needs them too; the columns are only the public ones (see publicProperties).
  const allProperties = access.known(storedProperties);
  const picked = linked ? { id: "", name: "", ...linked } : (shownViews.find((v) => v.id === viewId) ?? shownViews[0]);
  const chosen = picked && { ...picked, config: access.config(withoutDeleted(picked.config, deleted)) };
  const withCovers = chosen?.type === "gallery" && galleryCover(chosen.config) === "first_image";
  const stored = await loadRows(loads, publisher, databaseId, withCovers);
  const properties = publicProperties(allProperties);
  const tabs = shownViews.map((v) => ({ id: v.id, name: v.name, type: v.type }));
  if (!chosen) {
    const rows = await publicValues(
      stored.map(({ createdBy, updatedBy: __, hasImage: ___, ...row }) => ({
        ...row,
        createdBy,
        properties: { ...row.properties, ...computedValues(storedProperties, { ...row, createdBy: null }) },
      })),
      storedProperties,
      access,
    );
    return {
      properties: properties.map(publishedProperty),
      view: null,
      views: tabs,
      layout: "table",
      rows: rows.map((row) => onlyValuesOf(row, properties)),
      groups: null,
      cardSize: "medium",
    };
  }
  // Filters and sorts may use relation and people properties; applyView needs every property for that.
  // The columns are the ones the view itself shows, so a list or timeline never publishes what it
  // keeps hidden.
  const rows = await loadValues(loads, publisher, databaseId, reader, withCovers, schema, stored);
  const viewed = applyView(rows, chosen.config, allProperties, { people: await sortNames(rows, allProperties, chosen.config) });
  if (chosen.type === "chart") {
    return {
      properties: [],
      view: { id: chosen.id, name: chosen.name, type: chosen.type },
      views: tabs,
      layout: "chart",
      rows: [],
      groups: null,
      cardSize: "medium",
      chart: publishedChart(chosen.config, properties, allProperties, viewed),
    };
  }
  const covers = withCovers ? await rowCovers(stored) : null;
  // A gallery taking covers from a files property shows each row's first image there.
  const coverFrom = chosen.type === "gallery" ? coverProperty(chosen.config, properties) : null;
  const coverOf = (row: PublishedRow) =>
    covers ? { cover: covers.get(row.id) ?? null } : coverFrom ? { cover: firstImageFile(row.properties[coverFrom.id])?.url ?? null } : {};
  const groups = publishedGroups(chosen, allProperties, viewed);
  // A board whose columns would name people or linked rows shows as a table.
  const layout = chosen.type === "board" && !groups ? "table" : (LAYOUTS[chosen.type] ?? "table");
  const shown = orderProperties(properties, chosen.config.propertyOrder).filter(
    (prop) => !isHiddenInView(chosen, prop) && !(layout === "board" && prop.id === groups?.property.id),
  );
  return {
    properties: shown.map(publishedProperty),
    view: { id: chosen.id, name: chosen.name, type: chosen.type },
    views: tabs,
    layout,
    rows: viewed.map((row) => ({ ...onlyValuesOf(row, shown), ...coverOf(row) })),
    groups: layout === "board" || layout === "table" ? groups : null,
    cardSize: chosen.config.cardSize ?? "medium",
  };
}

/**
 * A chart's figures over `rows`, measured and grouped by public properties only: to visitors the
 * others aren't there, so a chart grouped by one has nothing to group by and a calculation over one
 * counts rows. Created and edited times count by their UTC day, as in publishedGroups.
 */
function publishedChart(config: ViewConfig, properties: DatabaseProperty[], known: DatabaseProperty[], rows: PublishedRow[]): PublishedChart {
  const measure = chartMeasure(config, properties);
  const chartType = chartTypeOf(config);
  const hiddenGroup = !!config.groupBy && !properties.some((p) => p.id === config.groupBy) && known.some((p) => p.id === config.groupBy);
  const groupBy = chartType === "number" || hiddenGroup ? null : chartGroupProperty(properties, config);
  const accumulate = groupBy ? chartAccumulateOf(config, groupBy, measure) : null;
  const stackBy =
    (groupBy &&
      !accumulate &&
      properties.find((p) => p.id === config.stackBy && p.id !== groupBy.id && isStackable(p.type) && canStack(chartType, measure))) ||
    null;
  const context = { people: [], dayOf: (value: unknown) => timestampDay(value, "UTC") };
  const data = groupBy ? withoutRows(chartData(rows, { groupBy, stackBy, measure, config, context, stackContext: context })) : null;
  const named = new Set([groupBy?.id, stackBy?.id, measure.kind === "aggregate" ? measure.prop.id : undefined]);
  return {
    chartType,
    measure,
    accumulate,
    properties: properties.filter((p) => named.has(p.id)).map(({ id, name, type }) => ({ id, name, type })),
    groupById: groupBy?.id ?? null,
    stackById: stackBy?.id ?? null,
    rowCount: rows.length,
    result: chartType === "number" ? measureRows(rows, measure) : null,
    data,
  };
}

/**
 * The row with only the values the page shows. Rows reach the visitor's browser as data, so values
 * of hidden, people and relation properties must not ride along.
 */
function onlyValuesOf<R extends PublishedRow>(row: R, shown: DatabaseProperty[]): PublishedRow {
  const { id, title, icon, createdAt, updatedAt } = row;
  return {
    id,
    title,
    icon,
    createdAt,
    updatedAt,
    properties: Object.fromEntries(shown.map((p) => [p.id, row.properties[p.id]])),
    ...stylesOf(row, shown),
  };
}

/**
 * Board columns and table sections, in the view's order without the groups it hides. Only for
 * properties the page publishes: groups by people or linked rows would name what it doesn't.
 * Created and edited times count by their UTC day, as the visitor's time zone isn't known here.
 */
function publishedGroups(
  view: { type: ViewType; config: ViewConfig },
  properties: DatabaseProperty[],
  rows: PublishedRow[],
): PublishedDatabase["groups"] {
  const property =
    view.type === "board"
      ? boardGroupProperty(properties, view.config.groupBy)
      : view.type === "table"
        ? properties.find((p) => p.id === view.config.groupBy && isGroupable(p.type))
        : undefined;
  if (!property || PRIVATE_TYPES.has(property.type)) return null;
  const dayOf = (value: unknown) => (typeof value === "string" ? value.slice(0, 10) : null);
  const { shown } = arrangeGroups(groupRowsBy(rows, property, view.config, { dayOf }), view.config);
  return {
    property: publishedProperty(property),
    list: shown.map((g) => ({ key: g.key, value: g.value, rowIds: g.rows.map((r) => r.id) })),
  };
}

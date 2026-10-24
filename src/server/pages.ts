import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { loadMessages } from "@/i18n/messages";
import { parseIcon } from "@/lib/icon";
import { parsePageBackground, type PageBackground } from "@/lib/page-background";
import { assertNotInTrash, assertPageUnlocked } from "@/lib/page-lock";
import { makeStatusOptions } from "@/lib/properties";
import { trashDeletionDate } from "@/lib/retention";
import { anyWordTerms, anyWordTsQuery, searchQueryParts } from "@/lib/search-words";
import {
  databaseProperty,
  databaseView,
  file,
  fileReference,
  fileText,
  journal,
  oauthClient,
  page,
  pageColumns,
  pagePermission,
  pageSnapshot,
  type PageKind,
  teamspace,
  user,
  type ViewType,
  workspaceAgent,
} from "@/db/schema";
import {
  AccessError,
  type AccessLevel,
  accessRank,
  enforceWorkspacePolicy,
  levelFromRank,
  pageIdColumn,
  pageVisibleTo,
  requireMember,
  requireMembership,
  requirePageAccess,
  workspacesHeldBack,
} from "@/server/access";
import { recordAudit } from "@/server/audit";
import { savedLocale } from "@/server/mail/locale";
import type { AuditPagePlace } from "@/lib/audit";
import { getCollab, type WriteActor } from "@/server/collab/bridge";
import {
  afterRowWrites,
  authorizeRowFiles,
  bulkRowIds,
  normalizeRowProperties,
  rowsWithAccess,
  syncPairedRelations,
  withCode,
  type BulkResult,
} from "@/server/databases";
import { PAGE_HEADER_EVENT } from "@/lib/collab-constants";
import { searchFold } from "@/lib/search-fold";
import { NO_SEARCH_FILTERS, searchDateRange, type SearchFilters } from "@/lib/search-filters";
import { parseSearchQuery } from "@/lib/search-query";
import { uniqueIdQuery } from "@/lib/unique-id";
import { pageChanged } from "@/server/page-events";
import { heldPageIds, refuseHeldPages } from "@/server/legal-hold";
import { beforePagesDeleted, queuePageCreated, queuePageMoved, queuePagesDeleted, queuePageTrashed } from "@/server/page-webhooks/queue";
import { searchFoldSql } from "@/server/search-fold-sql";
import { sweepDocuments } from "@/server/file-text";
import { listedPage, isOutdated, outdatedIds } from "@/server/page-outdated";
import { searchScope, semanticSearch, type SearchScope } from "@/server/semantic-search";
import { activeVerification } from "@/server/verification";
import { reciprocalRankFusion, snippetOf } from "@/server/semantic-text";
import { assertNestable, subtreeHeight } from "@/server/page-depth";
import { followNewSpace, freezeInheritedEntries, keepFullAccess, makePagePrivate } from "@/server/permissions";
import { placeTopLevel, requireTeamspaceForPages, sidebarTeamspaces, type TeamspaceSummary } from "@/server/teamspaces";
import { listWorkspaces, requireTopLevel, workspaceSettings } from "@/server/workspaces";

import { placeInSections, PRIVATE_SECTION, SHARED_SECTION, type TreeSection } from "@/lib/tree-sections";

// Where a page shows in the sidebar: the section of a teamspace the user is in (its id), their
// private pages, or pages shared with them from elsewhere.
export { PRIVATE_SECTION, SHARED_SECTION, type TreeSection };

export type TreeNode = {
  id: string;
  /** The parent, when it is in the tree too; null for the top of a section. */
  parentId: string | null;
  kind: PageKind;
  title: string;
  icon: string | null;
  position: number;
  /** The user's access to the page, so the sidebar only offers what the server allows. */
  level: AccessLevel;
  /** The teamspace the page belongs to; null for private pages. */
  teamspaceId: string | null;
  section: TreeSection;
  /** Databases only: their views, listed under the database in the sidebar. */
  views?: TreeView[];
};

export type TreeView = { id: string; name: string; type: ViewType };

export { listWorkspaces } from "@/server/workspaces";

/**
 * Sidebar tree: the live pages the user can see except database rows (those live inside their
 * database), templates (listed by the template picker) and archived pages with the pages under
 * them (server/page-outdated.ts), each in its section:
 * - the teamspaces they are in (archived ones left out), with their pages;
 * - "private": their own pages outside any teamspace;
 * - "shared": pages shared with them by name that are in neither, such as a page of a closed
 *   teamspace or someone's private page. A page whose parent they can't see shows at the top.
 * Pages of open teamspaces they haven't joined stay out, like those teamspaces; search finds them.
 */
export async function getTree(userId: string, workspaceId: string): Promise<TreeNode[]> {
  await requireMembership(userId, workspaceId);
  const rows = await db.execute<{
    id: string;
    parent_id: string | null;
    kind: PageKind;
    title: string;
    icon: string | null;
    position: number;
    level: number;
    teamspace_id: string | null;
    mine: boolean;
    shared: boolean;
  }>(sql`
    with ranked as materialized (
      -- Materialized so the access level is worked out once per page, for the filter and the result.
      select p.id, p.parent_id, p.kind, p.title, p.icon, p.position, p.created_at, p.teamspace_id, p.created_by,
        ${accessRank(userId, pageIdColumn("p"))} as level
      from ${page} p
      left join ${page} parent on parent.id = p.parent_id
      where p.workspace_id = ${workspaceId}
        and ${listedPage(workspaceId, { alias: "p" })}
        and (parent.id is null or parent.kind <> 'database')
    )
    select id, parent_id, kind, title, icon, position, level, teamspace_id,
      coalesce(created_by = ${userId}, false) as mine,
      exists (select 1 from ${pagePermission} pp where pp.page_id = ranked.id and pp.user_id = ${userId} and pp.level <> 'none') as shared
    from ranked
    where level > 0
    order by position, created_at
  `);
  const joined = new Set((await sidebarTeamspaces(userId, workspaceId)).map((t) => t.id));
  const placement = placeInSections(
    rows.map((r) => ({ id: r.id, parentId: r.parent_id, teamspaceId: r.teamspace_id, mine: r.mine, shared: r.shared })),
    joined,
  );
  const nodes = rows.flatMap((r) => {
    const where = placement.get(r.id);
    return where ? [{ r, ...where }] : [];
  });
  const views = await db
    .select({ id: databaseView.id, name: databaseView.name, type: databaseView.type, databaseId: databaseView.databaseId })
    .from(databaseView)
    .innerJoin(page, eq(page.id, databaseView.databaseId))
    .where(and(eq(page.workspaceId, workspaceId), isNull(page.archivedAt), isNull(databaseView.deletedAt), pageVisibleTo(userId)))
    .orderBy(asc(databaseView.position));
  const viewsOf = new Map<string, TreeView[]>();
  for (const { databaseId, ...v } of views) viewsOf.set(databaseId, [...(viewsOf.get(databaseId) ?? []), v]);
  return nodes.map(({ r, section, parentId }) => ({
    id: r.id,
    parentId,
    kind: r.kind,
    title: r.title,
    icon: r.icon,
    position: Number(r.position),
    level: levelFromRank(r.level),
    teamspaceId: r.teamspace_id,
    section,
    ...(r.kind === "database" ? { views: viewsOf.get(r.id) ?? [] } : {}),
  }));
}

export type SidebarData = {
  tree: TreeNode[];
  teamspaces: TeamspaceSummary[];
  /** The page the user's daily notes go under (see server/journal.ts), listed apart from the other pages. */
  journalPageId: string | null;
};

/** The sidebar: its page tree, the teamspaces it has a section for and the user's journal. */
export async function getSidebar(userId: string, workspaceId: string): Promise<SidebarData> {
  const [tree, teamspaces, [ownJournal]] = await Promise.all([
    getTree(userId, workspaceId),
    sidebarTeamspaces(userId, workspaceId),
    db
      .select({ pageId: journal.pageId })
      .from(journal)
      .where(and(eq(journal.workspaceId, workspaceId), eq(journal.userId, userId))),
  ]);
  // Only while it is in the tree: one in the trash, or out of their reach, is no journal to list.
  const journalPageId = ownJournal?.pageId && tree.some((n) => n.id === ownJournal.pageId) ? ownJournal.pageId : null;
  return { tree, teamspaces, journalPageId };
}

export async function getPage(userId: string, pageId: string) {
  return requirePageAccess(userId, pageId, "view");
}

/**
 * The view a database page opens on, named in its tab title: the one in the address, else its
 * first (as the database itself picks). Access is the caller's to check.
 */
export async function openViewName(databaseId: string, viewId: string | null): Promise<string | null> {
  const views = await db
    .select({ id: databaseView.id, name: databaseView.name })
    .from(databaseView)
    .where(and(eq(databaseView.databaseId, databaseId), isNull(databaseView.deletedAt)))
    .orderBy(asc(databaseView.position));
  return (views.find((v) => v.id === viewId) ?? views[0])?.name || null;
}

export async function getBreadcrumbs(userId: string, pageId: string) {
  await requirePageAccess(userId, pageId, "view");
  const rows = await db.execute<{ id: string; title: string; icon: string | null; kind: PageKind; depth: number }>(sql`
    with recursive chain as (
      select id, parent_id, workspace_id, title, icon, kind, 0 as depth from ${page} where id = ${pageId}
      union all
      select p.id, p.parent_id, p.workspace_id, p.title, p.icon, p.kind, c.depth + 1
      from ${page} p join chain c on p.id = c.parent_id
    )
    select id, title, icon, kind, depth from chain
    where ${pageVisibleTo(userId, "chain")}
    order by depth desc
  `);
  return rows.map((r) => ({ id: r.id, title: r.title, icon: r.icon, kind: r.kind }));
}

async function nextPosition(workspaceId: string, parentId: string | null) {
  const [row] = await db
    .select({ max: sql<number | null>`max(${page.position})` })
    .from(page)
    .where(and(eq(page.workspaceId, workspaceId), parentId ? eq(page.parentId, parentId) : isNull(page.parentId)));
  return (Number(row?.max) || 0) + 1;
}

export type CreatePageInput = {
  workspaceId: string;
  parentId?: string | null;
  kind?: PageKind;
  title?: string;
  icon?: string | null;
  markdown?: string;
  /** Row values, keyed by property id or name, when the parent is a database. */
  properties?: Record<string, unknown>;
  /** Names for a new database's starter properties and view, in the creator's language. */
  seedNames?: DatabaseSeedNames;
  /** Databases: false leaves out the starter Status and Tags properties (imports bring their own). */
  seedProperties?: boolean;
  /**
   * Adds a template instead of a page: a workspace template at the top level, a row template
   * under a database (see server/templates.ts).
   */
  template?: boolean;
  /**
   * Top-level pages: the teamspace to add it to (the user must be in it), null for a private page,
   * or undefined for the workspace's first default teamspace. Ignored under a parent. A guest's
   * top-level pages are always private.
   */
  teamspaceId?: string | null;
};

export type DatabaseSeedNames = {
  status: string;
  notStarted: string;
  inProgress: string;
  done: string;
  tags: string;
  table: string;
};

/** Used when no language is known, e.g. databases created by MCP clients of people who haven't signed in since languages were saved. */
export const ENGLISH_SEED_NAMES: DatabaseSeedNames = {
  status: "Status",
  notStarted: "Not started",
  inProgress: "In progress",
  done: "Done",
  tags: "Tags",
  table: "Table",
};

/**
 * Starter names for a database made outside the app (by an MCP client), in the language its maker
 * last used the app in, so it reads like the databases they make in the app.
 */
export async function savedSeedNames(userId: string): Promise<DatabaseSeedNames> {
  const locale = await savedLocale(userId);
  if (!locale) return ENGLISH_SEED_NAMES;
  const { page, views } = (await loadMessages(locale)).database;
  return {
    status: page.defaultGroupProperty,
    notStarted: page.defaultGroupOptions.notStarted,
    inProgress: page.defaultGroupOptions.inProgress,
    done: page.defaultGroupOptions.done,
    tags: page.defaultTagsProperty,
    table: views.table,
  };
}

/**
 * Pages and databases are recorded in the audit log as they are created, moved, put in the trash
 * and taken out of it; database rows are content, like what a page says, and so are the pages of
 * templates. A row deleted for good is still recorded (deleteTrashedPages).
 */
async function auditedAsPage(p: { parentId: string | null; inTemplate: boolean }) {
  if (p.inTemplate) return false;
  if (!p.parentId) return true;
  const [parent] = await db.select({ kind: page.kind }).from(page).where(eq(page.id, p.parentId));
  return parent?.kind !== "database";
}

/** Where a page is, for page.moved: under a page, at the top of a teamspace, or among private pages. */
async function pagePlace(parentId: string | null, teamspaceId: string | null): Promise<AuditPagePlace> {
  if (parentId) {
    const [parent] = await db.select({ title: page.title }).from(page).where(eq(page.id, parentId));
    return { type: "page", id: parentId, label: parent?.title ?? "" };
  }
  if (!teamspaceId) return { type: "private" };
  const [space] = await db.select({ name: teamspace.name }).from(teamspace).where(eq(teamspace.id, teamspaceId));
  return { type: "teamspace", id: teamspaceId, label: space?.name ?? "" };
}

/**
 * `audit: false` leaves the page out of the audit log: imports record themselves once, as a whole
 * (and take back what they created when they fail).
 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * In the transaction that puts a page under `parentId`: refuses a parent in the trash (a page
 * under it would be hidden, and deleted with it), and holds the parent until the transaction ends.
 * Trashing it meanwhile waits, and its sweep then takes the new page along (archivePage); a page
 * put there after it was trashed finds it in the trash.
 */
export async function lockLiveParent(tx: Tx, parentId: string) {
  const [row] = await tx.execute<{ archived_at: Date | null }>(sql`select archived_at from ${page} where id = ${parentId} for share`);
  if (!row || row.archived_at) throw withCode(new AccessError("Parent page is in the trash"), "parentInTrash");
}

export async function createPage(actor: WriteActor, input: CreatePageInput, { audit = true }: { audit?: boolean } = {}) {
  const { userId } = actor;
  const kind = input.kind ?? "page";
  const icon = input.icon === null || input.icon === undefined ? null : checkedIcon(input.icon);
  let workspaceId = input.workspaceId;
  let parentKind: PageKind | null = null;
  // Pages added under a template belong to it, and stay out of the sidebar and search like it.
  let parentInTemplate = false;
  // A top-level page goes to a teamspace, or is private: theirs alone.
  let placement: { teamspaceId: string | null; private: boolean } = { teamspaceId: null, private: false };
  if (input.parentId) {
    const parent = await requirePageAccess(userId, input.parentId, "edit");
    workspaceId = parent.workspaceId;
    placement = { teamspaceId: parent.teamspaceId, private: false };
    parentKind = parent.kind;
    parentInTemplate = parent.inTemplate;
    if (parent.archivedAt) throw withCode(new AccessError("Parent page is in the trash"), "parentInTrash");
    if (parent.kind === "database" && kind === "database") {
      throw withCode(new Error("A database can't contain another database"), "nestedDatabase");
    }
    await assertNestable(input.parentId);
  } else {
    placement = await placeTopLevel(userId, workspaceId, await requireTopLevel(userId, workspaceId), input.teamspaceId);
  }
  const isTemplate = Boolean(input.template);
  if (isTemplate && input.parentId && parentKind !== "database") {
    throw new Error("Templates are added to the workspace or to a database");
  }
  const inTemplate = isTemplate || parentInTemplate;

  const properties =
    parentKind === "database" && input.properties
      ? // The row will be theirs: "created by" exceptions count for them.
        await normalizeRowProperties(userId, input.parentId!, input.properties, {}, { createdBy: userId, template: isTemplate })
      : {};

  const position = await nextPosition(workspaceId, input.parentId ?? null);
  const created = await db.transaction(async (tx) => {
    if (input.parentId) await lockLiveParent(tx, input.parentId);
    const [row] = await tx
      .insert(page)
      .values({
        workspaceId,
        parentId: input.parentId ?? null,
        kind,
        title: input.title?.trim() ?? "",
        icon,
        properties,
        position,
        isTemplate,
        inTemplate,
        teamspaceId: placement.teamspaceId,
        createdBy: userId,
        updatedBy: userId,
      })
      .returning(pageColumns);
    if (placement.private) await makePagePrivate(tx, workspaceId, row.id, userId);
    else if (!input.parentId && placement.teamspaceId) await keepFullAccess(tx, workspaceId, row.id, userId);
    if (audit && !inTemplate && parentKind !== "database") {
      await recordAudit(
        { workspaceId, actorId: userId, action: "page.created", target: { type: "page", id: row.id, label: row.title }, details: { kind } },
        tx,
      );
    }
    return row;
  });

  if (kind === "database") {
    const names = input.seedNames ?? ENGLISH_SEED_NAMES;
    if (input.seedProperties !== false) {
      await db.insert(databaseProperty).values([
        {
          databaseId: created.id,
          name: names.status,
          type: "status",
          position: 1,
          options: { options: makeStatusOptions([names.notStarted, names.inProgress, names.done]) },
        },
        { databaseId: created.id, name: names.tags, type: "multi_select", position: 2, options: { options: [] } },
      ]);
    }
    await db.insert(databaseView).values({ databaseId: created.id, name: names.table, type: "table", position: 1 });
  }

  // Templates link one way and assign nobody: their values only seed the rows made from them.
  if (parentKind === "database" && !inTemplate) {
    await syncPairedRelations(created.id, input.parentId!, {}, properties);
    await afterRowWrites(userId, input.parentId!, [{ rowId: created.id, before: {}, after: properties }], { created: true });
  } else if (parentKind === "database") {
    await authorizeRowFiles(userId, [{ rowId: created.id, before: {}, after: properties }]);
  }

  const collab = getCollab();
  try {
    // Rejects when the body couldn't be saved: the page then stays, empty, and the caller hears why.
    if (input.markdown?.trim()) await collab.replaceContent(created.id, input.markdown, actor);
  } finally {
    pageChanged({ pageId: created.id });
    // Page webhooks hear about it a few seconds on, with the body written by then.
    await queuePageCreated(created.id, userId);
    collab.broadcast(`ws:${workspaceId}`, "tree");
    if (parentKind === "database") collab.broadcast(`db:${input.parentId}`, "rows");
  }
  return created;
}

/** The checks every change of a page's title, icon, background or body makes. */
function assertChangeable(p: Parameters<typeof assertPageUnlocked>[0] & Parameters<typeof assertNotInTrash>[0]) {
  assertNotInTrash(p);
  assertPageUnlocked(p);
}

export async function renamePage(actor: WriteActor, pageId: string, title: string) {
  assertChangeable(await requirePageAccess(actor.userId, pageId, "edit"));
  // Title lives in the shared doc so open editors update live; the store hook persists it.
  await getCollab().setTitle(pageId, title.trim(), actor);
}

/** A page's icon is an emoji (lib/icon); anything else is refused with `invalidIcon`. */
function checkedIcon(value: unknown) {
  const icon = parseIcon(value);
  if (!icon) throw withCode(new Error("A page's icon is an emoji"), "invalidIcon");
  return icon;
}

export async function setPageIcon(userId: string, pageId: string, icon: string | null) {
  const checked = icon === null ? null : checkedIcon(icon);
  const p = await requirePageAccess(userId, pageId, "edit");
  assertChangeable(p);
  await db.update(page).set({ icon: checked, updatedBy: userId }).where(eq(page.id, pageId));
  pageHeaderChanged(p);
}

/**
 * Gives every selected row of a database the same icon, or takes theirs away (null): "Set icon" on
 * a selection. The icon is checked once, before anything is written. Access is checked per row as
 * for setPageIcon: rows the user may not edit, rows in the trash and locked rows are skipped and
 * returned (see rowsWithAccess).
 */
export async function setRowsIcon(userId: string, databaseId: string, rowIds: string[], icon: string | null): Promise<BulkResult> {
  const ids = bulkRowIds(rowIds);
  const checked = icon === null ? null : checkedIcon(icon);
  const database = await requirePageAccess(userId, databaseId, "view");
  if (database.kind !== "database") throw withCode(new AccessError("Not a database"), "notADatabase");
  const { rows, skipped } = await rowsWithAccess(userId, databaseId, ids, "edit");
  if (!rows.length) return { done: [], skipped };
  const changed = await db
    .update(page)
    .set({ icon: checked, updatedBy: userId })
    .where(and(inArray(page.id, rows.map((r) => r.id)), isNull(page.lockedAt)))
    .returning({ id: page.id });
  const done = new Set(changed.map((r) => r.id));
  const collab = getCollab();
  collab.broadcast(`ws:${database.workspaceId}`, "tree");
  collab.broadcast(`db:${databaseId}`, "rows");
  for (const id of done) collab.broadcast(`page:${id}`, PAGE_HEADER_EVENT);
  return {
    done: ids.filter((id) => done.has(id)),
    skipped: [...skipped, ...rows.filter((r) => !done.has(r.id)).map((r) => r.id)],
  };
}

/**
 * Locks or unlocks a page (not a database: see setDatabaseLocked) against accidental edits of its
 * title, icon, background and body (lib/page-lock). Anyone who can edit the page may do either.
 * Open editors turn read-only, or editable again, without a reload.
 */
export async function setPageLocked(userId: string, pageId: string, locked: boolean) {
  const p = await requirePageAccess(userId, pageId, "edit");
  if (p.kind !== "page") throw new Error("A database locks its properties and views instead (setDatabaseLocked)");
  await db
    .update(page)
    .set({ lockedAt: locked ? new Date() : null, updatedBy: userId })
    .where(eq(page.id, pageId));
  const collab = getCollab();
  // Before the header event: tabs that refetch on it find their connection already as it should be.
  await collab.pageLockChanged(pageId, locked);
  pageHeaderChanged(p);
}

/**
 * The icon or background changed: the sidebar and database views show the icon, and the page
 * itself shows both to everyone who has it open (PAGE_HEADER_EVENT).
 */
function pageHeaderChanged(p: { id: string; workspaceId: string; parentId: string | null }) {
  const collab = getCollab();
  collab.broadcast(`ws:${p.workspaceId}`, "tree");
  if (p.parentId) collab.broadcast(`db:${p.parentId}`, "rows");
  collab.broadcast(`page:${p.id}`, PAGE_HEADER_EVENT);
}

/** Sets or removes the page's background color (lib/page-background). */
export async function setPageBackground(userId: string, pageId: string, background: PageBackground | null) {
  const p = await requirePageAccess(userId, pageId, "edit");
  assertChangeable(p);
  const checked = background === null ? null : parsePageBackground(background);
  if (background !== null && !checked) throw new Error("Not a background");
  await db.update(page).set({ background: checked, updatedBy: userId }).where(eq(page.id, pageId));
  pageHeaderChanged(p);
}

function subtreeIds(rootId: string) {
  return sql`(
    with recursive sub as (
      select id from ${page} where id = ${rootId}
      union all
      select p.id from ${page} p join sub on p.parent_id = sub.id
    ) select id from sub
  )`;
}

export async function archivePage(userId: string, pageId: string) {
  const p = await requirePageAccess(userId, pageId, "edit");
  // Templates aren't listed in the trash; they are deleted from the template picker instead.
  if (p.isTemplate) throw withCode(new Error("Templates are deleted, not moved to the trash"), "isTemplate");
  const archivedAt = new Date();
  const sweep = () =>
    db
      .update(page)
      .set({ archivedAt, updatedBy: userId })
      .where(and(sql`${page.id} in ${subtreeIds(pageId)}`, isNull(page.archivedAt)))
      .returning({ id: page.id });
  // Twice: a page moved or added under one of these while the first sweep waited for it
  // (lockLiveParent) isn't in what that sweep read, and would be left alive under a page in the trash.
  const trashed = [...(await sweep()), ...(await sweep())];
  // Open editors stop writing at once: a page in the trash doesn't change (assertNotInTrash).
  await getCollab().pagesTrashed(trashed.map((t) => t.id), true);
  // One event for the page, not for each page under it.
  if (!p.archivedAt) await queuePageTrashed(p.id, userId);
  if (!p.archivedAt && (await auditedAsPage(p))) {
    await recordAudit({
      workspaceId: p.workspaceId,
      actorId: userId,
      action: "page.trashed",
      target: { type: "page", id: p.id, label: p.title },
      details: { kind: p.kind },
    });
  }
  getCollab().broadcast(`ws:${p.workspaceId}`, "tree");
  if (p.parentId) getCollab().broadcast(`db:${p.parentId}`, "rows");
  return p;
}

/**
 * Moves several rows of a database to the trash at once, each with its subpages, like archivePage
 * does for one. Rows the user may edit go in one statement; the rest are skipped and returned
 * (see rowsWithAccess). Each row stays its own trash entry, restorable on its own.
 */
export async function archiveRows(userId: string, databaseId: string, rowIds: string[]): Promise<BulkResult> {
  const ids = bulkRowIds(rowIds);
  const database = await requirePageAccess(userId, databaseId, "view");
  if (database.kind !== "database") throw withCode(new AccessError("Not a database"), "notADatabase");
  const { rows, skipped } = await rowsWithAccess(userId, databaseId, ids, "edit");
  if (!rows.length) return { done: [], skipped };
  const roots = rows.map((r) => r.id);
  const archivedAt = new Date();
  const sweep = () =>
    db
      .update(page)
      .set({ archivedAt, updatedBy: userId })
      .where(
        and(
          sql`${page.id} in (
            with recursive sub as (
              select id from ${page} where ${inArray(page.id, roots)}
              union all
              select p.id from ${page} p join sub on p.parent_id = sub.id
            ) select id from sub
          )`,
          isNull(page.archivedAt),
        ),
      )
      .returning({ id: page.id });
  // Twice, as in archivePage.
  const trashed = [...(await sweep()), ...(await sweep())];
  await getCollab().pagesTrashed(trashed.map((t) => t.id), true);
  getCollab().broadcast(`ws:${database.workspaceId}`, "tree");
  getCollab().broadcast(`db:${databaseId}`, "rows");
  return { done: roots, skipped };
}

export async function restorePage(userId: string, pageId: string) {
  const p = await requirePageAccess(userId, pageId, "edit");
  // Restoring under an archived parent would leave the page unreachable; lift it to the root.
  let parentId = p.parentId;
  if (parentId) {
    const [parent] = await db.select({ archivedAt: page.archivedAt }).from(page).where(eq(page.id, parentId));
    if (!parent || parent.archivedAt) parentId = null;
  }
  // Only what was trashed together with it: subpages trashed earlier stay in the trash as their own
  // entries (archivePage stamps just the pages that weren't archived yet).
  const restored = await db
    .update(page)
    .set({ archivedAt: null })
    .where(
      and(
        sql`${page.id} in ${subtreeIds(pageId)}`,
        sql`${page.archivedAt} = (select root.archived_at from ${page} root where root.id = ${pageId})`,
      ),
    )
    .returning({ id: page.id });
  // A row merged into another one comes back as a row of its own; what moved stays moved (server/merge-rows.ts).
  if (p.mergedIntoId) await db.update(page).set({ mergedIntoId: null }).where(eq(page.id, pageId));
  await getCollab().pagesTrashed(restored.map((r) => r.id), false);
  if (parentId !== p.parentId) {
    // Lifted to the top of its teamspace (or of the private pages): it keeps the access it had
    // from its old ancestors rather than opening up to everyone there, or to nobody.
    await db.transaction(async (tx) => {
      await freezeInheritedEntries(tx, p.workspaceId, pageId);
      await tx.update(page).set({ parentId }).where(eq(page.id, pageId));
    });
  }
  // Under its old parent when that wasn't a database's row: a row lifted to the top is a page now.
  if (p.archivedAt && (await auditedAsPage({ parentId, inTemplate: p.inTemplate }))) {
    await recordAudit({
      workspaceId: p.workspaceId,
      actorId: userId,
      action: "page.restored",
      target: { type: "page", id: p.id, label: p.title },
      details: { kind: p.kind },
    });
  }
  if (p.archivedAt) await queuePageTrashed(pageId, userId, true);
  // Back in search; the index catches up if it was left behind meanwhile (with the pages under it
  // when it was lifted to the top: their chunks name the pages above).
  pageChanged({ pageId, subtree: parentId !== p.parentId });
  getCollab().broadcast(`ws:${p.workspaceId}`, "tree");
  if (parentId) getCollab().broadcast(`db:${parentId}`, "rows");
}

export async function deletePagePermanently(userId: string, pageId: string) {
  const p = await requirePageAccess(userId, pageId, "full");
  if (!p.archivedAt) throw new Error("Move the page to the trash before deleting it");
  // Said, rather than left in the trash without a word (deleteTrashedPages keeps it either way).
  await refuseHeldPages(p.workspaceId, [pageId]);
  await deleteTrashedPages(p.workspaceId, [pageId], userId);
}

/**
 * Deletes pages of the trash for good, with their subpages (and their history, comments and so on,
 * which go with the page), then the uploads no other page shows. Pages taken out of the trash in
 * the meantime are left alone, and so are those a legal hold keeps (server/legal-hold.ts). Returns
 * the ids deleted. No access check: deletePagePermanently checks the person, the retention cleanup
 * (server/retention.ts) acts for the workspace.
 *
 * Each page deleted is recorded in the audit log, as `actorId`'s doing or, for null, the server's.
 */
export async function deleteTrashedPages(workspaceId: string, pageIds: string[], actorId: string | null = null) {
  if (!pageIds.length) return [];
  const held = await heldPageIds(workspaceId, pageIds);
  const ids = pageIds.filter((id) => !held.has(id));
  if (!ids.length) return [];
  // Page webhooks: what their deliveries say about the pages, read while they are still there.
  const forWebhooks = await beforePagesDeleted(workspaceId, ids);
  const deleted = await db
    .delete(page)
    .where(and(eq(page.workspaceId, workspaceId), inArray(page.id, ids), isNotNull(page.archivedAt)))
    .returning({ id: page.id, title: page.title, kind: page.kind });
  if (!deleted.length) return [];
  // After the delete, which is one statement: the titles came back from it.
  await recordAudit(
    deleted.map((d) => ({
      workspaceId,
      actorId,
      action: "page.deleted" as const,
      target: { type: "page" as const, id: d.id, label: d.title },
      details: { kind: d.kind },
    })),
  );
  await queuePagesDeleted(
    workspaceId,
    forWebhooks,
    deleted.map((d) => d.id),
    actorId,
  );

  getCollab().broadcast(`ws:${workspaceId}`, "tree");
  await removeOrphanFiles(workspaceId);
  return deleted.map((d) => d.id);
}

/**
 * Removes the uploads of pages just deleted for good that no other page shows (see
 * server/files.ts). A failure only leaves them to the hourly cleanup.
 */
export async function removeOrphanFiles(workspaceId: string) {
  try {
    const { purgeOrphanFiles } = await import("@/server/files");
    await purgeOrphanFiles(workspaceId);
  } catch (error) {
    console.error("[files] cleanup after deleting pages failed", error);
  }
}

/**
 * The trash: each entry carries the user's access level and, under the workspace's retention
 * setting, when it will be deleted for good (null when the workspace keeps it).
 */
export async function listTrash(userId: string, workspaceId: string) {
  await requireMembership(userId, workspaceId);
  const { trashRetentionDays } = await workspaceSettings(workspaceId);
  // Only roots of archived subtrees; their descendants come back with them. The access level says
  // whether the user may restore (edit) or delete for good (full).
  const rows = await db.execute<{
    id: string;
    title: string;
    icon: string | null;
    kind: PageKind;
    archived_at: Date;
    level: number;
    merged_into_id: string | null;
    merged_into_title: string | null;
  }>(sql`
    with ranked as materialized (
      select p.id, p.title, p.icon, p.kind, p.archived_at, p.merged_into_id, ${accessRank(userId, pageIdColumn("p"))} as level
      from ${page} p
      left join ${page} parent on parent.id = p.parent_id
      where p.workspace_id = ${workspaceId}
        and p.archived_at is not null
        and not p.is_template
        and (parent.id is null or parent.archived_at is null or parent.archived_at <> p.archived_at)
    )
    select ranked.id, ranked.title, ranked.icon, ranked.kind, ranked.archived_at, ranked.level, ranked.merged_into_id,
      -- The row it was merged into, by title, where the user may see that row.
      case when kept.id is not null and ${accessRank(userId, sql`kept.id`)} > 0 then kept.title end as merged_into_title
    from ranked
    left join ${page} kept on kept.id = ranked.merged_into_id
    where ranked.level > 0
    order by ranked.archived_at desc
    limit 100
  `);
  return rows.map(({ level, merged_into_id, merged_into_title, ...r }) => ({
    ...r,
    level: levelFromRank(level),
    deletesAt: trashDeletionDate(new Date(r.archived_at), trashRetentionDays),
    // Merged into another row (server/merge-rows.ts): which one, when the user may see it.
    mergedInto: merged_into_id ? { id: merged_into_id, title: merged_into_title } : null,
  }));
}

/**
 * Reordering among the same siblings needs edit access. Moving under another parent, or to another
 * teamspace, changes who inherits access to the page, so it needs full access, like sharing; the
 * top level also needs a member: a guest's top-level pages are private to them, which a move
 * wouldn't make them.
 *
 * `teamspaceId` says where a page moved to the top level goes: a teamspace the user is in, null for
 * their private pages, or undefined for the top of the teamspace it is in now. A page that changes
 * teamspace takes the access of its new place (see followNewSpace).
 */
export async function movePage(
  userId: string,
  pageId: string,
  newParentId: string | null,
  position?: number,
  teamspaceId?: string | null,
) {
  const current = await requirePageAccess(userId, pageId, "edit");
  const parent = newParentId ? await requirePageAccess(userId, newParentId, "edit") : null;
  const space = parent ? parent.teamspaceId : teamspaceId === undefined ? current.teamspaceId : teamspaceId;
  const changesSpace = space !== current.teamspaceId;
  const p = current.parentId === newParentId && !changesSpace ? current : await requirePageAccess(userId, pageId, "full");
  if (!newParentId && (p.parentId !== null || changesSpace)) {
    await requireMember(userId, p.workspaceId);
    if (space) await requireTeamspaceForPages(userId, space, p.workspaceId);
  }
  // Templates stay where they are listed, and pages don't move into or out of a template.
  if ((p.parentId !== newParentId || changesSpace) && p.isTemplate) {
    throw withCode(new Error("Templates can't be moved"), "isTemplate");
  }
  if (parent) {
    if (parent.inTemplate !== p.inTemplate) {
      throw withCode(new Error("Pages can't be moved into or out of a template"), "isTemplate");
    }
    if (parent.workspaceId !== p.workspaceId) throw new AccessError("Cannot move across workspaces");
    if (parent.archivedAt) throw withCode(new AccessError("Parent page is in the trash"), "parentInTrash");
    if (parent.kind === "database" && p.kind === "database") throw new Error("A database cannot be a row");
    const cycle = await db.execute<{ hit: number }>(
      sql`select 1 as hit from ${subtreeIds(pageId)} s where s.id = ${newParentId}`,
    );
    if (cycle.length) throw new Error("Cannot move a page inside itself");
    // Under another parent the page and everything under it lie at new depths.
    if (p.parentId !== newParentId) await assertNestable(newParentId, await subtreeHeight(pageId));
  }
  if (!newParentId && p.inTemplate && !p.isTemplate) {
    throw withCode(new Error("Pages can't be moved into or out of a template"), "isTemplate");
  }
  const nextPos = position ?? (await nextPosition(p.workspaceId, newParentId));
  // A move to another place, not a new order among the same siblings; a row going from one database
  // to another stays content (see auditedAsPage).
  const moved = p.parentId !== newParentId || changesSpace;
  const audited =
    moved && !p.inTemplate && (parent?.kind !== "database" || (await auditedAsPage(p)))
      ? { from: await pagePlace(p.parentId, p.teamspaceId), to: await pagePlace(newParentId, space ?? null) }
      : null;
  await db.transaction(async (tx) => {
    if (newParentId && newParentId !== p.parentId) await lockLiveParent(tx, newParentId);
    // Under a parent the database copies its teamspace (and to everything below it).
    await tx
      .update(page)
      .set({ parentId: newParentId, position: nextPos, ...(newParentId ? {} : { teamspaceId: space }) })
      .where(eq(page.id, pageId));
    await followNewSpace(tx, p.workspaceId, pageId, userId, {
      changedSpace: changesSpace,
      toPrivate: space === null,
      privateTop: !newParentId && space === null && (changesSpace || p.parentId !== null),
    });
    // At the top of a teamspace whose members get less, whoever moved it there keeps running it.
    if (!newParentId && space !== null && (changesSpace || p.parentId !== null)) await keepFullAccess(tx, p.workspaceId, pageId, userId);
    if (audited) {
      await recordAudit(
        {
          workspaceId: p.workspaceId,
          actorId: userId,
          action: "page.moved",
          target: { type: "page", id: p.id, label: p.title },
          details: { kind: p.kind, ...audited },
        },
        tx,
      );
    }
  });
  getCollab().broadcast(`ws:${p.workspaceId}`, "tree");
  for (const id of [p.parentId, newParentId]) if (id) getCollab().broadcast(`db:${id}`, "rows");
  // Under another parent or in another space the page inherits other entries, which may give less.
  if (p.parentId !== newParentId || changesSpace) await getCollab().disconnectLostAccess(p.workspaceId);
  // Semantic search names the pages above in every chunk: the page and those under it are indexed again.
  if (p.parentId !== newParentId) pageChanged({ pageId, subtree: true });
  if (moved) await queuePageMoved(pageId, userId, { parentId: p.parentId, teamspaceId: p.teamspaceId });
}

export type SearchHit = {
  id: string;
  workspaceId: string;
  /** Null for private pages. */
  teamspaceId: string | null;
  parentId: string | null;
  kind: PageKind;
  title: string;
  icon: string | null;
  snippet: string;
  updatedAt: Date;
  /** "semantic": found by meaning only (its words don't match the query). */
  match?: "semantic";
  /** With semantic search: the passage that matched best, and the block it starts at. */
  passage?: string;
  blockId?: string | null;
  /** Full-text search found the page by the words of a document its body shows, not its own: that document (the snippet is from it). */
  file?: { id: string; name: string };
  /** The page is archived, itself or through a page above it; only searches that include archived pages find one. */
  outdated: boolean;
  /** Verified right now (server/verification): ranked above an otherwise equal page, and marked. */
  verified: boolean;
};

export type SearchOptions = SearchScope & {
  workspaceId?: string;
  limit?: number;
  /**
   * Full-text matches pages with any of the query's words (as prefixes, titles first) instead of
   * all of them: for the AI chat, which searches with whole questions.
   */
  anyWord?: boolean;
  /**
   * Text that must appear as written: its words whole and next to each other, in that order (the
   * query's "quoted phrases", lib/search-query). Their words are in the query too. With a phrase,
   * search by meaning only adds its passages to what full-text found, never pages of its own.
   */
  phrases?: string[];
};

/** Whether a search has a scope of its own, which lists pages even without words to search for. */
const scoped = ({ withinPageIds, kinds, verifiedOnly, teamspaceIds, createdBy, editedBy, createdIn, editedIn }: SearchScope) =>
  Boolean(
    withinPageIds?.length ||
      kinds?.length ||
      verifiedOnly ||
      teamspaceIds?.length ||
      createdBy?.length ||
      editedBy?.length ||
      createdIn?.from ||
      createdIn?.to ||
      editedIn?.from ||
      editedIn?.to,
  );

/**
 * Search across the user's workspaces (or one workspace): full-text search over titles and bodies,
 * merged with semantic search (reciprocal rank fusion) where the server has an embeddings model
 * and the workspace has AI on. Without one, exactly the full-text results. With a scope (pages to
 * look under, kinds of page, verified only) and no text, the pages in the scope, last edited first.
 */
export async function searchPages(userId: string, query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
  const q = query.trim();
  if (!q && !scoped(options)) return [];
  const limit = options.limit ?? 20;
  if (options.workspaceId) await enforceWorkspacePolicy(userId, options.workspaceId);
  const { phrases = [], ...scope } = options;
  const [text, meaning] = await Promise.all([
    fullTextSearch(userId, q, { ...options, limit }),
    semanticSearch(userId, q, { ...scope, limit }).catch((error) => {
      console.error("[search] semantic search failed", error);
      return [];
    }),
  ]);
  if (!meaning.length) return text;
  const byId = new Map<string, SearchHit>(text.map((h) => [h.id, h]));
  for (const m of meaning) {
    const found = byId.get(m.id);
    // A phrase must be on the page: meaning alone doesn't find one.
    if (phrases.length && !found) continue;
    const snippet = snippetOf(m.passage) || found?.snippet || "";
    byId.set(
      m.id,
      found
        ? { ...found, passage: m.passage, blockId: m.blockId }
        : {
            id: m.id,
            workspaceId: m.workspaceId,
            teamspaceId: m.teamspaceId,
            parentId: m.parentId,
            kind: m.kind,
            title: m.title,
            icon: m.icon,
            snippet,
            updatedAt: m.updatedAt,
            outdated: m.outdated,
            verified: m.verified,
            match: "semantic",
            passage: m.passage,
            blockId: m.blockId,
          },
    );
  }
  // Equal fused scores: a verified page first (sort is stable, so the fusion's order stays otherwise).
  return reciprocalRankFusion([text.map((h) => h.id), meaning.filter((m) => byId.has(m.id)).map((m) => m.id)])
    .map((r) => ({ ...r, verified: byId.get(r.id)!.verified }))
    .sort((a, b) => b.score - a.score || Number(b.verified) - Number(a.verified))
    .slice(0, limit)
    .map(({ id }) => byId.get(id)!);
}

/**
 * Title + body full-text search across the user's workspaces (or one workspace), best first and
 * newest first on ties. A page matches when it has every word of the query, each also as the start
 * of a longer word, so a search finds pages while the words are still being typed ("kond plan"
 * finds "Kondenser planı"). The match and the ranking read the page's stored search vector
 * (page.searchVector) through its index, and access is checked in rank order only until `limit`
 * pages pass, so a search costs about the same in a workspace of any size.
 *
 * A page is also found when a PDF, Word document or Excel workbook its body shows has every word (each document
 * on its own, not words spread over the page and its documents), below the pages that have them
 * in their own text; the hit then names the document and its snippet comes from it.
 */
export async function fullTextSearch(
  userId: string,
  query: string,
  { workspaceId, limit = 20, anyWord = false, phrases = [], ...scope }: SearchOptions = {},
): Promise<SearchHit[]> {
  const { includeOutdated = false } = scope;
  const q = query.trim();
  if (!q && !scoped(scope)) return [];
  // Without a letter or digit there are no words to look for ("---" finds nothing).
  if (q && !/[\p{L}\p{N}]/u.test(q)) return [];
  const terms = anyWord ? anyWordTerms(q) : [];
  if (anyWord && !terms.length) return [];
  if (workspaceId) await enforceWorkspacePolicy(userId, workspaceId);
  const workspaces = workspaceId ? [workspaceId] : await searchedWorkspaces(userId);
  if (!workspaces.length) return [];
  // Documents uploaded before their text was read for search, read in the background meanwhile.
  if (q) for (const id of workspaces) void sweepDocuments(id).catch((error) => console.error("[search] queuing documents failed", error));
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  // Every word as a prefix, cut by the parser that made the vectors ("e-posta" is the word and its
  // parts, as on the page), and Chinese and Japanese text by its two-character pieces
  // (searchQueryParts); null, matching nothing, when the query has no words at all. Words are
  // folded as the vectors' are (searchFoldSql), so "ışık" finds "IŞIK".
  const { words: rest, cjk } = searchQueryParts(q);
  const allOfParts = [
    ...(/[\p{L}\p{N}]/u.test(rest)
      ? [sql`nullif(regexp_replace(plainto_tsquery('simple', ${searchFoldSql(rest)})::text, '''( &|$)', ''':*\\1', 'g'), '')::tsquery`]
      : []),
    ...cjk.map((run) => sql`to_tsquery('simple', ${run})`),
    // A phrase: its words whole and in a row (the vectors keep where each word stands), its
    // Chinese and Japanese runs by their pieces as above, which already stand in a row. Places
    // count only up to the vector's 16,383rd, so a phrase far into a very long page may be missed.
    ...(anyWord ? [] : phrases).flatMap((phrase) => {
      const parts = searchQueryParts(phrase);
      return [
        ...(/[\p{L}\p{N}]/u.test(parts.words) ? [sql`phraseto_tsquery('simple', ${searchFoldSql(parts.words)})`] : []),
        ...parts.cjk.map((run) => sql`to_tsquery('simple', ${run})`),
      ];
    }),
  ];
  const allOf = allOfParts.length ? sql`(${sql.join(allOfParts, sql` && `)})` : sql`null::tsquery`;
  const words = anyWord ? sql`to_tsquery('simple', ${searchFoldSql(anyWordTsQuery(terms))})` : allOf;
  // Normalization 1 divides by the log of the page's length: long pages don't win on size alone.
  const rank = !q
    ? sql`0`
    : anyWord
    ? sql`ts_rank(p.search_vector, ${words}, 1)`
    : sql`(case when ${searchFoldSql(sql`p.title`)} like ${searchFoldSql(like)} then 2 else 0 end) + ts_rank(p.search_vector, ${words}, 1)`;
  const matches = q ? sql`p.search_vector @@ ${words}` : sql`true`;
  const inWorkspaces = sql.join(workspaces.map((w) => sql`${w}`), sql`, `);
  // Out of the trash and templates, and archived pages only when asked for (server/page-outdated.ts).
  const listed = listedPage(workspaces, { alias: "p", includeOutdated });
  // Pages whose body shows a PDF, Word document or Excel workbook with the words (file-text.ts), through a
  // reference its readers may read it by: the rule semantic search indexes documents by
  // (file-text.pageDocuments), so the document's words find nothing someone couldn't read there.
  // Its vector has no weight, so a page matching in its own text ranks above one matching only in
  // a document.
  const documentHits = q
    ? sql`
        union all
        select p.id, ts_rank(ft.search_vector, ${words}, 1) as rank, ft.file_id
        from ${fileText} ft
        join ${file} f on f.id = ft.file_id
        join ${fileReference} fr on fr.file_id = f.id and (fr.authorized or f.page_id = fr.page_id)
        join ${page} p on p.id = fr.page_id and p.workspace_id = f.workspace_id
        where f.workspace_id in (${inWorkspaces})
          and ft.search_vector @@ ${words}
          and ${listed}
          ${searchScope(scope, userId)}`
    : sql``;
  // Rows named by their ID ("TASK-12": a unique ID property's prefix and number, lib/unique-id),
  // above every match of words. The AI chat's questions are looked through for IDs.
  const ids = (anyWord ? q.split(/[\s,;:!?()"']+/) : [q])
    .map(uniqueIdQuery)
    .filter((id) => id !== null)
    .slice(0, 5);
  const idHits = ids.length
    ? sql`
        union all
        select p.id, 3::real as rank, null::text as file_id
        from ${databaseProperty} dp
        join ${page} p on p.parent_id = dp.database_id
        where dp.type = 'unique_id' and dp.deleted_at is null
          and (${sql.join(
            ids.map((id) => sql`(upper(dp.options -> 'uniqueId' ->> 'prefix') = ${id.prefix} and p.properties -> dp.id = ${String(id.number)}::jsonb)`),
            sql` or `,
          )})
          and p.workspace_id in (${inWorkspaces})
          and ${listed}
          ${searchScope(scope, userId)}`
    : sql``;
  const rows = await db.execute<{
    id: string;
    workspace_id: string;
    teamspace_id: string | null;
    parent_id: string | null;
    kind: PageKind;
    title: string;
    icon: string | null;
    content_text: string;
    updated_at: Date;
    file_id: string | null;
    file_name: string | null;
    file_text: string | null;
    outdated: boolean;
    verified: boolean;
  }>(sql`
    with candidates as (
      select p.id, ${rank} as rank, null::text as file_id
      from ${page} p
      where p.workspace_id in (${inWorkspaces})
        and ${listed}
        ${searchScope(scope, userId)}
        and ${matches}
      ${documentHits}
      ${idHits}
    ),
    scored as (
      -- A page's own match plus its best document's; the document is named only when the page's
      -- own text doesn't match.
      select id,
        coalesce(max(rank) filter (where file_id is null), 0) + coalesce(max(rank) filter (where file_id is not null), 0) as rank,
        case when bool_or(file_id is null) then null
          else (array_agg(file_id order by rank desc, file_id) filter (where file_id is not null))[1] end as file_id
      from candidates
      group by id
    ),
    hits as (
      -- Ranked first, then checked in that order until enough pass: the check is a function call
      -- per page, which a common word (or the first letters of one) would make for most pages.
      -- "offset 0" keeps the check out of the ranked set, and the ranked set in its order.
      -- A verified page goes above an otherwise equal one (server/verification).
      select r.id, r.rank, r.verified, r.updated_at, r.file_id from (
        select s.id, s.rank, ${activeVerification("p")} as verified, p.updated_at, s.file_id
        from scored s
        join ${page} p on p.id = s.id
        order by s.rank desc, verified desc, p.updated_at desc
        offset 0
      ) r
      where ${pageVisibleTo(userId, "r")}
      limit ${limit}
    )
    select p.id, p.workspace_id, p.teamspace_id,
      -- A parent they can't see isn't named, not even by id.
      case when p.parent_id is not null and ${pageVisibleTo(userId, "parent")} then p.parent_id end as parent_id,
      p.kind, p.title, p.icon, p.content_text, p.updated_at,
      h.file_id, f.name as file_name, left(ft.text, 80000) as file_text,
      ${includeOutdated ? isOutdated(workspaces, "p") : sql`false`} as outdated,
      h.verified
    from hits h
    join ${page} p on p.id = h.id
    left join ${page} parent on parent.id = p.parent_id
    left join ${file} f on f.id = h.file_id
    left join ${fileText} ft on ft.file_id = h.file_id
    order by h.rank desc, h.verified desc, h.updated_at desc
  `);
  const needles = anyWord ? terms : [...phrases, q, ...q.split(/\s+/)];
  return rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspace_id,
    teamspaceId: r.teamspace_id,
    parentId: r.parent_id,
    kind: r.kind,
    title: r.title,
    icon: r.icon,
    snippet: makeSnippet(r.file_id ? (r.file_text ?? "") : r.content_text, needles),
    updatedAt: new Date(r.updated_at),
    outdated: Boolean(r.outdated),
    verified: Boolean(r.verified),
    ...(r.file_id ? { file: { id: r.file_id, name: r.file_name ?? "" } } : {}),
  }));
}

/** The workspaces a search over all of the user's looks in: theirs, less those their sign-in doesn't open now. */
async function searchedWorkspaces(userId: string): Promise<string[]> {
  const ids = (await listWorkspaces(userId)).map((w) => w.id);
  const held = await workspacesHeldBack(userId, ids);
  return ids.filter((id) => !held.has(id));
}

/**
 * Lower-cased with the dotted and dotless i alike, as the search vectors are, one character for
 * one: "İ" is mapped before lowering, which would make it two.
 */
const snippetFold = (text: string) => text.replace(/[Iİı]/g, "i").toLowerCase();

/** The text around the first of `needles` it contains, or its start. */
function makeSnippet(text: string, needles: string[]) {
  const lower = snippetFold(text);
  let i = -1;
  let length = 0;
  for (const needle of needles) {
    const at = lower.indexOf(snippetFold(needle));
    if (at !== -1 && (i === -1 || at < i)) [i, length] = [at, needle.length];
  }
  if (i === -1) return text.slice(0, 140);
  const start = Math.max(0, i - 50);
  return (start ? "…" : "") + text.slice(start, i + length + 90).replace(/\s+/g, " ");
}

/**
 * Pages directly under `parentId`, or the user's top-level pages: those without a parent and those
 * shared with them whose parent (other than a database) they can't see.
 */
export async function listChildren(
  userId: string,
  workspaceId: string,
  parentId: string | null,
  /**
   * `teamspaceId`, top level only: just this teamspace's pages (null: private pages outside any
   * teamspace). `includeOutdated`: archived pages too (server/page-outdated.ts); under a parent
   * that is archived itself its pages are listed either way.
   */
  { teamspaceId, includeOutdated = false }: { teamspaceId?: string | null; includeOutdated?: boolean } = {},
) {
  await requireMembership(userId, workspaceId);
  if (parentId) await requirePageAccess(userId, parentId, "view");
  const parent = alias(page, "parent");
  const topLevel = or(
    isNull(page.parentId),
    and(sql`${parent.kind} <> 'database'`, sql`${accessRank(userId, sql`${parent.id}`)} = 0`),
  );
  return db
    .select({
      id: page.id,
      kind: page.kind,
      title: page.title,
      icon: page.icon,
      teamspaceId: page.teamspaceId,
      updatedAt: page.updatedAt,
      // Archived itself, or (at the top level) through a page above it the user can't see.
      outdated: parentId ? sql<boolean>`${page.outdatedAt} is not null` : isOutdated(workspaceId),
    })
    .from(page)
    .leftJoin(parent, eq(parent.id, page.parentId))
    .where(
      and(
        eq(page.workspaceId, workspaceId),
        parentId ? eq(page.parentId, parentId) : and(topLevel, eq(page.inTemplate, false)),
        !parentId && teamspaceId !== undefined
          ? teamspaceId === null
            ? isNull(page.teamspaceId)
            : eq(page.teamspaceId, teamspaceId)
          : undefined,
        // Templates are listed by list_templates, not as pages.
        eq(page.isTemplate, false),
        isNull(page.archivedAt),
        // Under a parent the pages it has are archived when they are themselves or it is.
        includeOutdated ? undefined : parentId ? isNull(page.outdatedAt) : sql`${page.id} not in ${outdatedIds(workspaceId)}`,
        pageVisibleTo(userId),
      ),
    )
    .orderBy(asc(page.position));
}

export async function listSnapshots(userId: string, pageId: string) {
  await requirePageAccess(userId, pageId, "view");
  return db
    .select({
      id: pageSnapshot.id,
      title: pageSnapshot.title,
      reason: pageSnapshot.reason,
      createdAt: pageSnapshot.createdAt,
      authorName: user.name,
      clientName: oauthClient.name,
      /** The author is an agent (see server/agents); its icon, an emoji, when it has one. */
      authorIsAgent: sql<boolean>`${workspaceAgent.id} is not null`,
      authorAgentIcon: workspaceAgent.icon,
    })
    .from(pageSnapshot)
    .leftJoin(user, eq(user.id, pageSnapshot.createdBy))
    .leftJoin(workspaceAgent, eq(workspaceAgent.userId, pageSnapshot.createdBy))
    .leftJoin(oauthClient, eq(oauthClient.clientId, pageSnapshot.oauthClientId))
    .where(eq(pageSnapshot.pageId, pageId))
    .orderBy(desc(pageSnapshot.createdAt))
    .limit(100);
}

export async function getSnapshot(userId: string, snapshotId: string) {
  const [snap] = await db
    .select({
      id: pageSnapshot.id,
      pageId: pageSnapshot.pageId,
      title: pageSnapshot.title,
      contentMarkdown: pageSnapshot.contentMarkdown,
      createdAt: pageSnapshot.createdAt,
    })
    .from(pageSnapshot)
    .where(eq(pageSnapshot.id, snapshotId));
  if (!snap) throw new AccessError();
  await requirePageAccess(userId, snap.pageId, "view");
  return snap;
}

export async function restoreSnapshot(actor: WriteActor, snapshotId: string) {
  const snap = await getSnapshot(actor.userId, snapshotId);
  assertChangeable(await requirePageAccess(actor.userId, snap.pageId, "edit"));
  await getCollab().restoreSnapshot(snapshotId, actor);
  return snap.pageId;
}

/**
 * The search box's query (see lib/search-query): its text, in the pages its `in:` filters name
 * (none of them found: no results) and of the kinds its `type:` filters name.
 */
export async function searchWithQuery(
  userId: string,
  workspaceId: string,
  query: string,
  limit = 20,
  /**
   * Archived pages too (server/page-outdated.ts): the search box's "Include archived". `filters`:
   * its teamspace, people and date filters, a date counted in days of `timeZone`.
   */
  {
    includeOutdated = false,
    filters = NO_SEARCH_FILTERS,
    timeZone = "UTC",
    now = new Date(),
  }: { includeOutdated?: boolean; filters?: SearchFilters; timeZone?: string; now?: Date } = {},
): Promise<SearchHit[]> {
  const { text, within, kinds, verified, phrases } = parseSearchQuery(query);
  const withinPageIds = within.length ? await pagesTitled(userId, workspaceId, within, 20, { includeOutdated }) : undefined;
  if (withinPageIds && !withinPageIds.length) return [];
  const { teamspaceIds, createdBy, editedBy, date } = filters;
  const range = date ? searchDateRange(date, now, timeZone) : undefined;
  return searchPages(userId, text, {
    workspaceId,
    limit,
    withinPageIds,
    kinds,
    includeOutdated,
    verifiedOnly: verified,
    phrases,
    teamspaceIds,
    createdBy,
    editedBy,
    ...(date?.field === "created" ? { createdIn: range } : date?.field === "edited" ? { editedIn: range } : {}),
  });
}

/**
 * Ids of the pages of a workspace the user can see that have one of `titles` (compared as
 * lib/search-fold does, without surrounding space), last edited first: what a search's `in:`
 * filters name.
 */
export async function pagesTitled(
  userId: string,
  workspaceId: string,
  titles: string[],
  limit = 20,
  { includeOutdated = false }: { includeOutdated?: boolean } = {},
): Promise<string[]> {
  const wanted = [...new Set(titles.map((t) => searchFold(t.normalize("NFC").trim())).filter(Boolean))];
  if (!wanted.length) return [];
  await enforceWorkspacePolicy(userId, workspaceId);
  const rows = await db
    .select({ id: page.id })
    .from(page)
    .where(
      and(
        eq(page.workspaceId, workspaceId),
        listedPage(workspaceId, { includeOutdated }),
        pageVisibleTo(userId),
        sql`${searchFoldSql(sql`trim(normalize(${page.title}, NFC))`)} in (${sql.join(wanted.map((t) => sql`${t}`), sql`, `)})`,
      ),
    )
    .orderBy(desc(page.updatedAt))
    .limit(limit);
  return rows.map((r) => r.id);
}

/**
 * Where each page sits, for lists of pages from all over a workspace: the title of its parent (a
 * row's database, a subpage's page), by page id. Top-level pages and parents the viewer can't open
 * are left out, so a page shared on its own doesn't give its parent's name away.
 */
export async function parentTitles(userId: string, pageIds: string[]): Promise<Map<string, string>> {
  if (pageIds.length === 0) return new Map();
  const parent = alias(page, "parent");
  const rows = await db
    .select({ id: page.id, title: parent.title })
    .from(page)
    .innerJoin(parent, eq(parent.id, page.parentId))
    .where(and(inArray(page.id, pageIds), isNull(parent.archivedAt), pageVisibleTo(userId, "parent")));
  return new Map(rows.map((row) => [row.id, row.title]));
}

/** A page of a recent list: the pages last edited, or (page-views.ts) last opened, with when. */
export type RecentPage = { id: string; title: string; icon: string | null; kind: PageKind; updatedAt: Date; viewedAt?: Date };

export async function recentPages(userId: string, workspaceId: string, limit = 8): Promise<RecentPage[]> {
  await requireMembership(userId, workspaceId);
  // Archived pages too stay out (server/page-outdated.ts).
  const live = and(eq(page.workspaceId, workspaceId), listedPage(workspaceId));
  const columns = { id: page.id, title: page.title, icon: page.icon, kind: page.kind, updatedAt: page.updatedAt };
  // Access is asked of the latest pages, newest first, until enough are found: asked of every page
  // in the workspace before sorting, it took seconds in a large one. When too few of the latest are
  // visible, every page is asked.
  const latest = db
    .select(columns)
    .from(page)
    .where(live)
    .orderBy(desc(page.updatedAt))
    .limit(Math.max(200, limit * 20))
    .as("latest");
  const found = await db
    .select({ id: latest.id, title: latest.title, icon: latest.icon, kind: latest.kind, updatedAt: latest.updatedAt })
    .from(latest)
    .where(pageVisibleTo(userId, "latest"))
    .orderBy(desc(latest.updatedAt))
    .limit(limit);
  if (found.length === limit) return found;
  return db.select(columns).from(page).where(and(live, pageVisibleTo(userId))).orderBy(desc(page.updatedAt)).limit(limit);
}


import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { fileIdOf } from "@/lib/files";
import { parsePageCover, type PageCover } from "@/lib/page-cover";
import { makeStatusOptions } from "@/lib/properties";
import { trashDeletionDate } from "@/lib/retention";
import { anyWordTerms, anyWordTsQuery } from "@/lib/search-words";
import {
  databaseProperty,
  databaseView,
  file,
  oauthClient,
  page,
  pagePermission,
  pageSnapshot,
  type PageKind,
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
import { getCollab, type WriteActor } from "@/server/collab/bridge";
import {
  afterRowWrites,
  bulkRowIds,
  normalizeRowProperties,
  rowsWithAccess,
  syncPairedRelations,
  withCode,
  type BulkResult,
} from "@/server/databases";
import { PAGE_HEADER_EVENT } from "@/lib/collab-constants";
import { pageChanged } from "@/server/page-events";
import { inSubtree, semanticSearch } from "@/server/semantic-search";
import { reciprocalRankFusion, snippetOf } from "@/server/semantic-text";
import { followNewSpace, freezeInheritedEntries, keepFullAccess, makePagePrivate } from "@/server/permissions";
import { placeTopLevel, requireTeamspaceForPages, sidebarTeamspaces, type TeamspaceSummary } from "@/server/teamspaces";
import { requireTopLevel, workspaceSettings } from "@/server/workspaces";

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
 * database) and templates (listed by the template picker), each in its section:
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
        and p.archived_at is null
        and not p.in_template
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
    .where(and(eq(page.workspaceId, workspaceId), isNull(page.archivedAt), pageVisibleTo(userId)))
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

/** The sidebar: its page tree and the teamspaces it has a section for. */
export async function getSidebar(
  userId: string,
  workspaceId: string,
): Promise<{ tree: TreeNode[]; teamspaces: TeamspaceSummary[] }> {
  const [tree, teamspaces] = await Promise.all([getTree(userId, workspaceId), sidebarTeamspaces(userId, workspaceId)]);
  return { tree, teamspaces };
}

export async function getPage(userId: string, pageId: string) {
  return requirePageAccess(userId, pageId, "view");
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

/** Used when no language is known, e.g. databases created by MCP clients. */
export const ENGLISH_SEED_NAMES: DatabaseSeedNames = {
  status: "Status",
  notStarted: "Not started",
  inProgress: "In progress",
  done: "Done",
  tags: "Tags",
  table: "Table",
};

export async function createPage(actor: WriteActor, input: CreatePageInput) {
  const { userId } = actor;
  const kind = input.kind ?? "page";
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
        await normalizeRowProperties(userId, input.parentId!, input.properties, {}, { createdBy: userId })
      : {};

  const position = await nextPosition(workspaceId, input.parentId ?? null);
  const created = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(page)
      .values({
        workspaceId,
        parentId: input.parentId ?? null,
        kind,
        title: input.title?.trim() ?? "",
        icon: input.icon ?? null,
        properties,
        position,
        isTemplate,
        inTemplate,
        teamspaceId: placement.teamspaceId,
        createdBy: userId,
        updatedBy: userId,
      })
      .returning();
    if (placement.private) await makePagePrivate(tx, workspaceId, row.id, userId);
    else if (!input.parentId && placement.teamspaceId) await keepFullAccess(tx, workspaceId, row.id, userId);
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
  }

  const collab = getCollab();
  if (input.markdown?.trim()) await collab.replaceContent(created.id, input.markdown, actor);
  pageChanged({ pageId: created.id });
  collab.broadcast(`ws:${workspaceId}`, "tree");
  if (parentKind === "database") collab.broadcast(`db:${input.parentId}`, "rows");
  return created;
}

export async function renamePage(actor: WriteActor, pageId: string, title: string) {
  await requirePageAccess(actor.userId, pageId, "edit");
  // Title lives in the shared doc so open editors update live; the store hook persists it.
  await getCollab().setTitle(pageId, title.trim(), actor);
}

export async function setPageIcon(userId: string, pageId: string, icon: string | null) {
  const p = await requirePageAccess(userId, pageId, "edit");
  await db.update(page).set({ icon, updatedBy: userId }).where(eq(page.id, pageId));
  pageHeaderChanged(p);
}

/**
 * The icon or cover changed: the sidebar and database views show the icon, gallery cards may show
 * the cover, and the page itself shows both to everyone who has it open (PAGE_HEADER_EVENT).
 */
function pageHeaderChanged(p: { id: string; workspaceId: string; parentId: string | null }) {
  const collab = getCollab();
  collab.broadcast(`ws:${p.workspaceId}`, "tree");
  if (p.parentId) collab.broadcast(`db:${p.parentId}`, "rows");
  collab.broadcast(`page:${p.id}`, PAGE_HEADER_EVENT);
}

/**
 * Sets or removes the page's cover (lib/page-cover). An uploaded image must be a file of the page's
 * workspace; the database trigger then counts it as used by the page, like a file in its body.
 */
export async function setPageCover(userId: string, pageId: string, cover: PageCover | null) {
  const p = await requirePageAccess(userId, pageId, "edit");
  const checked = cover === null ? null : parsePageCover(cover);
  if (cover !== null && !checked) throw new Error("Not a cover");
  const fileId = checked?.kind === "image" ? fileIdOf(checked.url) : null;
  if (fileId) {
    const [found] = await db
      .select({ id: file.id })
      .from(file)
      .where(and(eq(file.id, fileId), eq(file.workspaceId, p.workspaceId)))
      .limit(1);
    // Answered like any file the user can't reach (REST: 404).
    if (!found) throw new AccessError("The cover's file isn't in this workspace");
  }
  await db.update(page).set({ cover: checked, updatedBy: userId }).where(eq(page.id, pageId));
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
  await db
    .update(page)
    .set({ archivedAt: new Date(), updatedBy: userId })
    .where(and(sql`${page.id} in ${subtreeIds(pageId)}`, isNull(page.archivedAt)));
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
  await db
    .update(page)
    .set({ archivedAt: new Date(), updatedBy: userId })
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
    );
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
  await db
    .update(page)
    .set({ archivedAt: null })
    .where(
      and(
        sql`${page.id} in ${subtreeIds(pageId)}`,
        sql`${page.archivedAt} = (select root.archived_at from ${page} root where root.id = ${pageId})`,
      ),
    );
  if (parentId !== p.parentId) {
    // Lifted to the top of its teamspace (or of the private pages): it keeps the access it had
    // from its old ancestors rather than opening up to everyone there, or to nobody.
    await db.transaction(async (tx) => {
      await freezeInheritedEntries(tx, p.workspaceId, pageId);
      await tx.update(page).set({ parentId }).where(eq(page.id, pageId));
    });
  }
  // Back in search; the index catches up if it was left behind meanwhile.
  pageChanged({ pageId });
  getCollab().broadcast(`ws:${p.workspaceId}`, "tree");
  if (parentId) getCollab().broadcast(`db:${parentId}`, "rows");
}

export async function deletePagePermanently(userId: string, pageId: string) {
  const p = await requirePageAccess(userId, pageId, "full");
  if (!p.archivedAt) throw new Error("Move the page to the trash before deleting it");
  await deleteTrashedPages(p.workspaceId, [pageId], userId);
}

/**
 * Deletes pages of the trash for good, with their subpages (and their history, comments and so on,
 * which go with the page), then the uploads no other page shows. Pages taken out of the trash in
 * the meantime are left alone. Returns the ids deleted. No access check: deletePagePermanently
 * checks the person, the retention cleanup (server/retention.ts) acts for the workspace.
 *
 * Each page deleted is recorded in the audit log, as `actorId`'s doing or, for null, the server's.
 */
export async function deleteTrashedPages(workspaceId: string, pageIds: string[], actorId: string | null = null) {
  if (!pageIds.length) return [];
  const deleted = await db
    .delete(page)
    .where(and(eq(page.workspaceId, workspaceId), inArray(page.id, pageIds), isNotNull(page.archivedAt)))
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
  }>(sql`
    with ranked as materialized (
      select p.id, p.title, p.icon, p.kind, p.archived_at, ${accessRank(userId, pageIdColumn("p"))} as level
      from ${page} p
      left join ${page} parent on parent.id = p.parent_id
      where p.workspace_id = ${workspaceId}
        and p.archived_at is not null
        and not p.is_template
        and (parent.id is null or parent.archived_at is null or parent.archived_at <> p.archived_at)
    )
    select id, title, icon, kind, archived_at, level
    from ranked
    where level > 0
    order by archived_at desc
    limit 100
  `);
  return rows.map(({ level, ...r }) => ({
    ...r,
    level: levelFromRank(level),
    deletesAt: trashDeletionDate(new Date(r.archived_at), trashRetentionDays),
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
    if (parent.kind === "database" && p.kind === "database") throw new Error("A database cannot be a row");
    const cycle = await db.execute<{ hit: number }>(
      sql`select 1 as hit from ${subtreeIds(pageId)} s where s.id = ${newParentId}`,
    );
    if (cycle.length) throw new Error("Cannot move a page inside itself");
  }
  if (!newParentId && p.inTemplate && !p.isTemplate) {
    throw withCode(new Error("Pages can't be moved into or out of a template"), "isTemplate");
  }
  const nextPos = position ?? (await nextPosition(p.workspaceId, newParentId));
  await db.transaction(async (tx) => {
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
  });
  getCollab().broadcast(`ws:${p.workspaceId}`, "tree");
  for (const id of [p.parentId, newParentId]) if (id) getCollab().broadcast(`db:${id}`, "rows");
  // Under another parent or in another space the page inherits other entries, which may give less.
  if (p.parentId !== newParentId || changesSpace) await getCollab().disconnectLostAccess(p.workspaceId);
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
};

export type SearchOptions = {
  workspaceId?: string;
  limit?: number;
  /** Only this page and the pages under it. */
  withinPageId?: string;
  /**
   * Full-text matches pages with any of the query's words (as prefixes, titles first) instead of
   * all of them: for the AI chat, which searches with whole questions.
   */
  anyWord?: boolean;
};

/**
 * Search across the user's workspaces (or one workspace): full-text search over titles and bodies,
 * merged with semantic search (reciprocal rank fusion) where the server has an embeddings model
 * and the workspace has AI on. Without one, exactly the full-text results.
 */
export async function searchPages(userId: string, query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
  const q = query.trim();
  if (!q) return [];
  const limit = options.limit ?? 20;
  if (options.workspaceId) await enforceWorkspacePolicy(userId, options.workspaceId);
  const [text, meaning] = await Promise.all([
    fullTextSearch(userId, q, { ...options, limit }),
    semanticSearch(userId, q, { ...options, limit }).catch((error) => {
      console.error("[search] semantic search failed", error);
      return [];
    }),
  ]);
  if (!meaning.length) return text;
  const byId = new Map<string, SearchHit>(text.map((h) => [h.id, h]));
  for (const m of meaning) {
    const found = byId.get(m.id);
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
            match: "semantic",
            passage: m.passage,
            blockId: m.blockId,
          },
    );
  }
  return reciprocalRankFusion([text.map((h) => h.id), meaning.map((m) => m.id)])
    .slice(0, limit)
    .map(({ id }) => byId.get(id)!);
}

/** Title + body full-text search across the user's workspaces (or one workspace), newest first on ties. */
export async function fullTextSearch(
  userId: string,
  query: string,
  { workspaceId, limit = 20, withinPageId, anyWord = false }: SearchOptions = {},
): Promise<SearchHit[]> {
  const q = query.trim();
  if (!q) return [];
  const terms = anyWord ? anyWordTerms(q) : [];
  if (anyWord && !terms.length) return [];
  if (workspaceId) await enforceWorkspacePolicy(userId, workspaceId);
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const words = sql`setweight(to_tsvector('simple', coalesce(p.title, '')), 'A') || setweight(to_tsvector('simple', coalesce(p.content_text, '')), 'B')`;
  const anyOf = sql`to_tsquery('simple', ${anyWordTsQuery(terms)})`;
  const rank = anyWord
    ? sql`ts_rank(${words}, ${anyOf})`
    : sql`(case when p.title ilike ${like} then 2 else 0 end)
      + ts_rank(to_tsvector('simple', coalesce(p.title, '') || ' ' || coalesce(p.content_text, '')),
                plainto_tsquery('simple', ${q}))`;
  const matches = anyWord
    ? sql`${words} @@ ${anyOf}`
    : sql`(
        p.title ilike ${like} or p.content_text ilike ${like}
        or to_tsvector('simple', coalesce(p.title, '') || ' ' || coalesce(p.content_text, ''))
           @@ plainto_tsquery('simple', ${q})
      )`;
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
    rank: number;
  }>(sql`
    select p.id, p.workspace_id, p.teamspace_id,
      -- A parent they can't see isn't named, not even by id.
      case when p.parent_id is not null and ${pageVisibleTo(userId, "parent")} then p.parent_id end as parent_id,
      p.kind, p.title, p.icon, p.content_text, p.updated_at,
      ${rank} as rank
    from ${page} p
    left join ${page} parent on parent.id = p.parent_id
    where p.archived_at is null
      and not p.in_template
      and ${pageVisibleTo(userId, "p")}
      ${workspaceId ? sql`and p.workspace_id = ${workspaceId}` : sql``}
      ${withinPageId ? sql`and ${inSubtree(withinPageId)}` : sql``}
      and ${matches}
    order by rank desc, p.updated_at desc
    limit ${limit}
  `);
  const heldBack = workspaceId ? new Set<string>() : await workspacesHeldBack(userId, rows.map((r) => r.workspace_id));
  return rows.filter((r) => !heldBack.has(r.workspace_id)).map((r) => ({
    id: r.id,
    workspaceId: r.workspace_id,
    teamspaceId: r.teamspace_id,
    parentId: r.parent_id,
    kind: r.kind,
    title: r.title,
    icon: r.icon,
    snippet: makeSnippet(r.content_text, anyWord ? terms : [q]),
    updatedAt: new Date(r.updated_at),
  }));
}

/** The text around the first of `needles` it contains, or its start. */
function makeSnippet(text: string, needles: string[]) {
  const lower = text.toLowerCase();
  let i = -1;
  let length = 0;
  for (const needle of needles) {
    const at = lower.indexOf(needle.toLowerCase());
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
  /** Top level only: just this teamspace's pages (null: private pages outside any teamspace). */
  { teamspaceId }: { teamspaceId?: string | null } = {},
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
  await requirePageAccess(actor.userId, snap.pageId, "edit");
  await getCollab().restoreSnapshot(snapshotId, actor);
  return snap.pageId;
}

export async function recentPages(userId: string, workspaceId: string, limit = 8) {
  await requireMembership(userId, workspaceId);
  return db
    .select({ id: page.id, title: page.title, icon: page.icon, kind: page.kind, updatedAt: page.updatedAt })
    .from(page)
    .where(and(eq(page.workspaceId, workspaceId), isNull(page.archivedAt), eq(page.inTemplate, false), pageVisibleTo(userId)))
    .orderBy(desc(page.updatedAt))
    .limit(limit);
}


/**
 * Archived pages: out of date but kept (an old price list, a superseded offer). Not the trash: in
 * code `page.archivedAt` is the trash, and this state is `page.outdatedAt` (the app calls it
 * "Archive"). It is set on the page archived only, with who did it; the pages under it count as
 * archived too, database rows with their database, and come back with it when it is unarchived.
 *
 * An archived page stays what it was otherwise: readable and editable by whoever could, reachable
 * by its link, mentions and backlinks, published if it was, and it goes to the trash and back
 * archived. It leaves what lists pages to find one: the sidebar, search (unless asked for), the
 * mention and link pickers, recent pages, database views (rows archived one by one, unless the view
 * shows them) and what the AI chat, agents, MCP clients and the REST API search and list.
 *
 * Which pages are archived is worked out when asked, never stored on each page: lists walk down
 * from the few archived pages of their workspaces (`outdatedIds`), and a single page walks up its
 * ancestors (`outdatedState`). Moving a page into or out of an archived page, or restoring it from
 * the trash elsewhere, needs nothing more.
 */
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { page, user } from "@/db/schema";
import { PAGE_HEADER_EVENT } from "@/lib/collab-constants";
import { accessRank, FULL_RANK, pageIdColumn, requirePageAccess } from "@/server/access";
import { getCollab } from "@/server/collab/bridge";

/** Why archiving or unarchiving was refused; translated in the app (`page.outdated.errors`). */
export type OutdatedErrorCode = "template" | "inTrash";

export class OutdatedError extends Error {
  constructor(
    readonly code: OutdatedErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OutdatedError";
  }
}

function columnOf(alias: string | undefined, name: "archived_at" | "in_template") {
  if (alias === undefined) return name === "archived_at" ? sql`${page.archivedAt}` : sql`${page.inTemplate}`;
  pageIdColumn(alias); // Checks the alias.
  return sql.raw(`"${alias}"."${name}"`);
}

/**
 * SQL: the ids of the archived pages of `workspaceIds` and of every page under one (database rows
 * included), as a subquery. Starts from the archived pages themselves (page_outdated_idx), so it
 * costs next to nothing while a workspace archives few pages.
 */
export function outdatedIds(workspaceIds: string | readonly string[]): SQL {
  const ids = typeof workspaceIds === "string" ? [workspaceIds] : workspaceIds;
  if (!ids.length) return sql`(select null::text where false)`;
  return sql`(
    with recursive outdated as (
      select o.id, o.workspace_id from ${page} o
      where o.workspace_id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)}) and o.outdated_at is not null
      union
      select c.id, c.workspace_id from ${page} c
      join outdated on c.workspace_id = outdated.workspace_id and c.parent_id = outdated.id
    ) select id from outdated
  )`;
}

/** SQL condition: the page (of `alias`, or the page table) is archived, itself or through a page above it. */
export function isOutdated(workspaceIds: string | readonly string[], alias?: string): SQL<boolean> {
  return sql<boolean>`${pageIdColumn(alias)} in ${outdatedIds(workspaceIds)}`;
}

/**
 * SQL condition for what lists pages to find one (the sidebar, search, pickers, recent pages): the
 * page is out of the trash, no template or part of one, and not archived, itself or through a page
 * above it, unless `includeOutdated`. Pass the alias when the page table is aliased in a raw query.
 */
export function listedPage(
  workspaceIds: string | readonly string[],
  { alias, includeOutdated = false }: { alias?: string; includeOutdated?: boolean } = {},
): SQL {
  const live = sql`${columnOf(alias, "archived_at")} is null and not ${columnOf(alias, "in_template")}`;
  return includeOutdated ? sql`(${live})` : sql`(${live} and ${pageIdColumn(alias)} not in ${outdatedIds(workspaceIds)})`;
}

/** Why a page counts as archived: the page archived (itself or the nearest above it), who did it and when. */
export type OutdatedState = {
  /** The page archived: the page itself (`own`) or the nearest page above it that is. */
  pageId: string;
  own: boolean;
  /** That page's title, or null when it is above the page and the user can't open it. */
  title: string | null;
  at: Date;
  /** Who archived it; null when their account is gone. */
  by: string | null;
  /** The user may unarchive it (full access to that page). */
  canUnarchive: boolean;
};

/**
 * Whether the page counts as archived for `userId`, and why: null when neither it nor a page above
 * it is archived. The caller has checked the user can see the page.
 */
export async function outdatedState(userId: string, pageId: string): Promise<OutdatedState | null> {
  const [row] = await db.execute<{ id: string; depth: number; title: string; outdated_at: Date; by: string | null; level: number }>(sql`
    with recursive chain as (
      select id, parent_id, title, outdated_at, outdated_by, 0 as depth from ${page} where id = ${pageId}
      union all
      select p.id, p.parent_id, p.title, p.outdated_at, p.outdated_by, chain.depth + 1
      from ${page} p join chain on p.id = chain.parent_id
      where chain.outdated_at is null and chain.depth < 64
    )
    select chain.id, chain.depth, chain.title, chain.outdated_at, u.name as by, ${accessRank(userId, sql`chain.id`)} as level
    from chain left join ${user} u on u.id = chain.outdated_by
    where chain.outdated_at is not null
    order by chain.depth
    limit 1
  `);
  if (!row) return null;
  return {
    pageId: row.id,
    own: Number(row.depth) === 0,
    title: Number(row.depth) === 0 || Number(row.level) > 0 ? row.title : null,
    at: new Date(row.outdated_at),
    by: row.by,
    canUnarchive: Number(row.level) === FULL_RANK,
  };
}

/**
 * Archives a page, or unarchives it: the pages under it follow (see the top of this file). Needs
 * full access to the page, like moving it elsewhere; templates and the pages in them stay as they
 * are, and a page in the trash is restored first. Unarchiving a page that isn't archived itself does
 * nothing: one archived through a page above it comes back with that page. Archiving isn't an edit:
 * the page's "edited" time and author stay.
 */
export async function setPageOutdated(userId: string, pageId: string, outdated: boolean) {
  const found = await requirePageAccess(userId, pageId, "full");
  if (found.isTemplate || found.inTemplate) throw new OutdatedError("template", "Templates and the pages in them can't be archived");
  if (found.archivedAt) throw new OutdatedError("inTrash", "Restore the page from the trash first");
  if (outdated === Boolean(found.outdatedAt)) return found;
  // Raw SQL: the schema's update() would stamp updated_at.
  await db.execute(
    outdated
      ? sql`update ${page} set outdated_at = now(), outdated_by = ${userId} where id = ${pageId} and outdated_at is null`
      : sql`update ${page} set outdated_at = null, outdated_by = null where id = ${pageId}`,
  );
  const collab = getCollab();
  collab.broadcast(`ws:${found.workspaceId}`, "tree");
  if (found.parentId) collab.broadcast(`db:${found.parentId}`, "rows");
  // Its open tabs show the banner, or stop showing it; the pages under it show theirs when opened.
  collab.broadcast(`page:${pageId}`, PAGE_HEADER_EVENT);
  return found;
}


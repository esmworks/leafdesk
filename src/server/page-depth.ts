import { sql } from "drizzle-orm";
import { db } from "@/db";
import { page } from "@/db/schema";
import { MAX_PAGE_DEPTH, pageTooDeepError } from "@/lib/page-depth";

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * How deep `pageId` lies (0 at the top level), as far as MAX_PAGE_DEPTH + 1: a page the walk can't
 * follow to the top level within that many steps counts as deeper than allowed.
 */
export async function pageDepth(pageId: string, exec: Executor = db): Promise<number> {
  const [row] = await exec.execute<{ depth: number | null }>(sql`
    with recursive up as (
      select id, parent_id, 0 as depth from ${page} where id = ${pageId}
      union all
      select p.id, p.parent_id, up.depth + 1 from ${page} p join up on p.id = up.parent_id
      where up.depth <= ${MAX_PAGE_DEPTH}
    )
    select max(depth) filter (where parent_id is null) as depth from up
  `);
  return row?.depth === null || row?.depth === undefined ? MAX_PAGE_DEPTH + 1 : Number(row.depth);
}

/** How many levels go down from `pageId` (0 without subpages), trashed ones too, as far as MAX_PAGE_DEPTH + 1. */
export async function subtreeHeight(pageId: string, exec: Executor = db): Promise<number> {
  const [row] = await exec.execute<{ height: number | null }>(sql`
    with recursive sub as (
      select id, 0 as depth from ${page} where id = ${pageId}
      union all
      select p.id, sub.depth + 1 from ${page} p join sub on p.parent_id = sub.id
      where sub.depth <= ${MAX_PAGE_DEPTH}
    )
    select max(depth) as height from sub
  `);
  return Number(row?.height ?? 0);
}

/**
 * Refuses to put a tree `height` levels high under `parentId` (null: at the top level) when its
 * deepest page would lie deeper than MAX_PAGE_DEPTH.
 */
export async function assertNestable(parentId: string | null, height = 0, exec: Executor = db) {
  const top = parentId ? (await pageDepth(parentId, exec)) + 1 : 0;
  if (top + height > MAX_PAGE_DEPTH) throw pageTooDeepError();
}

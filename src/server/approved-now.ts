import { sql, type SQL } from "drizzle-orm";
import { pageIdColumn } from "@/server/access";

/*
 * Whether a page is approved now, as SQL (server/page-approvals.ts): its own module, so search
 * (semantic-search `searchScope`) uses it without the rest of approvals.
 */

/**
 * SQL condition: the page of `alias` (or the page table) is approved right now: its latest round
 * that wasn't withdrawn ended approved, and its title and body are still the version approved.
 * Search's `is:approved`.
 */
export function approvedNow(alias?: string): SQL<boolean> {
  const id = pageIdColumn(alias);
  const column = (name: string) => (alias ? sql.raw(`"${alias}"."${name}"`) : sql.raw(`"page"."${name}"`));
  return sql<boolean>`exists (
    select 1 from page_approval pa
    join page_snapshot ps on ps.id = pa.snapshot_id
    where pa.page_id = ${id} and pa.status = 'approved'
      and ps.title = ${column("title")} and ps.content_markdown = ${column("content_markdown")}
      and not exists (select 1 from page_approval later where later.page_id = pa.page_id and later.status <> 'withdrawn' and later.created_at > pa.created_at)
  )`;
}

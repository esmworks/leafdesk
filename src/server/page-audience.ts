import { sql } from "drizzle-orm";
import type { db } from "@/db";
import { page, pageGroupPermission, pagePermission, pagePublication, teamspace, workspace } from "@/db/schema";
import { pageAudienceOf, type PageAudience } from "@/lib/page-audience";
import { livePublication } from "@/server/publication-live";

/**
 * Who could reach a page at a moment, for the audit log (server/audit.ts records it with each page
 * event): read with the reader given, so inside a change's transaction it sees that change. A
 * summary, not an access check: it reads the page's place (its teamspace, or the private pages),
 * the nearest "everyone" entry and the people and groups named on it or above it, and whether it
 * or a page above it is on the web. Null when the page is gone.
 */
export async function pageAudience(reader: Pick<typeof db, "execute">, pageId: string): Promise<PageAudience | null> {
  const [row] = await reader.execute<{
    teamspace_name: string | null;
    teamspace_access: string | null;
    in_teamspace: boolean;
    published: boolean;
    everyone: string | null;
    people: number;
    groups: number;
  }>(sql`
    with recursive chain as (
      select id, parent_id, 0 as depth from ${page} where id = ${pageId}
      union all
      select p.id, p.parent_id, c.depth + 1 from ${page} p join chain c on p.id = c.parent_id where c.depth < 64
    )
    select
      p.teamspace_id is not null as in_teamspace,
      ts.name as teamspace_name,
      ts.access as teamspace_access,
      (w.settings->>'publishing') is distinct from 'off' and exists (
        select 1 from chain c join ${pagePublication} pub on pub.page_id = c.id and ${livePublication("pub")}
      ) as published,
      (
        select pp.level from chain c join ${pagePermission} pp on pp.page_id = c.id and pp.user_id is null
        order by c.depth limit 1
      ) as everyone,
      (
        select count(*)::int from (
          select distinct on (pp.user_id) pp.level from chain c
          join ${pagePermission} pp on pp.page_id = c.id and pp.user_id is not null
          order by pp.user_id, c.depth
        ) nearest where nearest.level <> 'none'
      ) as people,
      (
        select count(*)::int from (
          select distinct on (gp.group_id) gp.level from chain c
          join ${pageGroupPermission} gp on gp.page_id = c.id
          order by gp.group_id, c.depth
        ) nearest where nearest.level <> 'none'
      ) as groups
    from ${page} p
    join ${workspace} w on w.id = p.workspace_id
    left join ${teamspace} ts on ts.id = p.teamspace_id
    where p.id = ${pageId}
  `);
  if (!row) return null;
  return pageAudienceOf({
    published: row.published,
    teamspace: row.in_teamspace ? { name: row.teamspace_name ?? "", everyoneIn: row.teamspace_access === "default" } : null,
    everyone: row.everyone,
    people: Number(row.people),
    groups: Number(row.groups),
  });
}

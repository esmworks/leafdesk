import { sql, type SQL } from "drizzle-orm";
import { pagePublication } from "@/db/schema";

/**
 * A publication that is still served: it has no expiry, or its expiry is still ahead. Every public
 * read of `page_publication` (links, sites, files, links to other published pages) asks it; an
 * expired publication reads as unpublished there. `alias`: the table's alias in raw SQL.
 */
export function livePublication(alias?: string): SQL {
  const column = alias ? sql.raw(`${alias}.expires_at`) : sql`${pagePublication.expiresAt}`;
  return sql`(${column} is null or ${column} > now())`;
}

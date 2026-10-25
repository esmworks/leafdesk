/**
 * The search box's filters beside its typed syntax (lib/search-query): teamspaces, who created a
 * page, who last edited it, and when it was last edited or created. Chosen from menus in the box
 * and sent with the query; the server (pages.searchWithQuery, lib/search-filters) turns them into
 * a search scope. Without imports: the box is in every page's first load.
 */

export const SEARCH_DATE_PRESETS = ["today", "week", "month", "custom"] as const;
export type SearchDatePreset = (typeof SEARCH_DATE_PRESETS)[number];
export type SearchDateField = "edited" | "created";

/** A date filter: today, the last 7 or 30 days (today included), or days chosen (YYYY-MM-DD, both ends included). */
export type SearchDateFilter = { field: SearchDateField; preset: SearchDatePreset; from?: string; to?: string };

export type SearchFilters = {
  teamspaceIds: string[];
  createdBy: string[];
  editedBy: string[];
  date: SearchDateFilter | null;
};

export const NO_SEARCH_FILTERS: SearchFilters = { teamspaceIds: [], createdBy: [], editedBy: [], date: null };

/**
 * How the box orders what it found: best match first (verified pages above otherwise equal ones),
 * or by when a page was last edited or created. A date order applies to every page that matches,
 * not only to the best few.
 */
export const SEARCH_SORTS = ["relevance", "editedNewest", "editedOldest", "createdNewest", "createdOldest"] as const;
export type SearchSort = (typeof SEARCH_SORTS)[number];

export const readSearchSort = (input: unknown): SearchSort =>
  SEARCH_SORTS.includes(input as SearchSort) ? (input as SearchSort) : "relevance";

/** A span of time: `from` included, `to` left out; either may be open. */
export type TimeRange = { from?: Date; to?: Date };

/** The most values one filter takes: a few people or teamspaces, never a list to page through. */
export const MAX_FILTER_VALUES = 20;

export const hasFilterValues = (filters: SearchFilters) =>
  filters.teamspaceIds.length > 0 || filters.createdBy.length > 0 || filters.editedBy.length > 0 || filters.date !== null;

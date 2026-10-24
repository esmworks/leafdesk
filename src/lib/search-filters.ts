import { isDay } from "./date-value";
import { dayNumber, localDay, zonedInstant } from "./time-zone";

/**
 * The search box's filters beside its typed syntax (lib/search-query): teamspaces, who created a
 * page, who last edited it, and when it was last edited or created. Chosen from menus in the box
 * and sent with the query; the server (pages.searchWithQuery) turns them into a search scope.
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

/** A span of time: `from` included, `to` left out; either may be open. */
export type TimeRange = { from?: Date; to?: Date };

/** The most values one filter takes: a few people or teamspaces, never a list to page through. */
export const MAX_FILTER_VALUES = 20;

export const hasFilterValues = (filters: SearchFilters) =>
  filters.teamspaceIds.length > 0 || filters.createdBy.length > 0 || filters.editedBy.length > 0 || filters.date !== null;

const ids = (value: unknown): string[] =>
  Array.isArray(value)
    ? [...new Set(value.filter((v): v is string => typeof v === "string" && v.length > 0 && v.length <= 200))].slice(0, MAX_FILTER_VALUES)
    : [];

/** Filters as a server action receives them, checked and narrowed: anything unexpected is dropped. */
export function readSearchFilters(input: unknown): SearchFilters {
  if (!input || typeof input !== "object") return NO_SEARCH_FILTERS;
  const raw = input as Record<string, unknown>;
  let date: SearchDateFilter | null = null;
  const d = raw.date;
  if (d && typeof d === "object") {
    const { field, preset, from, to } = d as Record<string, unknown>;
    if ((field === "edited" || field === "created") && SEARCH_DATE_PRESETS.includes(preset as SearchDatePreset)) {
      if (preset !== "custom") date = { field, preset: preset as SearchDatePreset };
      else if (isDay(from) || isDay(to)) date = { field, preset, ...(isDay(from) ? { from } : {}), ...(isDay(to) ? { to } : {}) };
    }
  }
  return { teamspaceIds: ids(raw.teamspaceIds), createdBy: ids(raw.createdBy), editedBy: ids(raw.editedBy), date };
}

/**
 * The time a date filter covers, by days of `timeZone`: today from its midnight, the last 7 or 30
 * days from the midnight 6 or 29 days before, chosen days from the first one's midnight to the
 * midnight after the last one. Days given the wrong way round are swapped.
 */
export function searchDateRange(filter: SearchDateFilter, now: Date, timeZone: string): TimeRange {
  const today = localDay(now.getTime(), timeZone);
  const startOf = (day: number) => new Date(zonedInstant(day, 0, timeZone));
  switch (filter.preset) {
    case "today":
      return { from: startOf(today) };
    case "week":
      return { from: startOf(today - 6) };
    case "month":
      return { from: startOf(today - 29) };
    case "custom": {
      let first = filter.from ? dayNumber(filter.from) : null;
      let last = filter.to ? dayNumber(filter.to) : null;
      if (first !== null && last !== null && first > last) [first, last] = [last, first];
      return { ...(first !== null ? { from: startOf(first) } : {}), ...(last !== null ? { to: startOf(last + 1) } : {}) };
    }
  }
}

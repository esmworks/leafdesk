import { isDay } from "./date-value";
import {
  MAX_FILTER_VALUES,
  NO_SEARCH_FILTERS,
  SEARCH_DATE_PRESETS,
  type SearchDateFilter,
  type SearchDatePreset,
  type SearchFilters,
  type TimeRange,
} from "./search-filter-state";
import { dayNumber, localDay, zonedInstant } from "./time-zone";

export * from "./search-filter-state";

// The search box's filters as the server reads them; the box's own state is in lib/search-filter-state.

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

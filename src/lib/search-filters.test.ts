import { describe, expect, it } from "vitest";
import { hasFilterValues, MAX_FILTER_VALUES, NO_SEARCH_FILTERS, readSearchFilters, searchDateRange } from "./search-filters";

describe("readSearchFilters", () => {
  it("keeps what the box sends", () => {
    const filters = readSearchFilters({ teamspaceIds: ["ts1"], createdBy: ["u1", "u1", "u2"], editedBy: [], date: { field: "edited", preset: "week" } });
    expect(filters).toEqual({ teamspaceIds: ["ts1"], createdBy: ["u1", "u2"], editedBy: [], date: { field: "edited", preset: "week" } });
    expect(hasFilterValues(filters)).toBe(true);
  });

  it("drops anything unexpected", () => {
    expect(readSearchFilters(null)).toEqual(NO_SEARCH_FILTERS);
    expect(readSearchFilters("x")).toEqual(NO_SEARCH_FILTERS);
    expect(readSearchFilters({ teamspaceIds: "ts1", createdBy: [1, null, ""], date: { field: "deleted", preset: "week" } })).toEqual(NO_SEARCH_FILTERS);
    expect(readSearchFilters({ date: { field: "created", preset: "custom", from: "2026-13-40" } }).date).toBeNull();
    expect(readSearchFilters({ date: { field: "created", preset: "custom", from: "2026-10-01", to: 5 } }).date).toEqual({
      field: "created",
      preset: "custom",
      from: "2026-10-01",
    });
    expect(readSearchFilters({ createdBy: Array.from({ length: 50 }, (_, i) => `u${i}`) }).createdBy).toHaveLength(MAX_FILTER_VALUES);
    expect(hasFilterValues(NO_SEARCH_FILTERS)).toBe(false);
  });
});

describe("searchDateRange", () => {
  // 2026-10-24 01:30 in Istanbul (UTC+3) is still the 23rd in UTC.
  const now = new Date("2026-10-23T22:30:00Z");

  it("counts today and the last days in the person's time zone", () => {
    expect(searchDateRange({ field: "edited", preset: "today" }, now, "Europe/Istanbul")).toEqual({ from: new Date("2026-10-23T21:00:00Z") });
    expect(searchDateRange({ field: "edited", preset: "today" }, now, "UTC")).toEqual({ from: new Date("2026-10-23T00:00:00Z") });
    expect(searchDateRange({ field: "edited", preset: "week" }, now, "Europe/Istanbul")).toEqual({ from: new Date("2026-10-17T21:00:00Z") });
    expect(searchDateRange({ field: "created", preset: "month" }, now, "UTC")).toEqual({ from: new Date("2026-09-24T00:00:00Z") });
  });

  it("takes chosen days with both ends included, either open, the wrong way round swapped", () => {
    expect(searchDateRange({ field: "created", preset: "custom", from: "2026-10-01", to: "2026-10-05" }, now, "UTC")).toEqual({
      from: new Date("2026-10-01T00:00:00Z"),
      to: new Date("2026-10-06T00:00:00Z"),
    });
    expect(searchDateRange({ field: "created", preset: "custom", from: "2026-10-05", to: "2026-10-01" }, now, "UTC")).toEqual({
      from: new Date("2026-10-01T00:00:00Z"),
      to: new Date("2026-10-06T00:00:00Z"),
    });
    expect(searchDateRange({ field: "created", preset: "custom", to: "2026-10-05" }, now, "Europe/Istanbul")).toEqual({ to: new Date("2026-10-05T21:00:00Z") });
  });
});

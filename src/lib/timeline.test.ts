import { describe, expect, it } from "vitest";
import {
  addMonths,
  dayAtX,
  dayNumber,
  daysInMonth,
  dayValue,
  dayX,
  dragDays,
  dragSpan,
  headerUnits,
  MAX_RANGE_DAYS,
  monthStart,
  nextUnit,
  rowSpan,
  spanValues,
  timelineRange,
  unitStart,
  valueDay,
  weekStart,
} from "./timeline";

const d = (value: string) => dayNumber(value)!;

describe("day numbers", () => {
  it("round-trip dates and ignore anything after the day", () => {
    expect(dayNumber("1970-01-01")).toBe(0);
    expect(dayValue(d("2026-09-27"))).toBe("2026-09-27");
    expect(dayNumber("2026-09-27T23:59:00Z")).toBe(d("2026-09-27"));
  });

  it("reject malformed and overflowing dates", () => {
    expect(dayNumber("2026-02-30")).toBeNull();
    expect(dayNumber("2026-13-01")).toBeNull();
    expect(dayNumber("next week")).toBeNull();
    expect(dayNumber(20260927)).toBeNull();
    expect(dayNumber(null)).toBeNull();
  });

  it("place timestamps on the local day and ignore other property types", () => {
    const at = new Date(2026, 8, 27, 23, 30);
    expect(valueDay(at.toISOString(), "created_time")).toBe(d("2026-09-27"));
    expect(valueDay("2026-09-27", "text")).toBeNull();
    expect(valueDay("2026-09-27T22:30:00Z", "created_time", "Europe/Istanbul")).toBe(d("2026-09-28"));
    expect(valueDay("2026-09-27T22:30:00Z", "created_time", "America/New_York")).toBe(d("2026-09-27"));
  });
});

describe("calendar units", () => {
  it("start weeks on Monday", () => {
    expect(dayValue(weekStart(d("2026-09-27")))).toBe("2026-09-21"); // Sunday → previous Monday
    expect(dayValue(weekStart(d("2026-09-21")))).toBe("2026-09-21"); // Monday stays
    expect(dayValue(weekStart(d("1970-01-01")))).toBe("1969-12-29"); // before day zero too
    expect(dayValue(weekStart(d("1969-12-28")))).toBe("1969-12-22");
  });

  it("know month lengths, leap years included", () => {
    expect(daysInMonth(2026, 1)).toBe(28);
    expect(daysInMonth(2028, 1)).toBe(29);
    expect(daysInMonth(2100, 1)).toBe(28);
    expect(daysInMonth(2000, 1)).toBe(29);
    expect(daysInMonth(2026, 3)).toBe(30);
    expect(daysInMonth(2026, 11)).toBe(31);
  });

  it("step months across year ends", () => {
    expect(dayValue(monthStart(d("2026-09-27")))).toBe("2026-09-01");
    expect(dayValue(addMonths(d("2026-12-15"), 1))).toBe("2027-01-01");
    expect(dayValue(addMonths(d("2026-01-31"), -1))).toBe("2025-12-01");
  });

  it("find unit bounds per zoom", () => {
    const day = d("2026-09-24"); // Thursday
    expect(dayValue(unitStart(day, "day"))).toBe("2026-09-24");
    expect(dayValue(unitStart(day, "week"))).toBe("2026-09-21");
    expect(dayValue(unitStart(day, "month"))).toBe("2026-09-01");
    expect(dayValue(nextUnit(day, "week"))).toBe("2026-09-28");
    expect(dayValue(nextUnit(day, "month"))).toBe("2026-10-01");
  });
});

describe("rowSpan", () => {
  const start = { id: "s", type: "date" as const };
  const end = { id: "e", type: "date" as const };

  it("spans start to end", () => {
    expect(rowSpan({ s: "2026-09-01", e: "2026-09-05" }, start, end)).toEqual({ start: d("2026-09-01"), end: d("2026-09-05") });
  });

  it("makes one-day bars without an end, with an end before the start, or without an end property", () => {
    const one = { start: d("2026-09-01"), end: d("2026-09-01") };
    expect(rowSpan({ s: "2026-09-01" }, start, end)).toEqual(one);
    expect(rowSpan({ s: "2026-09-01", e: "2026-08-01" }, start, end)).toEqual(one);
    expect(rowSpan({ s: "2026-09-01", e: "2026-09-05" }, start, null)).toEqual(one);
  });

  it("has no bar without a start", () => {
    expect(rowSpan({ e: "2026-09-05" }, start, end)).toBeNull();
    expect(rowSpan({ s: "soon" }, start, end)).toBeNull();
  });
});

describe("timelineRange", () => {
  const focus = d("2026-09-24");

  it("covers bars and today with padding, aligned to whole columns", () => {
    const range = timelineRange([{ start: d("2026-10-10"), end: d("2026-11-20") }], focus, "week");
    expect(weekStart(range.start)).toBe(range.start);
    expect(weekStart(range.end + 1)).toBe(range.end + 1);
    expect(range.start).toBeLessThanOrEqual(focus - 42);
    expect(range.end).toBeGreaterThanOrEqual(d("2026-11-20") + 42);
  });

  it("aligns month ranges to whole months", () => {
    const range = timelineRange([], focus, "month");
    expect(dayValue(range.start).endsWith("-01")).toBe(true);
    expect(dayValue(range.end + 1).endsWith("-01")).toBe(true);
  });

  it("centres on the focus when the bars span more than the zoom allows", () => {
    const range = timelineRange([{ start: d("2000-01-01"), end: d("2000-01-02") }], focus, "day");
    expect(range.end - range.start + 1).toBeLessThanOrEqual(MAX_RANGE_DAYS.day + 1);
    expect(range.start).toBeLessThan(focus);
    expect(range.end).toBeGreaterThan(focus);
  });
});

describe("headerUnits", () => {
  it("splits a week range into week columns under month labels, cut at the range edges", () => {
    const range = { start: d("2026-09-21"), end: d("2026-10-18") };
    const { top, columns } = headerUnits(range, "week");
    expect(columns.map((c) => [dayValue(c.start), c.days])).toEqual([
      ["2026-09-21", 7],
      ["2026-09-28", 7],
      ["2026-10-05", 7],
      ["2026-10-12", 7],
    ]);
    expect(top.map((c) => [dayValue(c.start), c.days])).toEqual([
      ["2026-09-21", 10],
      ["2026-10-01", 18],
    ]);
  });

  it("uses month columns under year labels at month zoom", () => {
    const range = { start: d("2026-11-01"), end: d("2027-02-28") };
    const { top, columns } = headerUnits(range, "month");
    expect(columns.map((c) => c.days)).toEqual([30, 31, 31, 28]);
    expect(top.map((c) => [dayValue(c.start), c.days])).toEqual([
      ["2026-11-01", 61],
      ["2027-01-01", 59],
    ]);
  });
});

describe("dragging", () => {
  const range = { start: d("2026-09-01"), end: d("2026-12-31") };

  it("converts between days and pixels", () => {
    expect(dayX(d("2026-09-03"), range, "day")).toBe(80);
    expect(dayAtX(85, range, "day")).toBe(d("2026-09-03"));
    expect(dayAtX(0, range, "month")).toBe(range.start);
  });

  it("rounds drags to whole days at each zoom", () => {
    expect(dragDays(19, "day")).toBe(0);
    expect(dragDays(21, "day")).toBe(1);
    expect(dragDays(-61, "week")).toBe(-3);
    expect(dragDays(30, "month")).toBe(8);
    expect(dragDays(0, "week")).toBe(0);
  });

  it("moves bars keeping their length and resizes one edge at a time", () => {
    const span = { start: d("2026-09-10"), end: d("2026-09-14") };
    expect(dragSpan(span, "move", 3)).toEqual({ start: d("2026-09-13"), end: d("2026-09-17") });
    expect(dragSpan(span, "end", 2)).toEqual({ start: span.start, end: d("2026-09-16") });
    expect(dragSpan(span, "start", -2)).toEqual({ start: d("2026-09-08"), end: span.end });
    // Edges never cross: the shortest bar is one day.
    expect(dragSpan(span, "end", -10)).toEqual({ start: span.start, end: span.start });
    expect(dragSpan(span, "start", 10)).toEqual({ start: span.end, end: span.end });
  });

  it("writes only the values a drag changed", () => {
    const one = { start: d("2026-09-10"), end: d("2026-09-10") };
    const end = { id: "e", hasValue: false };
    // Moving a one-day bar keeps it a plain date.
    expect(spanValues(one, dragSpan(one, "move", 2), "s", end)).toEqual({ s: "2026-09-12" });
    // Stretching it creates the end value.
    expect(spanValues(one, dragSpan(one, "end", 2), "s", end)).toEqual({ e: "2026-09-12" });
    expect(spanValues(one, dragSpan(one, "start", -1), "s", end)).toEqual({ s: "2026-09-09", e: "2026-09-10" });
    // Without an end property only the start moves.
    expect(spanValues(one, dragSpan(one, "end", 2), "s", null)).toEqual({});
    const long = { start: d("2026-09-10"), end: d("2026-09-12") };
    const withEnd = { id: "e", hasValue: true };
    expect(spanValues(long, dragSpan(long, "move", -1), "s", withEnd)).toEqual({ s: "2026-09-09", e: "2026-09-11" });
    expect(spanValues(long, dragSpan(long, "move", 0), "s", withEnd)).toEqual({});
  });
});

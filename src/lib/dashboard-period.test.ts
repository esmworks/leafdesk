import { describe, expect, it } from "vitest";
import {
  ALL_TIME,
  changeTone,
  figureChange,
  nameRange,
  parseDashboardPeriod,
  PERIOD_NONE,
  periodProperty,
  periodRange,
  previousRange,
  rangeShape,
  readDashboardPeriod,
  serializeDashboardPeriod,
  withPeriod,
} from "./dashboard-period";
import { applyView } from "./properties";

const MONDAY = new Date("2026-10-26T12:00:00Z");

describe("dashboard periods", () => {
  it("reads and writes what a dashboard stores", () => {
    expect(parseDashboardPeriod("")).toEqual(ALL_TIME);
    expect(parseDashboardPeriod(undefined)).toEqual(ALL_TIME);
    expect(parseDashboardPeriod("this_month")).toEqual({ kind: "this_month" });
    expect(parseDashboardPeriod("2026-01-01/2026-03-31")).toEqual({ kind: "custom", start: "2026-01-01", end: "2026-03-31" });
    for (const p of ["this_quarter", "last_year", "2026-02-01/2026-02-28", ""]) expect(serializeDashboardPeriod(parseDashboardPeriod(p))).toBe(p);
  });

  it("names nothing for what isn't a period", () => {
    for (const bad of ["today", "next_month", "past_n_days", "2026-03-01/2026-02-01", "2026-02-30/2026-03-01", "2026-01-01", "2026-01-01/2026-02-01/x", 5]) {
      expect(readDashboardPeriod(bad)).toBeNull();
      expect(parseDashboardPeriod(bad)).toEqual(ALL_TIME);
    }
  });

  it("works out the days of a period on the reader's day", () => {
    expect(periodRange(ALL_TIME, MONDAY)).toBeNull();
    expect(periodRange({ kind: "this_week" }, MONDAY, "UTC")).toEqual({ start: "2026-10-26", end: "2026-11-01" });
    expect(periodRange({ kind: "this_month" }, MONDAY, "UTC")).toEqual({ start: "2026-10-01", end: "2026-10-31" });
    expect(periodRange({ kind: "this_quarter" }, MONDAY, "UTC")).toEqual({ start: "2026-10-01", end: "2026-12-31" });
    expect(periodRange({ kind: "last_quarter" }, MONDAY, "UTC")).toEqual({ start: "2026-07-01", end: "2026-09-30" });
    expect(periodRange({ kind: "last_year" }, MONDAY, "UTC")).toEqual({ start: "2025-01-01", end: "2025-12-31" });
    // Late on 31 October in UTC is November in Istanbul.
    const late = new Date("2026-10-31T22:30:00Z");
    expect(periodRange({ kind: "this_month" }, late, "Europe/Istanbul")).toEqual({ start: "2026-11-01", end: "2026-11-30" });
  });

  it("compares with the whole unit before, or as many days before", () => {
    expect(previousRange(ALL_TIME, MONDAY)).toBeNull();
    expect(previousRange({ kind: "this_month" }, MONDAY, "UTC")).toEqual({ start: "2026-09-01", end: "2026-09-30" });
    expect(previousRange({ kind: "last_month" }, MONDAY, "UTC")).toEqual({ start: "2026-08-01", end: "2026-08-31" });
    expect(previousRange({ kind: "this_month" }, new Date("2026-03-15T12:00:00Z"), "UTC")).toEqual({ start: "2026-02-01", end: "2026-02-28" });
    expect(previousRange({ kind: "this_quarter" }, new Date("2027-02-10T12:00:00Z"), "UTC")).toEqual({ start: "2026-10-01", end: "2026-12-31" });
    expect(previousRange({ kind: "this_week" }, MONDAY, "UTC")).toEqual({ start: "2026-10-19", end: "2026-10-25" });
    expect(previousRange({ kind: "this_year" }, MONDAY, "UTC")).toEqual({ start: "2025-01-01", end: "2025-12-31" });
    expect(previousRange({ kind: "custom", start: "2026-03-01", end: "2026-03-10" }, MONDAY)).toEqual({ start: "2026-02-19", end: "2026-02-28" });
  });

  it("cuts rows on the property a widget names, the first date, or the first created time", () => {
    const props = [
      { id: "title", type: "text" },
      { id: "made", type: "created_time" },
      { id: "due", type: "date" },
      { id: "sent", type: "date" },
    ];
    expect(periodProperty(props, undefined)?.id).toBe("due");
    expect(periodProperty(props, "sent")?.id).toBe("sent");
    expect(periodProperty(props.slice(0, 2), undefined)?.id).toBe("made");
    expect(periodProperty(props.slice(0, 1), undefined)).toBeNull();
    expect(periodProperty(props, PERIOD_NONE)).toBeNull();
    // One the reader can't see (or that isn't a date) leaves the period aside rather than take another.
    expect(periodProperty(props, "gone")).toBeNull();
    expect(periodProperty(props, "title")).toBeNull();
  });

  it("adds the period to a view's own filters", () => {
    const range = { start: "2026-10-01", end: "2026-10-31" };
    const own = { filters: [{ propertyId: "s", op: "equals" as const, value: "won" }] };
    expect(withPeriod(own, "d", range).filters).toEqual([
      { propertyId: "s", op: "equals", value: "won" },
      { propertyId: "d", op: "gte", value: "2026-10-01" },
      { propertyId: "d", op: "lte", value: "2026-10-31" },
    ]);
    // "Or" filters stay one condition the period comes on top of.
    const either = { filters: [own.filters[0], { propertyId: "s", op: "equals" as const, value: "lost" }], filterCombinator: "or" as const };
    const cut = withPeriod(either, "d", range);
    expect(cut.filterCombinator).toBe("and");
    expect(cut.filters?.[0]).toEqual({ type: "group", combinator: "or", rules: either.filters });

    const props = [{ id: "d", name: "Date", type: "date" as const, options: {} }];
    const row = (id: string, d: unknown) => ({ id, title: id, properties: { d }, createdAt: new Date(), updatedAt: new Date() });
    const rows = [row("sep", "2026-09-30"), row("oct", "2026-10-15"), row("span", "2026-09-28/2026-10-02"), row("none", null)];
    expect(applyView(rows, withPeriod({}, "d", range), props).map((r) => r.id)).toEqual(["oct", "span"]);
  });

  it("says how a figure changed, and whether that is good", () => {
    const n = (value: number) => ({ format: "number" as const, value });
    expect(figureChange(n(112), n(100))).toEqual({ by: "ratio", value: expect.closeTo(0.12) });
    expect(figureChange(n(50), n(-100))).toEqual({ by: "ratio", value: 1.5 });
    // Nothing to take a share of: no change rather than an endless one.
    expect(figureChange(n(5), n(0))).toBeNull();
    expect(figureChange(n(5), null)).toBeNull();
    expect(figureChange({ format: "percent", value: 0.3 }, { format: "percent", value: 0.25 })).toEqual({ by: "points", value: expect.closeTo(0.05) });
    expect(figureChange({ format: "date", value: "2026-10-01" }, { format: "date", value: "2026-09-01" })).toBeNull();
    expect(changeTone({ by: "ratio", value: 0.2 }, "higher")).toBe("good");
    expect(changeTone({ by: "ratio", value: 0.2 }, "lower")).toBe("bad");
    expect(changeTone({ by: "ratio", value: -0.2 }, "lower")).toBe("good");
    expect(changeTone({ by: "ratio", value: 0 }, "higher")).toBe("flat");
  });

  it("names a range as shortly as it goes", () => {
    expect(rangeShape({ start: "2026-10-01", end: "2026-10-31" })).toEqual({ kind: "month", start: "2026-10-01" });
    expect(rangeShape({ start: "2026-07-01", end: "2026-09-30" })).toEqual({ kind: "quarter", quarter: 3, year: 2026 });
    expect(rangeShape({ start: "2026-01-01", end: "2026-12-31" })).toEqual({ kind: "year", start: "2026-01-01" });
    expect(rangeShape({ start: "2026-02-01", end: "2026-03-31" }).kind).toBe("days");
    expect(rangeShape({ start: "2026-10-19", end: "2026-10-25" }).kind).toBe("days");
    const intl = new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });
    const format = {
      dateTime: (d: Date, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", o).format(d),
      dateTimeRange: (a: Date, b: Date, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", o).formatRange(a, b),
    };
    const quarter = ({ quarter, year }: { quarter: number; year: number }) => `Q${quarter} ${year}`;
    expect(nameRange({ start: "2026-09-01", end: "2026-09-30" }, format, quarter)).toBe(intl.format(new Date(Date.UTC(2026, 8, 15))));
    expect(nameRange({ start: "2026-07-01", end: "2026-09-30" }, format, quarter)).toBe("Q3 2026");
    expect(nameRange({ start: "2026-10-19", end: "2026-10-25" }, format, quarter)).toMatch(/^19\s?–\s?25 Oct 2026$/);
  });
});

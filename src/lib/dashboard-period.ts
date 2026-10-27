import type { FilterEntry, FilterRule, ViewConfig } from "@/db/schema/app";
import type { AggregateResult } from "./aggregate";
import { ALL_TIME, type Comparison, type DashboardPeriod, isPeriodPropertyType, PERIOD_NONE, readDashboardPeriod, type RelativePeriod } from "./dashboard-period-value";
import { relativeDateRange } from "./filters";
import { dayNumber, dayString } from "./time-zone";

/**
 * A dashboard's period (see lib/dashboard): one choice above the grid, "this month" or a range of
 * days, that every widget's rows are cut to, on a date property of the widget's database. Stored
 * with the dashboard (the block's `period` prop, a dashboard view's `period` setting) as a short
 * string: a relative range's name ("this_month"), two days ("2026-01-01/2026-03-31"), or nothing
 * for all time. Readers may pick another one for themselves without saving it.
 *
 * The days are worked out where the figures are, for each reader in their time zone, through the
 * relative ranges view filters use (lib/filters relativeDateRange), and applied as two plain date
 * rules (withPeriod), so a widget's own filters and the period combine as filters always do.
 *
 * Pure: the editor, the server (server/dashboards) and published pages share it.
 */

export {
  ALL_TIME,
  COMPARISONS,
  DASHBOARD_PERIODS,
  isPeriodPropertyType,
  PERIOD_NONE,
  readDashboardPeriod,
  type Comparison,
  type DashboardPeriod,
  type RelativePeriod,
} from "./dashboard-period-value";

/** Message keys (`page.dashboard.period.*`) of the relative periods. */
export const PERIOD_LABELS = {
  this_week: "thisWeek",
  this_month: "thisMonth",
  this_quarter: "thisQuarter",
  this_year: "thisYear",
  last_week: "lastWeek",
  last_month: "lastMonth",
  last_quarter: "lastQuarter",
  last_year: "lastYear",
} as const satisfies Record<RelativePeriod, string>;

/** A stored period as it may be read: one that names none is all time. */
export const parseDashboardPeriod = (value: unknown): DashboardPeriod => readDashboardPeriod(value) ?? ALL_TIME;

/** A period as it is stored: "" for all time. */
export function serializeDashboardPeriod(period: DashboardPeriod): string {
  if (period.kind === "all") return "";
  return period.kind === "custom" ? `${period.start}/${period.end}` : period.kind;
}

export const samePeriod = (a: DashboardPeriod, b: DashboardPeriod) => serializeDashboardPeriod(a) === serializeDashboardPeriod(b);

export type DayRange = { start: string; end: string };

/** The first and last day (inclusive) of a period on `now`'s day in `timeZone`; null for all time. */
export function periodRange(period: DashboardPeriod, now: Date, timeZone?: string): DayRange | null {
  if (period.kind === "all") return null;
  if (period.kind === "custom") return { start: period.start, end: period.end };
  return relativeDateRange(period.kind, undefined, now, timeZone);
}

/** The calendar unit a relative period spans. */
const UNIT: Record<RelativePeriod, "week" | "month" | "quarter" | "year"> = {
  this_week: "week",
  last_week: "week",
  this_month: "month",
  last_month: "month",
  this_quarter: "quarter",
  last_quarter: "quarter",
  this_year: "year",
  last_year: "year",
};

export const periodUnit = (period: RelativePeriod) => UNIT[period];

/**
 * How a range of days is best named, shortest first: a whole month ("Oct 2026"), quarter ("Q3
 * 2026") or year, one day, or its first and last day. The words are the reader's language's.
 */
export type RangeShape =
  | { kind: "month" | "year" | "day"; start: string }
  | { kind: "quarter"; quarter: number; year: number }
  | { kind: "days"; start: string; end: string };

export function rangeShape(range: DayRange): RangeShape {
  const [sy, sm, sd] = range.start.split("-").map(Number);
  const [ey, em, ed] = range.end.split("-").map(Number);
  const wholeMonths = sy === ey && sd === 1 && ed === new Date(Date.UTC(ey, em, 0)).getUTCDate();
  if (wholeMonths && sm === em) return { kind: "month", start: range.start };
  if (wholeMonths && sm === 1 && em === 12) return { kind: "year", start: range.start };
  if (wholeMonths && sm % 3 === 1 && em === sm + 2) return { kind: "quarter", quarter: (sm + 2) / 3, year: sy };
  if (range.start === range.end) return { kind: "day", start: range.start };
  return { kind: "days", start: range.start, end: range.end };
}

/** A day as a Date to format in UTC (noon, so no zone moves it to another day). */
export function dayDate(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
}

type DayFormat = { day?: "numeric"; month?: "short"; year: "numeric"; timeZone: "UTC" };

/** The names a range's shape takes, given a formatter's two calls and the words for a quarter. */
export function nameRange(
  range: DayRange,
  format: {
    dateTime: (date: Date, options: DayFormat) => string;
    dateTimeRange: (start: Date, end: Date, options: DayFormat) => string;
  },
  quarter: (values: { quarter: number; year: number }) => string,
): string {
  const shape = rangeShape(range);
  const day = { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" } as const;
  switch (shape.kind) {
    case "month":
      return format.dateTime(dayDate(shape.start), { month: "short", year: "numeric", timeZone: "UTC" });
    case "year":
      return format.dateTime(dayDate(shape.start), { year: "numeric", timeZone: "UTC" });
    case "quarter":
      return quarter(shape);
    case "day":
      return format.dateTime(dayDate(shape.start), day);
    case "days":
      return format.dateTimeRange(dayDate(shape.start), dayDate(shape.end), day);
  }
}

/**
 * The period before, of the same length: the whole week, month, quarter or year before a relative
 * one (this month's is last month, last month's the month before), and for a range of days the
 * same number of days just before it. Null for all time.
 */
export function previousRange(period: DashboardPeriod, now: Date, timeZone?: string): DayRange | null {
  const range = periodRange(period, now, timeZone);
  if (!range || period.kind === "all") return null;
  const first = dayNumber(range.start);
  if (period.kind === "custom") {
    const length = dayNumber(range.end) - first + 1;
    return { start: dayString(first - length), end: dayString(first - 1) };
  }
  // The unit holding the day before this one starts, as seen on that day.
  const dayBefore = new Date((first - 1) * 86_400_000 + 12 * 3_600_000);
  return relativeDateRange(`this_${UNIT[period.kind]}`, undefined, dayBefore, "UTC");
}

// ---------------------------------------------------------------------------------------------
// The property a widget's period filters on

/**
 * The property a widget's period filters on, among those its reader knows of: the one its
 * `periodBy` names, or by default the database's first date property, else its first created time.
 * Null when the widget shows every row ("none"), names a property the reader can't see, or the
 * database has no such property: the widget then leaves the period aside, and says so.
 */
export function periodProperty<P extends { id: string; type: string }>(properties: P[], periodBy: string | undefined): P | null {
  if (periodBy === PERIOD_NONE) return null;
  if (periodBy) return properties.find((p) => p.id === periodBy && isPeriodPropertyType(p.type)) ?? null;
  return properties.find((p) => p.type === "date") ?? properties.find((p) => p.type === "created_time") ?? null;
}

/**
 * `config` with its rows cut to the days of `range` on `propertyId`: the view's own filters, and
 * the two rules. A row whose date is a range is in when any of its days is, as with "is within".
 * Applied when the widget is read, never stored: the result may nest deeper than a saved view may.
 */
export function withPeriod(config: ViewConfig, propertyId: string, range: DayRange): ViewConfig {
  const rules: FilterRule[] = [
    { propertyId, op: "gte", value: range.start },
    { propertyId, op: "lte", value: range.end },
  ];
  const own: FilterEntry[] = config.filters ?? [];
  const filters: FilterEntry[] =
    own.length > 1 && config.filterCombinator === "or" ? [{ type: "group", combinator: "or", rules: own }, ...rules] : [...own, ...rules];
  return { ...config, filters, filterCombinator: "and" };
}

// ---------------------------------------------------------------------------------------------
// Comparing a number with the period before

export const comparisonOf = (config: Pick<ViewConfig, "comparison">): Comparison => config.comparison ?? "higher";

/**
 * How a figure changed from the period before: by a share of the earlier figure (+0.12 is 12 %
 * more), or for percentages by points (0.05 is five points). Null when there is nothing to compare
 * with (the earlier period had no figure, or nothing to take a share of) or the figure is a date.
 */
export type FigureChange = { by: "ratio" | "points"; value: number };

export function figureChange(current: AggregateResult | null, previous: AggregateResult | null): FigureChange | null {
  if (!current || !previous || current.format !== previous.format) return null;
  if (current.format === "date" || previous.format === "date") return null;
  if (current.format === "percent") return { by: "points", value: current.value - previous.value };
  if (previous.value === 0) return null;
  return { by: "ratio", value: (current.value - previous.value) / Math.abs(previous.value) };
}

/** Whether a change is good, bad or neither, as the widget's comparison counts it. */
export function changeTone(change: FigureChange, comparison: Comparison): "good" | "bad" | "flat" {
  if (Math.abs(change.value) < 0.0005 || comparison === "off") return "flat";
  return (change.value > 0) === (comparison === "higher") ? "good" : "bad";
}

import type { RelativeDateRange } from "@/db/schema/app";
import { holdsTimestamp } from "./property-types";
import { dayNumber, dayString } from "./time-zone";

/**
 * The values a dashboard's period, a widget's comparison and its date property may take (see lib/dashboard-period),
 * apart from the rest so that checking a view's settings (lib/views, in every first load) doesn't
 * bring in how periods are worked out and named.
 */

/** The relative ranges a dashboard offers, in the order its menu lists them. */
export const DASHBOARD_PERIODS = [
  "this_week",
  "this_month",
  "this_quarter",
  "this_year",
  "last_week",
  "last_month",
  "last_quarter",
  "last_year",
] as const satisfies readonly RelativeDateRange[];
export type RelativePeriod = (typeof DASHBOARD_PERIODS)[number];

export type DashboardPeriod = { kind: "all" } | { kind: RelativePeriod } | { kind: "custom"; start: string; end: string };

export const ALL_TIME: DashboardPeriod = { kind: "all" };

/** A custom period spans at most this many days (a hundred years). */
const MAX_PERIOD_DAYS = 36_525;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Whether `value` is a calendar day as YYYY-MM-DD (and a real one: no 31 April). */
function isCalendarDay(value: string) {
  return DAY.test(value) && dayString(dayNumber(value)) === value;
}

/** A stored period, or null when `value` names none (anything but these strings, or a bad range). */
export function readDashboardPeriod(value: unknown): DashboardPeriod | null {
  if (value === undefined || value === null || value === "") return ALL_TIME;
  if (typeof value !== "string") return null;
  if ((DASHBOARD_PERIODS as readonly string[]).includes(value)) return { kind: value as RelativePeriod };
  const [start, end, ...rest] = value.split("/");
  if (rest.length || !start || !end || !isCalendarDay(start) || !isCalendarDay(end)) return null;
  const days = dayNumber(end) - dayNumber(start);
  return days >= 0 && days < MAX_PERIOD_DAYS ? { kind: "custom", start, end } : null;
}

/** Which way a number widget's change is good, or "off" to show none. */
export const COMPARISONS = ["higher", "lower", "off"] as const;
export type Comparison = (typeof COMPARISONS)[number];

/** Kept in a widget's `periodBy` to show every row whatever the dashboard's period. */
export const PERIOD_NONE = "none";

/** Properties a period can filter on: dates, and the times rows were created and edited. */
export const isPeriodPropertyType = (type: string) => type === "date" || holdsTimestamp(type);

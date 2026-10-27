import { readDashboardPeriod, type DashboardPeriod, type RelativePeriod } from "./dashboard-period-value";
import type { RepeatFrequency } from "./schedule";
import { dayString, localDay } from "./time-zone";

/**
 * Dashboard emails: a dashboard's figures sent to chosen people on a repeat rule (lib/schedule),
 * each recipient getting what they may see of it, worked out when it is sent (server/dashboard-emails).
 * A subscription is a schedule of kind "dashboard_email" on the page holding the dashboard: a page
 * with a dashboard block, or a database with a dashboard view.
 *
 * Its period is counted from when it is due, in the schedule's time zone: "last week" in a Monday
 * email is the week that just ended. Pure, for the scheduler and the dialog that sets one.
 */

/** Which dashboard of the page: a dashboard block (its block id) or a dashboard view (its view id). */
export type DashboardEmailTarget = { block: string } | { view: string };

/**
 * The periods a subscription offers: the dashboard's relative ones, the day before, or the period
 * the dashboard itself is saved with ("dashboard").
 */
export const SUBSCRIPTION_PERIODS = [
  "yesterday",
  "last_week",
  "last_month",
  "last_quarter",
  "last_year",
  "this_week",
  "this_month",
  "this_quarter",
  "this_year",
  "dashboard",
] as const satisfies readonly (RelativePeriod | "yesterday" | "dashboard")[];
export type SubscriptionPeriod = (typeof SUBSCRIPTION_PERIODS)[number];

export const isSubscriptionPeriod = (value: unknown): value is SubscriptionPeriod =>
  (SUBSCRIPTION_PERIODS as readonly unknown[]).includes(value);

/** People one subscription emails. */
export const MAX_DASHBOARD_EMAIL_RECIPIENTS = 50;
/** Subscriptions one dashboard may have. */
export const MAX_DASHBOARD_EMAILS = 20;

/** The period a new subscription starts with: the whole one that just ended when it is sent. */
export function defaultSubscriptionPeriod(frequency: RepeatFrequency): SubscriptionPeriod {
  switch (frequency) {
    case "daily":
      return "yesterday";
    case "weekly":
      return "last_week";
    case "monthly":
      return "last_month";
    case "yearly":
      return "last_year";
  }
}

/**
 * The dashboard period an email due `at` shows: the day before `at` in `timeZone` for "yesterday"
 * (a range of one day, so its figures compare with the day before it), the dashboard's own saved
 * period for "dashboard", else the relative one. Relative periods are counted from `at` too.
 */
export function emailPeriod(choice: SubscriptionPeriod, dashboardPeriod: string, at: Date, timeZone: string): DashboardPeriod {
  if (choice === "dashboard") return readDashboardPeriod(dashboardPeriod) ?? { kind: "all" };
  if (choice === "yesterday") {
    const day = dayString(localDay(at.getTime(), timeZone) - 1);
    return { kind: "custom", start: day, end: day };
  }
  return { kind: choice };
}

const ID = /^[\w-]{1,64}$/;

/** A target from stored or submitted JSON, or null when it names none. */
export function readDashboardEmailTarget(value: unknown): DashboardEmailTarget | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { block, view } = value as Record<string, unknown>;
  if (typeof block === "string" && ID.test(block) && view === undefined) return { block };
  if (typeof view === "string" && ID.test(view) && block === undefined) return { view };
  return null;
}

export const sameTarget = (a: DashboardEmailTarget, b: DashboardEmailTarget) =>
  ("block" in a ? `b:${a.block}` : `v:${a.view}`) === ("block" in b ? `b:${b.block}` : `v:${b.view}`);

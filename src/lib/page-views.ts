import type { AnalyticsPeriod } from "./analytics";

/**
 * Page views (server/page-views.ts): who opened which page, database or row in the app, kept as one
 * count per page, person and UTC day. Shared by the browser, which sends a view after the page has
 * loaded, and the server, which records it.
 */

/**
 * Opening the same page again within this long isn't another view: the browser doesn't send it,
 * and the server doesn't count one it gets anyway (a reload, a second tab).
 */
export const VIEW_REPEAT_MS = 5 * 60 * 1000;

/** How long a page stays open before the browser sends its view, so pages passed through aren't counted. */
export const VIEW_SEND_DELAY_MS = 2000;

/** How long views are kept: the retention sweep deletes the days before. */
export const PAGE_VIEW_RETENTION_DAYS = 365;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The UTC day a moment falls on, as views are counted: "YYYY-MM-DD". */
export const viewDay = (at: Date) => at.toISOString().slice(0, 10);

/** The first day of a period of `days` days that ends with `now`'s day. */
export const firstViewDay = (now: Date, days: number) => viewDay(new Date(now.getTime() - (days - 1) * DAY_MS));

/** The last day retention keeps; earlier ones are deleted. */
export const oldestKeptViewDay = (now: Date) => firstViewDay(now, PAGE_VIEW_RETENTION_DAYS);

/** Whether the browser sends a view of a page it last sent one for at `lastSentAt` (never: undefined). */
export function shouldSendView(lastSentAt: number | undefined, now: number): boolean {
  return lastSentAt === undefined || now - lastSentAt >= VIEW_REPEAT_MS || now < lastSentAt;
}

export type DailyViews = { day: string; views: number };

/** Views per day over the period that ends with `now`'s day, oldest first, days without any as 0. */
export function dailySeries(rows: readonly DailyViews[], now: Date, days: number): DailyViews[] {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.day, (counts.get(row.day) ?? 0) + Number(row.views));
  const start = new Date(`${firstViewDay(now, days)}T00:00:00Z`).getTime();
  return Array.from({ length: days }, (_, i) => {
    const day = viewDay(new Date(start + i * DAY_MS));
    return { day, views: counts.get(day) ?? 0 };
  });
}

export type PagePerson = { userId: string; name: string; email: string; image: string | null };

/** Someone who opened the page in the period: how many times, and when last. */
export type PageViewer = PagePerson & { views: number; lastViewedAt: Date };

/** Someone who edited the page in the period (counted as in Settings > Analytics, server/analytics.ts). */
export type PageEditor = PagePerson & { edits: number; lastEditAt: Date };

/**
 * A page's Analytics, for people who may edit it. `recording` false: the workspace doesn't record
 * views, so only the edits are there.
 */
export type PageAnalytics = {
  days: AnalyticsPeriod;
  recording: boolean;
  /** Every view in the period, including those of people who have since left. */
  views: number;
  /** How many different people opened it. */
  viewers: number;
  daily: DailyViews[];
  /** The workspace's members who opened it, most views first. */
  people: PageViewer[];
  editors: PageEditor[];
};

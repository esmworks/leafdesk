import type { WorkspaceRole } from "@/db/schema/app";

/**
 * Settings > Analytics (see server/analytics.ts): how much a workspace's people edited over the
 * last 7, 30 or 90 days, counted from what the workspace already stores, and, while the workspace
 * records them, which pages they opened (page views, lib/page-views.ts). 90 days is as far back as
 * page history keeps ordinary versions (HISTORY_RETENTION), so a longer period would count less
 * the further back it went.
 */
export const ANALYTICS_PERIODS = [7, 30, 90] as const;
export type AnalyticsPeriod = (typeof ANALYTICS_PERIODS)[number];
export const DEFAULT_ANALYTICS_PERIOD: AnalyticsPeriod = 30;

/** The period a `?days=` value asks for; anything else is the default. */
export function parseAnalyticsPeriod(value: unknown): AnalyticsPeriod {
  const days = typeof value === "string" ? Number(value) : value;
  return (ANALYTICS_PERIODS as readonly unknown[]).includes(days) ? (days as AnalyticsPeriod) : DEFAULT_ANALYTICS_PERIOD;
}

/** Where a period that ends `now` starts. */
export function periodStart(now: Date, days: AnalyticsPeriod): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

export type AnalyticsPerson = {
  userId: string;
  name: string;
  email: string;
  image: string | null;
  role: WorkspaceRole;
  edits: number;
  /** How many different pages they edited. */
  pages: number;
  lastEditAt: Date | null;
};

/**
 * One of the most edited pages. `title`, `icon` and `id` are null when the owner asking can't
 * open the page (someone's private page): it is counted, but shown only as "Private page".
 */
export type AnalyticsPage = {
  id: string | null;
  title: string | null;
  icon: string | null;
  kind: string | null;
  edits: number;
  /** How many different people edited it. */
  editors: number;
  lastEditAt: Date;
};

/** A member's page views in the period. Guests' views aren't recorded, so they aren't listed. */
export type AnalyticsViewer = {
  userId: string;
  name: string;
  email: string;
  image: string | null;
  role: WorkspaceRole;
  views: number;
  /** How many different pages they opened. */
  pages: number;
  lastViewAt: Date | null;
};

/** One of the most viewed pages; untitled when the owner asking can't open it, like AnalyticsPage. */
export type AnalyticsViewedPage = {
  id: string | null;
  title: string | null;
  icon: string | null;
  kind: string | null;
  views: number;
  /** How many different people opened it. */
  viewers: number;
  lastViewAt: Date;
};

/** The period's page views; see AnalyticsReport `views`. */
export type AnalyticsViews = {
  /** Every view, including those of people who have since left. */
  total: number;
  /** How many different people opened a page. */
  viewers: number;
  pagesViewed: number;
  /** The workspace's owners and members, most views first. */
  people: AnalyticsViewer[];
  pages: AnalyticsViewedPage[];
};

export type AnalyticsReport = {
  days: AnalyticsPeriod;
  since: Date;
  /** Whether the workspace records page views (WorkspaceSettings `pageViews`). */
  recording: boolean;
  /** The period's page views; null while the workspace doesn't record them. */
  views: AnalyticsViews | null;
  /** Every edit in the period, including those of people who have since left. */
  totalEdits: number;
  pagesEdited: number;
  /** Owners and members with at least one edit, out of `memberCount`. Guests are listed, not counted. */
  activeMembers: number;
  memberCount: number;
  /** Everyone in the workspace, most edits first. */
  people: AnalyticsPerson[];
  pages: AnalyticsPage[];
};

export const ANALYTICS_TABLES = ["members", "pages", "viewers", "viewed"] as const;
export type AnalyticsTable = (typeof ANALYTICS_TABLES)[number];
export const isAnalyticsTable = (value: unknown): value is AnalyticsTable => (ANALYTICS_TABLES as readonly unknown[]).includes(value);

type Cell = string | number | Date | null;

/**
 * One of the report's tables as spreadsheet rows. Pages the owner can't open keep their counts
 * but have no title (`private` says why), the same as on screen.
 */
export function analyticsCsvRows(report: AnalyticsReport, table: AnalyticsTable): Cell[][] {
  if (table === "members") {
    return [
      ["name", "email", "role", "edits", "pages_edited", "last_edited_at"],
      ...report.people.map((p) => [p.name, p.email, p.role, p.edits, p.pages, p.lastEditAt]),
    ];
  }
  if (table === "viewers") {
    return [
      ["name", "email", "role", "views", "pages_viewed", "last_viewed_at"],
      ...(report.views?.people ?? []).map((p) => [p.name, p.email, p.role, p.views, p.pages, p.lastViewAt]),
    ];
  }
  if (table === "viewed") {
    return [
      ["title", "private", "views", "viewers", "last_viewed_at"],
      ...(report.views?.pages ?? []).map((p) => [p.id ? p.title : null, p.id ? "no" : "yes", p.views, p.viewers, p.lastViewAt]),
    ];
  }
  return [
    ["title", "private", "edits", "editors", "last_edited_at"],
    ...report.pages.map((p) => [p.id ? p.title : null, p.id ? "no" : "yes", p.edits, p.editors, p.lastEditAt]),
  ];
}

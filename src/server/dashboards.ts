import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { page } from "@/db/schema";
import type { PropertyOptions, PropertyType } from "@/db/schema/app";
import type { AggregateResult } from "@/lib/aggregate";
import {
  canStack,
  chartAccumulateOf,
  chartData,
  chartGroupProperty,
  chartMeasure,
  chartTypeOf,
  isStackable,
  measureRows,
  withoutRows,
  type ChartData,
} from "@/lib/chart";
import { isComputedWidget, LIST_WIDGET_ROWS, MAX_WIDGETS, WIDGET_DRILL_ROWS, widgetStamp } from "@/lib/dashboard";
import {
  comparisonOf,
  isPeriodPropertyType,
  periodProperty,
  periodRange,
  previousRange,
  withPeriod,
  type DashboardPeriod,
  type DayRange,
} from "@/lib/dashboard-period";
import type { LinkedView } from "@/lib/embed-blocks";
import type { GroupContext } from "@/lib/grouping";
import { applyView } from "@/lib/properties";
import { holdsPeople } from "@/lib/property-types";
import { timestampDay } from "@/lib/time-zone";
import { AccessError, pageVisibleTo } from "@/server/access";
import * as databases from "@/server/databases";

/**
 * What dashboard widgets show (see lib/dashboard), worked out on the server for one viewer: the
 * rows they may see (databases.listRows: page and row access, property access, the view's filters
 * and sorts on what they may see), measured, grouped or cut to the first few, so only what a widget
 * draws leaves the server.
 *
 * Nothing here knows the block, the page or the browser: a widget is a database and a view, read
 * for a viewer. Anything that shows workspace data in the viewer's name (dashboards, and later
 * code someone writes against the workspace) asks through these functions.
 */

export type WidgetViewer = { userId: string };
export type WidgetSource = { databaseId: string; view: LinkedView };
export type WidgetOptions = {
  /**
   * The viewer's time zone (IANA): relative date filters ("today") count from their day there, and
   * times (dates, created and edited times) filter and group by their day there. UTC when left out.
   */
  timeZone?: string;
  /** The dashboard's period (lib/dashboard-period): rows are cut to its days in the time zone. All time when left out. */
  period?: DashboardPeriod;
  /** When the period is counted from; now when left out. */
  now?: Date;
};

/**
 * How the dashboard's period applied to a widget: the property and days its rows were cut to, or
 * `property` null when the widget leaves the period aside (it shows every row, or its database has
 * no date the reader can see). Missing for all time.
 */
export type WidgetPeriod = { property: { id: string; name: string } | null; range: DayRange };

/** A property a widget draws with: what it groups or stacks by, or what it measures. */
export type WidgetProperty = { id: string; name: string; type: PropertyType; options: PropertyOptions };
export type WidgetRow = { id: string; title: string; icon: string | null };

export type WidgetData =
  /** Missing, not a database, or not one the viewer may see: nothing about it is said. */
  | { state: "unavailable" }
  | ({
      state: "ok";
      database: { id: string; workspaceId: string; title: string; icon: string | null; inTrash: boolean };
      /** Rows the view shows (after its filters). */
      rowCount: number;
      /** What the browser needs to name and format what it gets (lib/chart chartMeasure and labels). */
      properties: WidgetProperty[];
      period?: WidgetPeriod;
      /** The properties a period can cut this widget's rows on, for its settings. */
      dateProperties: { id: string; name: string; type: PropertyType }[];
    } & (
      | {
          kind: "number";
          result: AggregateResult | null;
          /** The same figure over the period before (lib/dashboard-period previousRange), when the widget compares. */
          previous?: { result: AggregateResult | null; range: DayRange };
        }
      /** `chart` is null when the database has nothing to group by. */
      | { kind: "chart"; chart: ChartData<never> | null; groupById: string | null; stackById: string | null }
      | { kind: "list"; rows: WidgetRow[] }
      /** Other layouts show as a linked view, loaded by the browser the usual way. */
      | { kind: "view" }
    ));

/** Which rows of a widget to list: a group's (and a stack series'), or all of them (a number). */
export type WidgetTarget = { groupKey?: string; seriesKey?: string };

export function validTimeZone(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.length > 64) return undefined;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return value;
  } catch {
    return undefined;
  }
}

/** The database a widget reads, or null when the viewer may not see it (the same answer for missing ones). */
async function load(viewer: WidgetViewer, databaseId: string) {
  try {
    return await databases.getDatabase(viewer.userId, databaseId);
  } catch (error) {
    if (error instanceof AccessError || (error as { code?: unknown }).code === "notADatabase") return null;
    throw error;
  }
}

/** The widget's chart, measured over the rows the viewer sees; null when it has nothing to group by. */
async function worked(viewer: WidgetViewer, source: WidgetSource, options: WidgetOptions) {
  const found = await load(viewer, source.databaseId);
  if (!found) return null;
  const { database, properties } = found;
  const config = source.view.config;
  // Days are the viewer's: "today" in a filter, the dashboard's period, and the day a time falls on.
  const timeZone = validTimeZone(options.timeZone) ?? "UTC";
  const now = options.now ?? new Date();
  const measure = chartMeasure(config, properties);
  const chartType = chartTypeOf(config);
  const range = options.period ? periodRange(options.period, now, timeZone) : null;
  const by = range ? periodProperty(properties, config.periodBy) : null;
  // A number compares with the period before: both are read at once (the one comes right before
  // the other) and told apart here.
  const before =
    by && options.period && source.view.type === "chart" && chartType === "number" && comparisonOf(config) !== "off"
      ? previousRange(options.period, now, timeZone)
      : null;
  const read = { filters: config.filters, filterCombinator: config.filterCombinator, sorts: config.sorts };
  const all = await databases.viewedRows(
    viewer.userId,
    database.id,
    range && by ? withPeriod(read, by.id, before ? { start: before.start, end: range.end } : range) : read,
    undefined,
    { timeZone, now },
  );
  const within = (days: DayRange) => applyView(all, { ...withPeriod({}, by!.id, days), showOutdated: true }, properties, { timeZone, now });
  const rows = before && range ? within(range) : all;
  const period: WidgetPeriod | undefined = range ? { property: by && { id: by.id, name: by.name }, range } : undefined;
  const previous = before ? { rows: within(before), range: before } : undefined;
  const groupBy = chartType === "number" ? null : chartGroupProperty(properties, config);
  const stackBy =
    (groupBy &&
      !chartAccumulateOf(config, groupBy, measure) &&
      properties.find((p) => p.id === config.stackBy && p.id !== groupBy.id && isStackable(p.type) && canStack(chartType, measure))) ||
    null;
  // Person groups are named from the workspace's people, relation groups from the related rows.
  const grouping = [groupBy, stackBy].filter((p) => !!p);
  const [people, lookups] = await Promise.all([
    grouping.some((p) => holdsPeople(p.type)) ? databases.getPeople(viewer.userId, properties) : [],
    grouping.some((p) => p.type === "relation") ? databases.getLookups(viewer.userId, properties) : null,
  ]);
  const contextFor = (prop: { id: string; type: PropertyType }): GroupContext => ({
    people: people.map((p) => ({ id: p.id, name: p.name, active: p.active })),
    relationRows: prop.type === "relation" ? (lookups?.relations[prop.id]?.rows ?? []) : undefined,
    dayOf: (value) => timestampDay(value, timeZone),
  });
  const chart =
    source.view.type === "chart" && groupBy
      ? chartData(rows, { groupBy, stackBy, measure, config, context: contextFor(groupBy), ...(stackBy ? { stackContext: contextFor(stackBy) } : {}) })
      : null;
  const used = new Set([groupBy?.id, stackBy?.id, measure.kind === "aggregate" ? measure.prop.id : undefined].filter(Boolean));
  return {
    database,
    rows,
    period,
    previous,
    measure,
    chartType,
    chart,
    groupBy,
    stackBy,
    properties: properties.filter((p) => used.has(p.id)).map(({ id, name, type, options }) => ({ id, name, type, options })),
    dateProperties: dateProperties(properties),
  };
}

const dateProperties = (properties: { id: string; name: string; type: PropertyType }[]) =>
  properties.filter((p) => isPeriodPropertyType(p.type)).map(({ id, name, type }) => ({ id, name, type }));

const rowRef = (r: { id: string; title: string; icon: string | null }): WidgetRow => ({ id: r.id, title: r.title, icon: r.icon });

/** What a widget draws, for `viewer`. */
export async function widgetData(viewer: WidgetViewer, source: WidgetSource, options: WidgetOptions = {}): Promise<WidgetData> {
  const type = source.view.type;
  if (!isComputedWidget(type)) {
    // Shown as a linked view, which loads and checks access on its own: only say whether it may.
    // It shows the dashboard's period through the rules this says (lib/dashboard-period withPeriod).
    const found = await load(viewer, source.databaseId);
    if (!found) return { state: "unavailable" };
    const timeZone = validTimeZone(options.timeZone) ?? "UTC";
    const range = options.period ? periodRange(options.period, options.now ?? new Date(), timeZone) : null;
    const by = range && periodProperty(found.properties, source.view.config.periodBy);
    return {
      state: "ok",
      database: header(found.database),
      rowCount: 0,
      properties: [],
      dateProperties: dateProperties(found.properties),
      ...(range ? { period: { property: by ? { id: by.id, name: by.name } : null, range } } : {}),
      kind: "view",
    };
  }
  const work = await worked(viewer, source, options);
  if (!work) return { state: "unavailable" };
  const base = {
    state: "ok" as const,
    database: header(work.database),
    rowCount: work.rows.length,
    properties: work.properties,
    dateProperties: work.dateProperties,
    ...(work.period ? { period: work.period } : {}),
  };
  if (type === "list") return { ...base, kind: "list", rows: work.rows.slice(0, LIST_WIDGET_ROWS).map(rowRef) };
  if (work.chartType === "number") {
    const previous = work.previous && { result: measureRows(work.previous.rows, work.measure), range: work.previous.range };
    return { ...base, kind: "number", result: measureRows(work.rows, work.measure), ...(previous ? { previous } : {}) };
  }
  return {
    ...base,
    kind: "chart",
    chart: work.chart ? withoutRows(work.chart) : null,
    groupById: work.groupBy?.id ?? null,
    stackById: work.stackBy?.id ?? null,
  };
}

/**
 * The rows behind part of a widget, for `viewer`: a bar, point or slice (`groupKey`), one segment
 * of a stacked bar (and `seriesKey`), or every row of a number or list. The first
 * WIDGET_DRILL_ROWS of them, in the view's order, and how many there are.
 */
export async function widgetRows(
  viewer: WidgetViewer,
  source: WidgetSource,
  target: WidgetTarget,
  options: WidgetOptions = {},
): Promise<{ rows: WidgetRow[]; total: number } | null> {
  if (!isComputedWidget(source.view.type)) return null;
  const work = await worked(viewer, source, options);
  if (!work) return null;
  let rows = work.rows;
  if (target.groupKey !== undefined && work.chart) {
    const group = work.chart.groups.find((g) => g.key === target.groupKey);
    if (!group) return { rows: [], total: 0 };
    const index = target.seriesKey === undefined ? -1 : work.chart.series.findIndex((s) => s.key === target.seriesKey);
    rows = index >= 0 ? (group.segments[index]?.rows ?? []) : group.rows;
  }
  return { rows: rows.slice(0, WIDGET_DRILL_ROWS).map(rowRef), total: rows.length };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The stamps (lib/dashboard widgetStamp) of these databases for `viewer`, in one query: what the
 * browser compares after the page tree changed, so only widgets whose database changed ask again.
 * Databases the viewer can't see, and ids that aren't databases, stamp as "none", as their widgets
 * do: nothing about them is said.
 */
export async function widgetStamps(viewer: WidgetViewer, databaseIds: string[]): Promise<Record<string, string>> {
  const ids = [...new Set(databaseIds)].filter((id) => UUID.test(id)).slice(0, MAX_WIDGETS);
  const found = ids.length
    ? await db
        .select({ id: page.id, title: page.title, icon: page.icon, archivedAt: page.archivedAt })
        .from(page)
        .where(and(inArray(page.id, ids), eq(page.kind, "database"), pageVisibleTo(viewer.userId)))
    : [];
  const stamps: Record<string, string> = Object.fromEntries(ids.map((id) => [id, widgetStamp(null)]));
  for (const d of found) stamps[d.id] = widgetStamp({ title: d.title, icon: d.icon, inTrash: !!d.archivedAt });
  return stamps;
}

function header(database:{ id: string; workspaceId: string; title: string; icon: string | null; archivedAt: Date | null }) {
  return { id: database.id, workspaceId: database.workspaceId, title: database.title, icon: database.icon, inTrash: !!database.archivedAt };
}

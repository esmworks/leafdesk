import type {
  CalendarMode,
  CardSize,
  ChartAccumulate,
  ChartSort,
  ChartType,
  GroupDateBy,
  OpenRows,
  SortRule,
  SubItemsDisplay,
  TimelineZoom,
  ViewConfig,
  ViewCover,
  ViewType,
  ViewWidget,
} from "@/db/schema/app";
import { colorRulesConfigError } from "./color-rules";
import { CHART_ACCUMULATES, CHART_SORTS, CHART_TYPES, isBoardAggregateFn, isChartAggregateFn } from "./chart";
import { COMPARISONS, DASHBOARD_PERIODS, readDashboardPeriod } from "./dashboard-period-value";
import { filterConfigError } from "./filters";
import { formConfigError } from "./forms";
import { GROUP_DATE_BY } from "./grouping";
import { isLoadLimit, LOAD_LIMITS } from "./load-limit";
import { CREATED_KEY, SELECT_COLORS } from "./properties";
import { SUB_ITEMS_DISPLAYS } from "./sub-items";

/** Every kind of database view, in the order the "Add a view" menu lists them. */
export const VIEW_TYPES = [
  "table",
  "board",
  "calendar",
  "gallery",
  "list",
  "feed",
  "timeline",
  "map",
  "chart",
  "pivot",
  "dashboard",
  "form",
] as const satisfies readonly ViewType[];
/**
 * Views that show inside something else: linked view blocks and dashboard widgets. Forms show no
 * rows, and a dashboard is made of such views itself.
 */
export const LINKED_VIEW_TYPES = VIEW_TYPES.filter((type) => type !== "form" && type !== "dashboard");
export const CARD_SIZES = ["small", "medium", "large"] as const satisfies readonly CardSize[];
export const COVER_SOURCES = ["first_image", "property", "none"] as const satisfies readonly ViewCover["source"][];
export const TIMELINE_ZOOMS = ["day", "week", "month", "quarter", "year"] as const satisfies readonly TimelineZoom[];
export const CALENDAR_MODES = ["month", "week"] as const satisfies readonly CalendarMode[];
export const OPEN_ROWS = ["panel", "center", "page"] as const satisfies readonly OpenRows[];
/** The views whose rows open from them; forms have none and charts list theirs as links. */
export const ROW_VIEW_TYPES = ["table", "board", "calendar", "gallery", "list", "feed", "timeline", "map"] as const satisfies readonly ViewType[];

/** How narrow and how wide a table column may be saved (the table keeps a dragged column within these). */
export const MIN_COLUMN_WIDTH = 60;
export const MAX_COLUMN_WIDTH = 1000;

export function isViewType(value: unknown): value is ViewType {
  return VIEW_TYPES.includes(value as ViewType);
}

/** Default English names for views created without one (the UI names them in its own language). */
export const DEFAULT_VIEW_NAMES: Record<ViewType, string> = {
  table: "Table",
  board: "Board",
  calendar: "Calendar",
  gallery: "Gallery",
  list: "List",
  feed: "Feed",
  timeline: "Timeline",
  map: "Map",
  chart: "Chart",
  pivot: "Pivot",
  dashboard: "Dashboard",
  form: "Form",
};

/** Whether a view of this type opens rows (see ROW_VIEW_TYPES). */
export function opensRows(type: ViewType): boolean {
  return (ROW_VIEW_TYPES as readonly ViewType[]).includes(type);
}

/** What a feed shows first while its view sorts by nothing: the newest post. */
export const FEED_SORTS: readonly SortRule[] = [{ propertyId: CREATED_KEY, direction: "desc" }];

/**
 * A view's settings with the order its rows show in: its own sorts, or for a feed without any,
 * newest first (a feed reads as a stream of posts, not in the order rows were dragged into).
 */
export function withViewSorts<C extends Pick<ViewConfig, "sorts">>(view: { type: ViewType; config: C }): C {
  return view.type === "feed" && !view.config.sorts?.length ? { ...view.config, sorts: [...FEED_SORTS] } : view.config;
}

/** Where the view opens its rows: a panel beside it unless it was set to open them in the middle of the window or as pages. */
export function openRowsOf(config: Pick<ViewConfig, "openRows">): OpenRows {
  return config.openRows === "page" || config.openRows === "center" ? config.openRows : "panel";
}

export function galleryCover(config: Pick<ViewConfig, "cover">): ViewCover["source"] {
  const source = config.cover?.source;
  return source === "none" || source === "property" ? source : "first_image";
}

/**
 * The files property a gallery takes its covers from, while it still is one; null for the other
 * sources. A cover property that was deleted (or changed) leaves cards without a cover.
 */
export function coverProperty<P extends { id: string; type: string }>(config: Pick<ViewConfig, "cover">, properties: P[]): P | null {
  const cover = config.cover;
  if (cover?.source !== "property") return null;
  return properties.find((p) => p.id === cover.propertyId && p.type === "files") ?? null;
}

/**
 * Why the layout settings of a view config are malformed, or null. Configs come from the client
 * and from MCP, and a bad value would break every viewer. Property ids aren't checked here: views
 * fall back to a default when a property is missing (e.g. deleted meanwhile).
 */
export function layoutConfigError(config: ViewConfig): string | null {
  const c = config as Record<string, unknown>;
  for (const key of ["groupBy", "subGroupBy", "dateBy", "endDateBy", "stackBy", "placeBy", "columnBy", "periodBy"] as const) {
    if (c[key] !== undefined && typeof c[key] !== "string") return `${key} must be a property id`;
  }
  if (c.subItems !== undefined && !SUB_ITEMS_DISPLAYS.includes(c.subItems as SubItemsDisplay)) {
    return `subItems must be one of: ${SUB_ITEMS_DISPLAYS.join(", ")}`;
  }
  if (c.zoom !== undefined && !TIMELINE_ZOOMS.includes(c.zoom as TimelineZoom)) {
    return `Zoom must be one of: ${TIMELINE_ZOOMS.join(", ")}`;
  }
  if (c.calendarMode !== undefined && !CALENDAR_MODES.includes(c.calendarMode as CalendarMode)) {
    return `Calendar mode must be one of: ${CALENDAR_MODES.join(", ")}`;
  }
  if (c.openRows !== undefined && !OPEN_ROWS.includes(c.openRows as OpenRows)) {
    return `openRows must be one of: ${OPEN_ROWS.join(", ")}`;
  }
  for (const key of ["showTable", "showValues", "showLegend", "showWeekends", "showIcons", "wrapProperties", "showVerticalLines", "colorColumns", "showTotals"] as const) {
    if (c[key] !== undefined && typeof c[key] !== "boolean") return `${key} must be true or false`;
  }
  if (c.defaultTemplateId !== undefined && c.defaultTemplateId !== null && (typeof c.defaultTemplateId !== "string" || !c.defaultTemplateId)) {
    return "defaultTemplateId must be a row template's id, or null for blank rows";
  }
  if (c.loadLimit !== undefined && !isLoadLimit(c.loadLimit)) return `Load limit must be one of: ${LOAD_LIMITS.join(", ")}`;
  if (c.cardSize !== undefined && !CARD_SIZES.includes(c.cardSize as CardSize)) {
    return `Card size must be one of: ${CARD_SIZES.join(", ")}`;
  }
  if (c.cover !== undefined) {
    const cover = c.cover as { source?: unknown; propertyId?: unknown } | null;
    if (!cover || typeof cover !== "object" || !COVER_SOURCES.includes(cover.source as ViewCover["source"])) {
      return `Cover must be one of: ${COVER_SOURCES.join(", ")}`;
    }
    if (cover.source === "property" && (typeof cover.propertyId !== "string" || !cover.propertyId)) {
      return "A property cover must name a files property id";
    }
  }
  if (c.chartType !== undefined && !CHART_TYPES.includes(c.chartType as ChartType)) {
    return `Chart type must be one of: ${CHART_TYPES.join(", ")}`;
  }
  if (c.chartSort !== undefined && !CHART_SORTS.includes(c.chartSort as ChartSort)) {
    return `Chart sort must be one of: ${CHART_SORTS.join(", ")}`;
  }
  if (c.chartAccumulate !== undefined && !CHART_ACCUMULATES.includes(c.chartAccumulate as ChartAccumulate)) {
    return `Chart running totals must be one of: ${CHART_ACCUMULATES.join(", ")}`;
  }
  if (c.columnDateBy !== undefined && !GROUP_DATE_BY.includes(c.columnDateBy as GroupDateBy)) {
    return `columnDateBy must be one of: ${GROUP_DATE_BY.join(", ")}`;
  }
  if (c.columnStatusBy !== undefined && c.columnStatusBy !== "option" && c.columnStatusBy !== "group") {
    return "columnStatusBy must be option or group";
  }
  if (c.columnSort !== undefined && !CHART_SORTS.includes(c.columnSort as ChartSort)) {
    return `Column sort must be one of: ${CHART_SORTS.join(", ")}`;
  }
  if (c.comparison !== undefined && !(COMPARISONS as readonly unknown[]).includes(c.comparison)) {
    return `comparison must be one of: ${COMPARISONS.join(", ")}`;
  }
  if (c.period !== undefined && !readDashboardPeriod(c.period)) {
    return `period must be one of ${DASHBOARD_PERIODS.join(", ")}, or two days as YYYY-MM-DD/YYYY-MM-DD`;
  }
  if (c.chartAggregate !== undefined) {
    const agg = c.chartAggregate as { fn?: unknown; propertyId?: unknown } | null;
    if (!agg || typeof agg !== "object" || typeof agg.propertyId !== "string" || !agg.propertyId) {
      return "chartAggregate must name a property id and a calculation";
    }
    if (!isChartAggregateFn(agg.fn)) return `Charts can't measure "${String(agg.fn)}"`;
  }
  if (c.boardAggregate !== undefined) {
    const agg = c.boardAggregate as { fn?: unknown; propertyId?: unknown } | null;
    if (!agg || typeof agg !== "object" || typeof agg.propertyId !== "string" || !agg.propertyId) {
      return "boardAggregate must name a property id and a calculation";
    }
    if (!isBoardAggregateFn(agg.fn)) return `Board columns can't calculate "${String(agg.fn)}"`;
  }
  // Charts read these to lay out their groups; a stray value would break every viewer.
  for (const key of ["groupOrder", "hiddenGroups", "collapsedSubGroups"] as const) {
    const keys = c[key];
    if (keys !== undefined && (!Array.isArray(keys) || !keys.every((k) => typeof k === "string"))) {
      return `${key} must be a list of group keys`;
    }
  }
  const widths = c.columnWidths;
  if (
    widths !== undefined &&
    (!widths || typeof widths !== "object" || Array.isArray(widths) || !Object.values(widths).every((w) => typeof w === "number" && w >= MIN_COLUMN_WIDTH && w <= MAX_COLUMN_WIDTH))
  ) {
    return "columnWidths must map column ids to widths in pixels";
  }
  const order = c.propertyOrder;
  if (order !== undefined && (!Array.isArray(order) || !order.every((id) => typeof id === "string"))) {
    return "propertyOrder must be a list of property ids";
  }
  if (c.frozenThrough !== undefined && (typeof c.frozenThrough !== "string" || !c.frozenThrough)) {
    return "frozenThrough must be a column id";
  }
  const wrapped = c.wrapped;
  if (wrapped !== undefined && (!Array.isArray(wrapped) || !wrapped.every((id) => typeof id === "string"))) {
    return "wrapped must be a list of column ids";
  }
  if (c.widgets !== undefined) {
    const error = widgetsConfigError(c.widgets);
    if (error) return error;
  }
  const colorError = colorRulesConfigError(c.colorRules);
  if (colorError) return colorError;
  return formConfigError(c.form);
}

// ---------------------------------------------------------------------------------------------
// Dashboards (see lib/dashboard): the widget limits live here so view configs can be checked
// without the dashboard module, which builds on linked views and so on this one.

/** Columns of a dashboard's grid on wide screens; widgets take 1 to 4 of them, phones show one per row. */
export const DASHBOARD_COLUMNS = 4;
export const WIDGET_SPANS = [1, 2, 3, 4] as const;
export type WidgetSpan = (typeof WIDGET_SPANS)[number];
/** Widgets per dashboard: each one is a query when the page opens and whenever its database changes. */
export const MAX_WIDGETS = 12;
export const MAX_WIDGET_TITLE = 120;
export const WIDGET_ID = /^[\w-]{1,64}$/;

/**
 * Why a dashboard view's widgets are malformed, or null. Each widget is a view of the dashboard's
 * own database, so it names none; its settings are checked as any view's.
 */
function widgetsConfigError(value: unknown): string | null {
  if (!Array.isArray(value)) return "widgets must be a list";
  if (value.length > MAX_WIDGETS) return `A dashboard holds up to ${MAX_WIDGETS} widgets`;
  const ids = new Set<string>();
  for (const item of value as unknown[]) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return "Each widget must be an object";
    const { id, title, span, color, view, ...rest } = item as Record<string, unknown>;
    if (typeof id !== "string" || !WIDGET_ID.test(id)) return "Each widget needs an id of letters, digits, - or _";
    if (ids.has(id)) return `Two widgets have the id "${id}"`;
    ids.add(id);
    if (Object.keys(rest).length) return `Widget "${id}": unknown setting "${Object.keys(rest)[0]}"`;
    if (title !== undefined && (typeof title !== "string" || title.length > MAX_WIDGET_TITLE)) {
      return `Widget "${id}": the title must be text of up to ${MAX_WIDGET_TITLE} characters`;
    }
    if (!WIDGET_SPANS.includes(span as WidgetSpan)) return `Widget "${id}": span must be one of ${WIDGET_SPANS.join(", ")}`;
    if (color !== undefined && !(SELECT_COLORS as readonly unknown[]).includes(color)) {
      return `Widget "${id}": color must be one of ${SELECT_COLORS.join(", ")}`;
    }
    const v = view as { type?: unknown; config?: unknown } | null;
    if (!v || typeof v !== "object" || !(LINKED_VIEW_TYPES as readonly unknown[]).includes(v.type)) {
      return `Widget "${id}": the view must be one of ${LINKED_VIEW_TYPES.join(", ")}`;
    }
    const config = v.config;
    if (!config || typeof config !== "object" || Array.isArray(config)) return `Widget "${id}": the view's config must be an object`;
    if ((config as ViewConfig).widgets !== undefined) return `Widget "${id}": a widget holds no widgets`;
    const error = filterConfigError(config as ViewConfig) || layoutConfigError(config as ViewConfig);
    if (error) return `Widget "${id}": ${error}`;
  }
  return null;
}

/**
 * A view's settings with `change` applied to each of its widgets' settings too (dashboard views):
 * what is done to the properties a view names (deleting, copying, retyping, hiding them) is done
 * to what its widgets name.
 */
export function withWidgetConfigs(config: ViewConfig, change: (config: ViewConfig) => ViewConfig): ViewConfig {
  if (!config.widgets?.length) return config;
  return { ...config, widgets: config.widgets.map((w): ViewWidget => ({ ...w, view: { ...w.view, config: change(w.view.config) } })) };
}

/** A view's own settings and its widgets', for reading what they name (people in filters, say). */
export function configsOf(config: ViewConfig): ViewConfig[] {
  return [config, ...(config.widgets ?? []).map((w) => w.view.config)];
}

/**
 * The property a calendar or timeline view places rows by: the one its settings name (`dateBy`)
 * when `accepts` takes it, else the first date property. A calendar takes dates only (the
 * default); a timeline also starts bars at created and edited times.
 */
export function viewDateProperty<P extends { id: string; type: string }>(
  config: ViewConfig,
  properties: P[],
  accepts: (property: P) => boolean = (p) => p.type === "date",
): P | undefined {
  return properties.find((p) => p.id === config.dateBy && accepts(p)) ?? properties.find((p) => p.type === "date");
}

/**
 * The place property a map view puts rows on: the one its settings name (`placeBy`) while it is
 * still a place property, else the first place property.
 */
export function viewPlaceProperty<P extends { id: string; type: string }>(config: Pick<ViewConfig, "placeBy">, properties: P[]): P | undefined {
  return properties.find((p) => p.id === config.placeBy && p.type === "place") ?? properties.find((p) => p.type === "place");
}

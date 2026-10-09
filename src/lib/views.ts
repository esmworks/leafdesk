import type {
  CardSize,
  ChartAccumulate,
  ChartSort,
  ChartType,
  SubItemsDisplay,
  TimelineZoom,
  ViewConfig,
  ViewCover,
  ViewType,
} from "@/db/schema/app";
import { CHART_ACCUMULATES, CHART_SORTS, CHART_TYPES, isChartAggregateFn } from "./chart";
import { formConfigError } from "./forms";
import { SUB_ITEMS_DISPLAYS } from "./sub-items";

/** Every kind of database view, in the order the "Add a view" menu lists them. */
export const VIEW_TYPES = ["table", "board", "calendar", "gallery", "list", "timeline", "chart", "form"] as const satisfies readonly ViewType[];
export const CARD_SIZES = ["small", "medium", "large"] as const satisfies readonly CardSize[];
export const COVER_SOURCES = ["first_image", "property", "none"] as const satisfies readonly ViewCover["source"][];
export const TIMELINE_ZOOMS = ["day", "week", "month"] as const satisfies readonly TimelineZoom[];

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
  timeline: "Timeline",
  chart: "Chart",
  form: "Form",
};

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
  for (const key of ["groupBy", "dateBy", "endDateBy", "stackBy"] as const) {
    if (c[key] !== undefined && typeof c[key] !== "string") return `${key} must be a property id`;
  }
  if (c.subItems !== undefined && !SUB_ITEMS_DISPLAYS.includes(c.subItems as SubItemsDisplay)) {
    return `subItems must be one of: ${SUB_ITEMS_DISPLAYS.join(", ")}`;
  }
  if (c.zoom !== undefined && !TIMELINE_ZOOMS.includes(c.zoom as TimelineZoom)) {
    return `Zoom must be one of: ${TIMELINE_ZOOMS.join(", ")}`;
  }
  for (const key of ["showTable", "showValues", "showLegend"] as const) {
    if (c[key] !== undefined && typeof c[key] !== "boolean") return `${key} must be true or false`;
  }
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
  if (c.chartAggregate !== undefined) {
    const agg = c.chartAggregate as { fn?: unknown; propertyId?: unknown } | null;
    if (!agg || typeof agg !== "object" || typeof agg.propertyId !== "string" || !agg.propertyId) {
      return "chartAggregate must name a property id and a calculation";
    }
    if (!isChartAggregateFn(agg.fn)) return `Charts can't measure "${String(agg.fn)}"`;
  }
  // Charts read these to lay out their groups; a stray value would break every viewer.
  for (const key of ["groupOrder", "hiddenGroups"] as const) {
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
  return formConfigError(c.form);
}

/**
 * The date property a calendar view places rows by: the one its settings name, else the first of
 * `properties`.
 */
export function viewDateProperty<P extends { id: string; type: string }>(config: ViewConfig, properties: P[]): P | undefined {
  const dates = properties.filter((p) => p.type === "date");
  return dates.find((p) => p.id === config.dateBy) ?? dates[0];
}

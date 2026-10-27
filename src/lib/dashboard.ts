import type { ViewConfig, ViewType, ViewWidget } from "@/db/schema/app";
import { checkLinkedView, LINKED_VIEW_TYPES, type LinkedView } from "./embed-blocks";
import { SELECT_COLORS, UPDATED_KEY } from "./properties";
import { DASHBOARD_COLUMNS, MAX_WIDGET_TITLE, MAX_WIDGETS, WIDGET_ID, WIDGET_SPANS, type WidgetSpan } from "./views";

/**
 * Dashboards: a page block laying out widgets in a grid, each one view of a database the reader
 * can see (any database of the workspace, several per dashboard). A widget is a linked view with a
 * title and a width, nothing more: a number is a chart view of type "number", and the settings of
 * every widget are the ones its database's views have.
 *
 * Numbers, charts and lists are worked out on the server for the reader (server/dashboards
 * widgetData) and only what they draw comes to the browser; other layouts show as linked views.
 * Like a linked view, the block holds only database ids and view settings, never what a database
 * holds, so the page's readers learn nothing of a database they can't see.
 *
 * The block shows its widgets in a grid, or as tabs (`layout` "tabs"): one widget at a time, each
 * named on its tab, as several databases (or views of one) side by side in little room. A reader
 * gets only the tabs whose database they can open. Both are the same widgets, so a block switches
 * between them keeping everything, and the tools that read and change dashboards read and change tabs.
 *
 * A database's dashboard views (view type "dashboard") hold the same widgets in their settings
 * (ViewConfig `widgets`), each a view of that database, so they name none (viewWidgets).
 *
 * Pure: the block config is shared by the editor (components/page/dashboard-block.tsx) and the
 * server (server/blocknote.ts).
 */

export const DASHBOARD_BLOCK = "dashboard";

export const dashboardBlockConfig = {
  type: DASHBOARD_BLOCK,
  // The widgets as JSON (see parseDashboard): block props are flat strings, and keeping them in the
  // block makes them sync, undo and version with the page.
  // The period (lib/dashboard-period) every widget shows, as stored: "" for all time.
  propSchema: { widgets: { default: "" }, layout: { default: "grid" }, period: { default: "" } },
  content: "none",
} as const;

/** How a dashboard block lays its widgets out: in a grid, or as tabs showing one at a time. */
export const DASHBOARD_LAYOUTS = ["grid", "tabs"] as const;
export type DashboardLayout = (typeof DASHBOARD_LAYOUTS)[number];
/** A block's layout prop as it may be read: anything but "tabs" is a grid, as blocks made before tabs are. */
export const dashboardLayout = (value: unknown): DashboardLayout => (value === "tabs" ? "tabs" : "grid");

export { DASHBOARD_COLUMNS, MAX_WIDGET_TITLE, MAX_WIDGETS, WIDGET_SPANS, type WidgetSpan } from "./views";
/**
 * The grid follows the width the page gives it (a container query on DASHBOARD_CLASS), not the
 * window: one column on a phone, two, then four. WIDGET_SPAN_CLASS is how many a widget takes.
 */
export const DASHBOARD_CLASS = "@container w-full min-w-0";
export const DASHBOARD_GRID_CLASS = "grid grid-cols-1 gap-3 @lg:grid-cols-2 @2xl:grid-cols-4";
export const WIDGET_SPAN_CLASS: Record<WidgetSpan, string> = {
  1: "",
  2: "@lg:col-span-2",
  3: "@lg:col-span-2 @2xl:col-span-3",
  4: "@lg:col-span-2 @2xl:col-span-4",
};

/** A widget's color: the option palette's hues, as board columns take them. */
export const WIDGET_COLORS = SELECT_COLORS;
export type WidgetColor = (typeof WIDGET_COLORS)[number];
export const isWidgetColor = (value: unknown): value is WidgetColor => (WIDGET_COLORS as readonly unknown[]).includes(value);

/**
 * A widget's box: a border on the page's background, or with a color its hue's tint (the
 * `.tint-*` palette in globals.css), as a board column of that color.
 */
export function widgetBoxClass(color: WidgetColor | undefined): string {
  return color ? `tint-${color} border-transparent bg-[var(--opt-tint)]` : "border-border bg-bg";
}
/** Rows a list widget shows; the rest are counted. */
export const LIST_WIDGET_ROWS = 8;
/** Rows listed behind a clicked number, bar or slice. */
export const WIDGET_DRILL_ROWS = 50;

export type DashboardWidget = {
  /** Stable within its dashboard: the key of its place, its data and its live updates. */
  id: string;
  databaseId: string;
  /** Shown above the widget; empty for the database's title. */
  title: string;
  span: WidgetSpan;
  /** Tints the widget's box; none keeps it plain. */
  color?: WidgetColor;
  view: LinkedView;
};

/** Layouts the server works out (numbers and charts are both "chart" views). */
export function isComputedWidget(type: ViewType): type is "chart" | "list" {
  return type === "chart" || type === "list";
}

/** The width a new widget of this layout starts at: numbers are small, tables and boards wide. */
export function defaultSpan(view: LinkedView): WidgetSpan {
  if (view.type === "chart") return view.config.chartType === "number" ? 1 : 2;
  return view.type === "list" ? 2 : 4;
}

/** A short id no widget of `taken` has. */
export function newWidgetId(taken: Pick<DashboardWidget, "id">[]) {
  for (;;) {
    const id = crypto.randomUUID().slice(0, 8);
    if (!taken.some((w) => w.id === id)) return id;
  }
}

/** What a new widget shows until it is set up: how many rows the database has. */
export function newWidget(id: string, databaseId: string): DashboardWidget {
  const view: LinkedView = { type: "chart", config: { chartType: "number" } };
  return { id, databaseId, title: "", span: defaultSpan(view), view };
}

/** What a new tab shows until it is set up: its database as a table. */
export function newTab(id: string, databaseId: string): DashboardWidget {
  return { id, databaseId, title: "", span: 4, view: { type: "table", config: {} } };
}

/**
 * The widgets stored in a block. Anyone who may edit the host page can write the prop, so each
 * widget is checked like a linked view (lib/embed-blocks checkLinkedView); malformed widgets,
 * repeated ids and widgets past MAX_WIDGETS are left out.
 */
export function parseDashboard(value: unknown): DashboardWidget[] {
  if (typeof value !== "string" || !value) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const out: DashboardWidget[] = [];
  for (const item of parsed) {
    if (out.length >= MAX_WIDGETS) break;
    const widget = checkWidget(item);
    if (!widget || seen.has(widget.id)) continue;
    seen.add(widget.id);
    out.push(widget);
  }
  return out;
}

/** A stored widget, or null when malformed; `fixed` is the database of a dashboard view's widgets. */
function checkWidget(item: unknown, fixed?: string): DashboardWidget | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const { id, title, span, color, view } = item as Record<string, unknown>;
  const databaseId = fixed ?? (item as Record<string, unknown>).databaseId;
  if (typeof id !== "string" || !WIDGET_ID.test(id) || typeof databaseId !== "string" || !WIDGET_ID.test(databaseId)) return null;
  const checked = checkLinkedView(view);
  if (!(LINKED_VIEW_TYPES as readonly ViewType[]).includes(checked.type)) return null;
  return {
    id,
    databaseId,
    title: typeof title === "string" ? title.slice(0, MAX_WIDGET_TITLE) : "",
    span: WIDGET_SPANS.includes(span as WidgetSpan) ? (span as WidgetSpan) : defaultSpan(checked),
    ...(isWidgetColor(color) ? { color } : {}),
    view: checked,
  };
}

/**
 * A dashboard view's widgets (ViewConfig `widgets`), as views of its database `databaseId`. The
 * server checked them when they were saved (lib/views layoutConfigError); like the block's, they
 * are read leniently all the same.
 */
export function viewWidgets(config: Pick<ViewConfig, "widgets">, databaseId: string): DashboardWidget[] {
  const seen = new Set<string>();
  const out: DashboardWidget[] = [];
  for (const item of Array.isArray(config.widgets) ? config.widgets : []) {
    if (out.length >= MAX_WIDGETS) break;
    const widget = checkWidget(item, databaseId);
    if (!widget || seen.has(widget.id)) continue;
    seen.add(widget.id);
    out.push(widget);
  }
  return out;
}

/** Widgets as a dashboard view stores them: without their database, which is the view's own. */
export const viewWidgetsConfig = (widgets: DashboardWidget[]): ViewWidget[] =>
  widgets.slice(0, MAX_WIDGETS).map(({ id, title, span, color, view }) => ({
    id,
    ...(title ? { title } : {}),
    span,
    ...(color ? { color } : {}),
    view: { type: view.type, config: view.config },
  }));

/** Rows the list widget of a new dashboard view shows: the last edited first. */
export const RECENT_ROWS_SORT = { propertyId: UPDATED_KEY, direction: "desc" } as const;

/**
 * What a new dashboard view starts with, from the properties its maker may know of: how many rows
 * there are, the sum of the first number property, a chart of the rows by the first select or
 * status property, and the rows edited last. Titles stay empty: the app names each widget after
 * what it shows, in the reader's language.
 */
export function defaultDashboardWidgets(properties: { id: string; type: string }[]): ViewWidget[] {
  const amount = properties.find((p) => p.type === "number");
  const groupBy = properties.find((p) => p.type === "select" || p.type === "status");
  const widgets: ViewWidget[] = [{ id: "rows", span: 1, view: { type: "chart", config: { chartType: "number" } } }];
  if (amount) {
    widgets.push({
      id: "total",
      span: 1,
      view: { type: "chart", config: { chartType: "number", chartAggregate: { fn: "sum", propertyId: amount.id } } },
    });
  }
  // The chart (or the list, without one) fills the rest of the first row.
  const rest = Math.max(1, DASHBOARD_COLUMNS - widgets.length) as WidgetSpan;
  if (groupBy) widgets.push({ id: "chart", span: rest, view: { type: "chart", config: { groupBy: groupBy.id } } });
  widgets.push({ id: "recent", span: groupBy ? DASHBOARD_COLUMNS : rest, view: { type: "list", config: { sorts: [{ ...RECENT_ROWS_SORT }] } } });
  return widgets;
}

export const serializeDashboard = (widgets: DashboardWidget[]) =>
  JSON.stringify(
    widgets.slice(0, MAX_WIDGETS).map(({ id, databaseId, title, span, color, view }) => ({
      id,
      databaseId,
      ...(title ? { title } : {}),
      span,
      ...(color ? { color } : {}),
      view: { type: view.type, config: view.config },
    })),
  );

/** The databases a dashboard shows, each once, in order. */
export function dashboardDatabaseIds(widgets: Pick<DashboardWidget, "databaseId">[]): string[] {
  return [...new Set(widgets.map((w) => w.databaseId))];
}

/** What a widget says of its database: its name and icon and whether it is in the trash; null when it can't be seen. */
export type WidgetDatabaseHeader = { title: string; icon: string | null; inTrash: boolean } | null;

/**
 * A database as a widget's reader sees it, in a few characters ("none" when they can't). Rows
 * changing signal on the database's own channel; sharing, trashing, moving and renaming only signal
 * the workspace's page tree, which changes with every page anyone touches. So the browser compares
 * stamps (server/dashboards widgetStamps) and asks again only for widgets whose database changed.
 */
export function widgetStamp(header: WidgetDatabaseHeader): string {
  return header ? JSON.stringify([header.title, header.icon, header.inTrash]) : "none";
}

/** The header a stamp was made from (widgetStamp): null for a database the reader can't see, or a stamp that isn't one. */
export function stampHeader(stamp: string | undefined): WidgetDatabaseHeader {
  if (!stamp || stamp === "none") return null;
  try {
    const [title, icon, inTrash] = JSON.parse(stamp) as unknown[];
    return typeof title === "string" ? { title, icon: typeof icon === "string" ? icon : null, inTrash: inTrash === true } : null;
  } catch {
    return null;
  }
}

/**
 * The widgets to ask again after the page tree changed: those whose database's stamp differs from
 * `now`, and those whose stamp isn't known (still loading, or failed).
 */
export function staleWidgets(shown: { id: string; databaseId: string; stamp: string | null }[], now: Record<string, string>): string[] {
  return shown.filter((w) => w.stamp === null || (now[w.databaseId] ?? "none") !== w.stamp).map((w) => w.id);
}

/** `widgets` with the one whose id is `id` changed by `change` (or taken out when it returns null). */
export function updateWidget(widgets: DashboardWidget[], id: string, change: (widget: DashboardWidget) => DashboardWidget | null) {
  return widgets.flatMap((w) => {
    if (w.id !== id) return [w];
    const next = change(w);
    return next ? [next] : [];
  });
}

/** `widgets` with the widget `id` moved right before or after the widget `target`. */
export function placeWidget(widgets: DashboardWidget[], id: string, target: string, side: "before" | "after") {
  const moving = widgets.find((w) => w.id === id);
  const rest = widgets.filter((w) => w.id !== id);
  const at = rest.findIndex((w) => w.id === target);
  if (!moving || at < 0) return widgets;
  rest.splice(side === "before" ? at : at + 1, 0, moving);
  return rest;
}

/** `widgets` with the one whose id is `id` moved `by` places (clamped to the ends). */
export function moveWidget(widgets: DashboardWidget[], id: string, by: number) {
  const from = widgets.findIndex((w) => w.id === id);
  if (from < 0) return widgets;
  const to = Math.max(0, Math.min(widgets.length - 1, from + by));
  if (to === from) return widgets;
  const next = [...widgets];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

// ---------------------------------------------------------------------------------------------
// Markdown

/**
 * In Markdown (search, history, MCP, export) a dashboard is one line naming its block: what its
 * widgets show is the readers' to look up with their own access, and their settings stay in the
 * page. A body rewritten with the line keeps the dashboard as it was (see restoreDashboards); a
 * line naming no dashboard of the page is dropped, so Markdown never makes one.
 *
 *   <!-- leafdesk:dashboard 7d1c… -->
 */
const DASHBOARD_LINE = /^ {0,3}<!--\s*leafdesk:dashboard\s+([\w-]{1,64})\s*-->\s*$/;

export const dashboardLine = (blockId: string) => `<!-- leafdesk:dashboard ${blockId} -->`;

export function parseDashboardLine(line: string): string | null {
  return DASHBOARD_LINE.exec(line)?.[1] ?? null;
}

/** The ids of the dashboards a page's Markdown names. */
export function markdownDashboards(markdown: string): string[] {
  return markdown.split("\n").flatMap((line) => parseDashboardLine(line) ?? []);
}

type AnyBlock = { id?: string; type: string; props?: Record<string, unknown>; children?: AnyBlock[] };

/**
 * Dashboard blocks parsed from Markdown hold only the id their line named: each becomes the page's
 * dashboard with that id, settings and all, or goes when the page has none (or it is named twice).
 */
export function restoreDashboards<B extends AnyBlock>(blocks: B[], existing: B[]): B[] {
  const current = new Map<string, B>();
  const collect = (list: B[]) => {
    for (const block of list) {
      if (block.type === DASHBOARD_BLOCK && block.id) current.set(block.id, block);
      if (block.children?.length) collect(block.children as B[]);
    }
  };
  collect(existing);
  const used = new Set<string>();
  const walk = (list: B[]): B[] =>
    list.flatMap((block) => {
      if (block.type === DASHBOARD_BLOCK) {
        const id = block.id ?? "";
        const match = current.get(id);
        if (!match || used.has(id)) return [];
        used.add(id);
        const layout = dashboardLayout(match.props?.layout);
        const period = typeof match.props?.period === "string" ? match.props.period : "";
        const props = { widgets: String(match.props?.widgets ?? ""), ...(layout === "tabs" ? { layout } : {}), ...(period ? { period } : {}) };
        return [{ ...block, id, props, children: [] } as B];
      }
      return block.children?.length ? [{ ...block, children: walk(block.children as B[]) }] : [block];
    });
  return walk(blocks);
}

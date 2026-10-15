import type { ViewType } from "@/db/schema/app";
import { checkLinkedView, LINKED_VIEW_TYPES, type LinkedView } from "./embed-blocks";

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
 * Pure: the block config is shared by the editor (components/page/dashboard-block.tsx) and the
 * server (server/blocknote.ts).
 */

export const DASHBOARD_BLOCK = "dashboard";

export const dashboardBlockConfig = {
  type: DASHBOARD_BLOCK,
  // The widgets as JSON (see parseDashboard): block props are flat strings, and keeping them in the
  // block makes them sync, undo and version with the page.
  propSchema: { widgets: { default: "" } },
  content: "none",
} as const;

/** Columns of the grid on wide screens; widgets take 1 to 4 of them, phones show one per row. */
export const DASHBOARD_COLUMNS = 4;
export const WIDGET_SPANS = [1, 2, 3, 4] as const;
export type WidgetSpan = (typeof WIDGET_SPANS)[number];
/** Widgets per dashboard: each one is a query when the page opens and whenever its database changes. */
export const MAX_WIDGETS = 12;
export const MAX_WIDGET_TITLE = 120;
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
  view: LinkedView;
};

const ID = /^[\w-]{1,64}$/;

/** Layouts the server works out (numbers and charts are both "chart" views). */
export function isComputedWidget(type: ViewType): type is "chart" | "list" {
  return type === "chart" || type === "list";
}

/** The width a new widget of this layout starts at: numbers are small, tables and boards wide. */
export function defaultSpan(view: LinkedView): WidgetSpan {
  if (view.type === "chart") return view.config.chartType === "number" ? 1 : 2;
  return view.type === "list" ? 2 : 4;
}

/** What a new widget shows until it is set up: how many rows the database has. */
/** A short id no widget of `taken` has. */
export function newWidgetId(taken: Pick<DashboardWidget, "id">[]) {
  for (;;) {
    const id = crypto.randomUUID().slice(0, 8);
    if (!taken.some((w) => w.id === id)) return id;
  }
}

export function newWidget(id: string, databaseId: string): DashboardWidget {
  const view: LinkedView = { type: "chart", config: { chartType: "number" } };
  return { id, databaseId, title: "", span: defaultSpan(view), view };
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

function checkWidget(item: unknown): DashboardWidget | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const { id, databaseId, title, span, view } = item as Record<string, unknown>;
  if (typeof id !== "string" || !ID.test(id) || typeof databaseId !== "string" || !ID.test(databaseId)) return null;
  const checked = checkLinkedView(view);
  if (!(LINKED_VIEW_TYPES as readonly ViewType[]).includes(checked.type)) return null;
  return {
    id,
    databaseId,
    title: typeof title === "string" ? title.slice(0, MAX_WIDGET_TITLE) : "",
    span: WIDGET_SPANS.includes(span as WidgetSpan) ? (span as WidgetSpan) : defaultSpan(checked),
    view: checked,
  };
}

export const serializeDashboard = (widgets: DashboardWidget[]) =>
  JSON.stringify(
    widgets.slice(0, MAX_WIDGETS).map(({ id, databaseId, title, span, view }) => ({
      id,
      databaseId,
      ...(title ? { title } : {}),
      span,
      view: { type: view.type, config: view.config },
    })),
  );

/** The databases a dashboard shows, each once, in order. */
export function dashboardDatabaseIds(widgets: DashboardWidget[]): string[] {
  return [...new Set(widgets.map((w) => w.databaseId))];
}

/** `widgets` with the one whose id is `id` changed by `change` (or taken out when it returns null). */
export function updateWidget(widgets: DashboardWidget[], id: string, change: (widget: DashboardWidget) => DashboardWidget | null) {
  return widgets.flatMap((w) => {
    if (w.id !== id) return [w];
    const next = change(w);
    return next ? [next] : [];
  });
}

/** `widgets` with the one whose id is `id` moved `by` places (clamped to the ends). */
/** `widgets` with the widget `id` moved right before or after the widget `target`. */
export function placeWidget(widgets: DashboardWidget[], id: string, target: string, side: "before" | "after") {
  const moving = widgets.find((w) => w.id === id);
  const rest = widgets.filter((w) => w.id !== id);
  const at = rest.findIndex((w) => w.id === target);
  if (!moving || at < 0) return widgets;
  rest.splice(side === "before" ? at : at + 1, 0, moving);
  return rest;
}

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
        return [{ ...block, id, props: { widgets: String(match.props?.widgets ?? "") }, children: [] } as B];
      }
      return block.children?.length ? [{ ...block, children: walk(block.children as B[]) }] : [block];
    });
  return walk(blocks);
}

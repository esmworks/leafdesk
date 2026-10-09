"use client";

import { Maximize, RotateCw, Search, X, ZoomIn, ZoomOut } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type Sigma from "sigma";
import { SidebarOpenButton } from "@/components/sidebar/sidebar-context";
import { useColorScheme } from "@/components/theme/theme-provider";
import { Button, buttonClass, cn, IconButton, pageLabel, PageIcon, Switch } from "@/components/ui";
import {
  CLUSTER_ROWS,
  clusterRows,
  DEFAULT_FILTER,
  degrees,
  EDGE_KINDS,
  filterGraph,
  MAX_DEPTH,
  type ClusteredEdge,
  type ClusteredNode,
  type GraphEdge,
  type GraphEdgeKind,
  type GraphFilter,
  type GraphNodeKind,
  type WorkspaceGraph,
} from "@/lib/graph";
import { pagePath } from "@/lib/mentions";
import { searchFold } from "@/lib/search-fold";

type Colors = Record<GraphNodeKind | "link" | "relation" | "child" | "faded" | "fg" | "bg" | "border", string>;

/** The graph's colors as the stylesheet has them now (WebGL needs values, not variables). */
function readColors(): Colors {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string) => style.getPropertyValue(`--${name}`).trim();
  return {
    page: read("graph-page"),
    database: read("graph-database"),
    row: read("graph-row"),
    link: read("graph-link"),
    relation: read("graph-relation"),
    child: read("graph-child"),
    faded: read("graph-faded"),
    fg: read("fg"),
    bg: read("bg"),
    border: read("border"),
  };
}

/** A stable start position for a page, so the layout settles the same way each time. */
function startPosition(id: string) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  const angle = ((hash >>> 0) % 3600) / 3600 * Math.PI * 2;
  const radius = 10 + (((hash >>> 12) % 1000) / 1000) * 90;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

/** The layout runs this long, then stops (longer for bigger graphs). */
const layoutMs = (order: number) => Math.min(8000, 1500 + order * 4);

/**
 * Rows are all one size, so their labels all appear at the same zoom; pages and databases are
 * bigger and grow with their edges (and the rows drawn as them) a step per doubling, up to a
 * limit, so a database of hundreds of rows is bigger than one of tens without filling the screen.
 */
const nodeSize = (kind: GraphNodeKind, degree: number) => (kind === "row" ? 4.5 : 6 + Math.min(Math.log2(1 + degree) * 2.6, 24));

/** An edge standing for many is drawn thicker, a little per doubling. */
const edgeSize = (kind: GraphEdgeKind, weight: number) => (kind === "child" ? 0.8 : 1.2) + Math.min(Math.log2(weight) * 0.6, 2.4);

/** Below this size on screen a row has no label (unless it's focused or pointed at): until zoomed in. */
const LABEL_THRESHOLD = 6;

/** Up to this many neighbours of the page pointed at or selected, or pages in the graph, are all named, rows too. */
const NEAR_LABELS = 40;

/** The count of the rows a database stands for goes inside it from this size on screen. */
const BADGE_SIZE = 11;

/**
 * Which labels win where they would cover each other: the page pointed at or selected, then its
 * neighbours, then the focused page, then pages and databases, then rows.
 */
const PRIORITY = { active: 4, near: 3, focus: 2, page: 1, row: 0 };

type Label = { label: string; x: number; y: number; size: number; priority: number; badge?: string };

type Box = { left: number; top: number; right: number; bottom: number };

const overlaps = (a: Box, b: Box) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

/** The side of a grid's cells, in CSS pixels: about a short label wide. */
const CELL = 64;

/** Boxes filed by the grid cells they touch, so finding what a box overlaps looks only nearby. */
class BoxGrid<T extends Box> {
  private cells = new Map<number, T[]>();

  private *keys({ left, top, right, bottom }: Box) {
    for (let cx = Math.floor(left / CELL); cx <= Math.floor(right / CELL); cx++)
      for (let cy = Math.floor(top / CELL); cy <= Math.floor(bottom / CELL); cy++) yield cx * 65_536 + cy;
  }

  add(box: T) {
    for (const key of this.keys(box)) {
      const cell = this.cells.get(key);
      if (cell) cell.push(box);
      else this.cells.set(key, [box]);
    }
  }

  /** Whether `box` overlaps a box for which `test` holds. */
  hits(box: Box, test: (other: T) => boolean = () => true) {
    for (const key of this.keys(box)) for (const other of this.cells.get(key) ?? []) if (overlaps(box, other) && test(other)) return true;
    return false;
  }
}

/** Where a label `width` wide goes beside a page: to its right, or to its left where the right would run off the canvas. */
const labelSides = (x: number, size: number, width: number, canvasWidth: number) => {
  const right = x + size + 3;
  const left = x - size - 3 - width;
  return right + width > canvasWidth ? [left, right] : [right, left];
};

/**
 * Draws the labels of one frame, the most important first (by priority, then bigger pages), and
 * leaves out each label that would cover one already drawn or a labelled page. A halo in the
 * background color keeps edges and pages behind a label from crossing its text. A database
 * standing for its rows shows their count inside it, or after its name where it is too small.
 */
function drawLabels(context: CanvasRenderingContext2D, top: CanvasRenderingContext2D, labels: Label[], font: string, colors: Colors) {
  labels.sort((a, b) => b.priority - a.priority || b.size - a.size);
  const taken = new BoxGrid<Box>();
  // A label covers no other label, nor a page whose label matters as much (a row's name may cover a row).
  const pages = new BoxGrid<Box & { priority: number }>();
  for (const { x, y, size, priority } of labels) pages.add({ left: x - size, top: y - size, right: x + size, bottom: y + size, priority });
  // The canvas's width in CSS pixels, which sigma draws in.
  const edge = context.canvas.offsetWidth;
  // Counts go on the topmost canvas: a page pointed at or selected is drawn again over the labels.
  top.clearRect(0, 0, top.canvas.width, top.canvas.height);
  top.textAlign = "center";
  top.font = `600 11px ${font}`;
  top.fillStyle = colors.bg;
  for (const { x, y, size, badge } of labels) if (badge && size >= BADGE_SIZE) top.fillText(badge, x, y + 4);
  context.lineJoin = "round";
  context.font = `12px ${font}`;
  context.lineWidth = 3;
  context.strokeStyle = colors.bg;
  context.fillStyle = colors.fg;
  for (const { label: name, x, y, size, badge, priority } of labels) {
    const label = badge && size < BADGE_SIZE ? `${name} · ${badge}` : name;
    const width = context.measureText(label).width;
    // On the preferred side, or else the other one.
    const box = labelSides(x, size, width, edge)
      .map((left) => ({ left: left - 2, top: y - 9, right: left + width + 2, bottom: y + 9 }))
      .find((b) => !taken.hits(b) && !pages.hits(b, (p) => p.priority >= priority));
    if (!box) continue;
    taken.add(box);
    const left = box.left + 2;
    context.strokeText(label, left, y + 4);
    context.fillText(label, left, y + 4);
  }
}

/** The larger part of `canvas` that `cover` (a card over it) leaves free: beside it or above it. */
function freeArea(canvas: HTMLElement, cover: HTMLElement | null) {
  const at = canvas.getBoundingClientRect();
  if (!cover) return { width: at.width, height: at.height };
  const card = cover.getBoundingClientRect();
  const beside = { width: card.left - at.left, height: at.height };
  const above = { width: at.width, height: card.top - at.top };
  return beside.width * beside.height >= above.width * above.height ? beside : above;
}

/** What the page around the canvas can ask of it. */
export type GraphCanvas = {
  /**
   * Brings a page into the part of the canvas `cover` leaves free, if it isn't there already; with
   * `closer`, also centres it there and zooms in if the view is far out.
   */
  reveal(id: string, closer?: boolean): void;
  zoomIn(): void;
  zoomOut(): void;
  /** The whole graph in view. */
  fit(): void;
};

type Shown = { nodes: ClusteredNode[]; edges: (GraphEdge & { weight?: number })[] };

/**
 * Draws `shown` into `container` with WebGL, laid out in a worker, `focus` labelled; pointing at a
 * page shows its neighbours. With `onSelect`, clicking a page selects it (its neighbours stay
 * lit), clicking the background lets go and double-clicking opens it; without, clicking opens it
 * (and with Cmd or Ctrl held, either way, in a new tab). `cover` is what may lie over the canvas.
 * Drawn again when what is shown or the color scheme changes, from where the pages were; pages
 * new to it (rows brought out of their database) start where the page they're inside is.
 */
export function useGraphCanvas(
  container: RefObject<HTMLDivElement | null>,
  shown: Shown,
  focus: string | null,
  workspaceId: string,
  {
    selected = null,
    onSelect,
    cover,
  }: { selected?: string | null; onSelect?: (id: string | null) => void; cover?: RefObject<HTMLElement | null> } = {},
): RefObject<GraphCanvas | null> {
  const tc = useTranslations("common");
  const locale = useLocale();
  const router = useRouter();
  const scheme = useColorScheme();
  // Where pages were when the graph was last drawn, so changing a filter doesn't start over.
  const positions = useRef(new Map<string, { x: number; y: number }>());
  const canvas = useRef<GraphCanvas | null>(null);
  // Read by the drawing, which isn't set up again when they change.
  const selectedRef = useRef(selected);
  const onSelectRef = useRef(onSelect);
  const relight = useRef<(() => void) | null>(null);
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);
  useEffect(() => {
    selectedRef.current = selected;
    relight.current?.();
  }, [selected]);
  const selectable = !!onSelect;

  useEffect(() => {
    const element = container.current;
    if (!element || !shown.nodes.length) return;
    let cancelled = false;
    let renderer: Sigma | null = null;
    let layout: { stop(): void; kill(): void } | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const saved = positions.current;
    let drawn: import("graphology").default | null = null;

    void (async () => {
      const [{ default: Graph }, { default: SigmaRenderer }, { default: Layout }, { default: forceAtlas2 }] = await Promise.all([
        import("graphology"),
        import("sigma"),
        // Runs the layout in a Worker made from a blob: URL. There is no Content-Security-Policy on
        // pages yet; if one is added, its `worker-src` must allow `blob:`.
        import("graphology-layout-forceatlas2/worker"),
        import("graphology-layout-forceatlas2"),
      ]);
      if (cancelled) return;
      const colors = readColors();
      const number = new Intl.NumberFormat(locale);
      const degree = degrees(shown.edges);
      const g = new Graph({ type: "undirected" });
      for (const n of shown.nodes) {
        // A page seen for the first time starts beside the page it's inside, so an expanded database spreads out from it.
        const home = n.parent ? saved.get(n.parent) : undefined;
        const near = startPosition(n.id);
        const at = saved.get(n.id) ?? (home ? { x: home.x + near.x / 20, y: home.y + near.y / 20 } : near);
        g.addNode(n.id, {
          ...at,
          size: nodeSize(n.kind, (degree.get(n.id) ?? 0) + (n.rows ?? 0)),
          label: pageLabel(n.title, tc("untitled")),
          color: colors[n.kind],
          kind: n.kind,
          badge: n.rows ? number.format(n.rows) : undefined,
        });
      }
      for (const e of shown.edges) {
        const weight = e.weight ?? 1;
        g.addEdge(e.source, e.target, { color: colors[e.kind], size: edgeSize(e.kind, weight), weight });
      }
      drawn = g;

      // The page pointed at, or else the one selected, and its neighbours.
      let hovered: string | null = null;
      let active: string | null = null;
      const near = new Set<string>();
      const light = () => {
        const next = hovered ?? (selectedRef.current && g.hasNode(selectedRef.current) ? selectedRef.current : null);
        active = next;
        near.clear();
        if (next) g.forEachNeighbor(next, (other) => near.add(other));
        renderer?.refresh({ skipIndexation: true });
      };

      // Sigma hands over the labels it would draw; drawLabels draws them once the frame is done.
      let labels: Label[] = [];
      const labelFont = getComputedStyle(document.body).fontFamily;
      renderer = new SigmaRenderer(g, element, {
        labelFont,
        labelSize: 12,
        labelColor: { color: colors.fg },
        labelRenderedSizeThreshold: LABEL_THRESHOLD,
        // Every candidate reaches drawLabels, which decides by room on screen.
        labelDensity: 10,
        defaultDrawNodeLabel: (_, data) => {
          if (!data.label) return;
          const { priority, badge } = data as typeof data & { priority: number; badge?: string };
          labels.push({ label: data.label, x: data.x, y: data.y, size: data.size, priority, badge });
        },
        zIndex: true,
        // Room for the labels drawn beside the pages nearest the edge.
        stagePadding: 60,
        minCameraRatio: 0.05,
        maxCameraRatio: 4,
        // A label on a plain tile in the page's colors, not the default white box.
        defaultDrawNodeHover: (context, data, settings) => {
          if (!data.label) return;
          const { badge } = data as typeof data & { badge?: string };
          const label = badge && data.size < BADGE_SIZE ? `${data.label} · ${badge}` : data.label;
          context.font = `${settings.labelWeight} ${settings.labelSize}px ${settings.labelFont}`;
          const width = context.measureText(label).width;
          // The side its label takes in drawLabels when there is room there.
          const [x] = labelSides(data.x, data.size, width + 4, context.canvas.offsetWidth);
          const height = settings.labelSize + 8;
          context.fillStyle = colors.bg;
          context.strokeStyle = colors.border;
          context.lineWidth = 1;
          context.beginPath();
          context.roundRect(x - 4, data.y - height / 2, width + 8, height, 4);
          context.fill();
          context.stroke();
          context.fillStyle = colors.fg;
          context.fillText(label, x, data.y + settings.labelSize / 3);
        },
        nodeReducer: (node, data) => {
          const page = data.kind !== "row";
          if (!active) {
            const priority = node === focus ? PRIORITY.focus : page ? PRIORITY.page : PRIORITY.row;
            // In a small graph every page is named, rows too.
            return { ...data, priority, forceLabel: page || node === focus || g.order <= NEAR_LABELS };
          }
          if (node === active) return { ...data, priority: PRIORITY.active, forceLabel: true, highlighted: !hovered, zIndex: 2 };
          // Past a few dozen neighbours, rows among them are named only zoomed in, like other rows.
          if (near.has(node)) return { ...data, priority: PRIORITY.near, forceLabel: page || near.size <= NEAR_LABELS, zIndex: 1 };
          return { ...data, color: colors.faded, label: "", badge: undefined, zIndex: 0 };
        },
        edgeReducer: (edge, data) => {
          if (!active) return data;
          const [a, b] = g.extremities(edge);
          return a === active || b === active
            ? { ...data, color: g.getNodeAttribute(active, "color") as string, size: (data.size as number) + 0.6, zIndex: 1 }
            : { ...data, color: colors.faded, zIndex: 0 };
        },
      });
      relight.current = light;
      const labelContext = renderer.getCanvases().labels.getContext("2d");
      const topContext = renderer.getCanvases().mouse.getContext("2d");
      renderer.on("beforeRender", () => {
        labels = [];
      });
      renderer.on("afterRender", () => {
        if (labelContext && topContext) drawLabels(labelContext, topContext, labels, labelFont, colors);
      });
      renderer.on("enterNode", ({ node }) => {
        hovered = node;
        element.style.cursor = "pointer";
        light();
      });
      renderer.on("leaveNode", () => {
        hovered = null;
        element.style.cursor = "";
        light();
      });
      const toNewTab = (original: MouseEvent | TouchEvent) => original.metaKey || original.ctrlKey;
      const open = (node: string, original: MouseEvent | TouchEvent) => {
        const path = pagePath(workspaceId, node);
        if (toNewTab(original)) window.open(path, "_blank", "noopener");
        else router.push(path);
      };
      renderer.on("clickNode", ({ node, event }) => {
        if (onSelectRef.current && !toNewTab(event.original)) onSelectRef.current(node);
        else open(node, event.original);
      });
      renderer.on("doubleClickNode", ({ node, event, preventSigmaDefault }) => {
        preventSigmaDefault();
        if (selectable) open(node, event.original);
      });
      renderer.on("clickStage", () => onSelectRef.current?.(null));
      light();

      const camera = renderer.getCamera();
      const duration = 300;
      canvas.current = {
        reveal(id, closer = false) {
          const data = renderer?.getNodeDisplayData(id);
          if (!renderer || !data) return;
          const { width, height } = renderer.getDimensions();
          const free = freeArea(element, cover?.current ?? null);
          const at = renderer.framedGraphToViewport(data);
          const margin = 48;
          if (!closer && at.x > margin && at.x < free.width - margin && at.y > margin && at.y < free.height - margin) return;
          const state = camera.getState();
          const ratio = closer ? Math.min(state.ratio, 0.6) : state.ratio;
          // Where the middle of the free part is, from the middle of the canvas, at the new zoom.
          const target = renderer.viewportToFramedGraph({ x: free.width / 2, y: free.height / 2 });
          const middle = renderer.viewportToFramedGraph({ x: width / 2, y: height / 2 });
          const scale = ratio / state.ratio;
          void camera.animate({ x: data.x - (target.x - middle.x) * scale, y: data.y - (target.y - middle.y) * scale, ratio }, { duration: 450 });
        },
        zoomIn: () => void camera.animatedZoom({ duration }),
        zoomOut: () => void camera.animatedUnzoom({ duration }),
        fit: () => void camera.animatedReset({ duration }),
      };

      if (g.order > 1) {
        const settings = forceAtlas2.inferSettings(g);
        // Strong gravity keeps pages without connections near the rest instead of far out.
        const supervisor = new Layout(g, { settings: { ...settings, strongGravityMode: true, gravity: 1, barnesHutOptimize: g.order > 400 } });
        layout = supervisor;
        supervisor.start();
        timer = setTimeout(() => {
          supervisor.stop();
          // Drawn again (a database expanded or gathered): the selected page back where it can be seen.
          const id = selectedRef.current;
          if (id && g.hasNode(id)) canvas.current?.reveal(id);
        }, layoutMs(g.order));
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(timer);
      layout?.kill();
      drawn?.forEachNode((id, attrs) => saved.set(id, { x: attrs.x as number, y: attrs.y as number }));
      relight.current = null;
      canvas.current = null;
      renderer?.kill();
    };
  }, [container, shown, scheme, focus, workspaceId, router, tc, locale, selectable, cover]);

  return canvas;
}

/**
 * The workspace graph: pages, databases and rows the viewer can open, joined by links, relations
 * and the page tree (lib/graph). Databases with many rows stand for them until expanded. Drawn
 * with WebGL; the layout runs in a worker. Pointing at a page shows its neighbours; clicking
 * selects it and shows what it is joined to, double-clicking opens it.
 */
export function GraphView({ workspaceId, graph }: { workspaceId: string; graph: WorkspaceGraph }) {
  const t = useTranslations("graph");
  const tc = useTranslations("common");
  const router = useRouter();
  // The focus lives in the address (`?focus=`), so a link, a reload and the sidebar's link to the
  // whole graph all show what the address says.
  const focusParam = useSearchParams().get("focus");
  const [choices, setChoices] = useState<Omit<GraphFilter, "focus">>(DEFAULT_FILTER);
  const filter = useMemo<GraphFilter>(() => ({ ...choices, focus: focusParam }), [choices, focusParam]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(() => new Set<string>());
  const container = useRef<HTMLDivElement>(null);
  const shown = useMemo(() => filterGraph(graph, filter), [graph, filter]);
  const drawn = useMemo(
    () => clusterRows(shown, { expanded, keep: new Set(filter.focus ? [filter.focus] : []) }),
    [shown, expanded, filter.focus],
  );
  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
  const focused = filter.focus ? byId.get(filter.focus) : undefined;
  // How many rows of each database are in view, drawn or not.
  const rowsIn = useMemo(() => {
    const count = new Map<string, number>();
    for (const n of shown.nodes) if (n.kind === "row" && n.parent) count.set(n.parent, (count.get(n.parent) ?? 0) + 1);
    return count;
  }, [shown]);
  const selectedNode = selected ? drawn.nodes.find((n) => n.id === selected) : undefined;

  const matches = useMemo(() => {
    const q = searchFold(query.trim());
    if (!q) return [];
    return graph.nodes.filter((n) => searchFold(pageLabel(n.title, tc("untitled"))).includes(q)).slice(0, 8);
  }, [graph, query, tc]);

  function setFocus(id: string | null) {
    setQuery("");
    // Without loading the page again (the router follows history.replaceState).
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("focus", id);
    else url.searchParams.delete("focus");
    window.history.replaceState(null, "", url);
  }

  const card = useRef<HTMLElement>(null);
  // A page selected is brought into view once its card is up, to keep it out from under the card.
  const revealing = useRef<{ id: string; closer: boolean } | null>(null);
  const canvas = useGraphCanvas(container, drawn, filter.focus, workspaceId, {
    selected: selectedNode ? selected : null,
    onSelect: (id) => select(id, false),
    cover: card,
  });
  useEffect(() => {
    const pending = revealing.current;
    if (!pending || pending.id !== selectedNode?.id) return;
    revealing.current = null;
    canvas.current?.reveal(pending.id, pending.closer);
  }, [selectedNode?.id, canvas]);

  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  function select(id: string | null, closer = true) {
    revealing.current = id ? { id, closer } : null;
    setSelected(id);
  }

  function toggleRows(id: string) {
    setExpanded((before) => {
      const next = new Set(before);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  const toggle = (key: "tree" | "rows" | "orphans") => (checked: boolean) => setChoices((f) => ({ ...f, [key]: checked }));

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-col gap-3 border-b border-border px-4 pb-3 md:px-6">
        {/* The first row is as tall as a page's header, and the open button is pulled into the padding, so it sits where it does on pages. */}
        <div className="flex min-h-11 flex-wrap items-center gap-x-4 gap-y-2">
          <SidebarOpenButton className="-mr-2 -ml-2.5 md:-ml-3" />
          <h1 className="text-lg font-semibold tracking-tight">{t("heading")}</h1>
          <p className="text-xs text-fg-muted">{t("count", { pages: shown.nodes.length, edges: shown.edges.length })}</p>
          <IconButton label={t("reload")} onClick={() => router.refresh()} className="ml-auto">
            <RotateCw className="h-4 w-4" />
          </IconButton>
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <div className="relative w-full sm:w-64">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-fg-muted" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && matches[0]) setFocus(matches[0].id);
                // Closing the matches lets the selection be.
                if (e.key === "Escape" && query) {
                  e.preventDefault();
                  setQuery("");
                }
              }}
              placeholder={t("find")}
              aria-label={t("find")}
              className="h-8 w-full rounded-md border border-border bg-bg pr-2 pl-8 text-base outline-none placeholder:text-fg-faint focus:border-accent sm:text-sm"
            />
            {matches.length > 0 && (
              <ul className="absolute top-9 right-0 left-0 z-20 rounded-md border border-border bg-bg p-1 shadow-lg">
                {matches.map((n) => (
                  <li key={n.id}>
                    <button
                      type="button"
                      onClick={() => setFocus(n.id)}
                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-bg-hover"
                    >
                      <PageIcon icon={n.icon} kind={n.kind === "database" ? "database" : "page"} className="text-sm" />
                      <span className="truncate">{pageLabel(n.title, tc("untitled"))}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {focused && (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-fg-muted">{t("focus")}</span>
              <span className="max-w-48 truncate font-medium">{pageLabel(focused.title, tc("untitled"))}</span>
              <label className="flex items-center gap-1.5 text-fg-muted">
                {t("depth")}
                <select
                  value={filter.depth}
                  onChange={(e) => setChoices((f) => ({ ...f, depth: Number(e.target.value) }))}
                  className="h-7 rounded-md border border-border bg-bg px-1.5 text-sm text-fg"
                >
                  {Array.from({ length: MAX_DEPTH }, (_, i) => i + 1).map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </label>
              <IconButton label={t("clearFocus")} onClick={() => setFocus(null)}>
                <X className="h-4 w-4" />
              </IconButton>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-fg-muted">
            <Toggle label={t("tree")} checked={filter.tree} onChange={toggle("tree")} />
            <Toggle label={t("rows")} checked={filter.rows} onChange={toggle("rows")} />
            <Toggle label={t("orphans")} checked={filter.orphans} onChange={toggle("orphans")} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-muted">
          <Legend color="var(--graph-page)" label={t("kinds.page")} />
          <Legend color="var(--graph-database)" label={t("kinds.database")} />
          <Legend color="var(--graph-row)" label={t("kinds.row")} />
          <Legend color="var(--graph-link)" label={t("edges.link")} line />
          <Legend color="var(--graph-relation)" label={t("edges.relation")} line />
          <Legend color="var(--graph-child)" label={t("edges.child")} line />
          {graph.truncated && <span className="text-fg">{t("truncated", { count: graph.nodes.length })}</span>}
        </div>
      </header>
      <div className="relative min-h-0 flex-1">
        <div ref={container} className="absolute inset-0" role="img" aria-label={t("canvas")} />
        {!shown.nodes.length ? (
          <p className="absolute inset-0 flex items-center justify-center px-4 text-center text-sm text-fg-muted">
            {filter.focus && !focused ? t("focusMissing") : t("empty")}
          </p>
        ) : (
          <>
            <div className="absolute top-3 right-3 flex flex-col overflow-hidden rounded-md border border-border bg-bg shadow-sm md:top-auto md:bottom-3">
              <ZoomButton label={t("zoomIn")} onClick={() => canvas.current?.zoomIn()}>
                <ZoomIn className="h-4 w-4" />
              </ZoomButton>
              <ZoomButton label={t("zoomOut")} onClick={() => canvas.current?.zoomOut()}>
                <ZoomOut className="h-4 w-4" />
              </ZoomButton>
              <ZoomButton label={t("fit")} onClick={() => canvas.current?.fit()}>
                <Maximize className="h-4 w-4" />
              </ZoomButton>
            </div>
            {!selectedNode && <p className="pointer-events-none absolute bottom-3 left-4 hidden text-xs text-fg-faint md:block">{t("hint")}</p>}
          </>
        )}
        {selectedNode && (
          <Inspector
            key={selectedNode.id}
            ref={card}
            workspaceId={workspaceId}
            node={selectedNode}
            graph={drawn}
            byId={byId}
            rowsInView={rowsIn.get(selectedNode.id) ?? 0}
            expanded={expanded.has(selectedNode.id)}
            onSelect={select}
            onFocus={() => setFocus(selectedNode.id)}
            onToggleRows={() => toggleRows(selectedNode.id)}
            onClose={() => setSelected(null)}
          />
        )}
      </div>
    </div>
  );
}

/** The neighbours of a page by how they are joined to it, in the order the card lists them. */
type Group = GraphEdgeKind | "parent";
const GROUPS: Group[] = ["parent", ...EDGE_KINDS];

/** Neighbours listed per kind of edge before the rest are counted. */
const LIST_LIMIT = 50;

/**
 * What the selected page is and what it is joined to: per kind of edge, its neighbours (an edge
 * standing for several with their count), each a click away from being selected in turn.
 */
function Inspector({
  ref,
  workspaceId,
  node,
  graph,
  byId,
  rowsInView,
  expanded,
  onSelect,
  onFocus,
  onToggleRows,
  onClose,
}: {
  ref: RefObject<HTMLElement | null>;
  workspaceId: string;
  node: ClusteredNode;
  graph: { nodes: ClusteredNode[]; edges: ClusteredEdge[] };
  byId: Map<string, ClusteredNode>;
  rowsInView: number;
  expanded: boolean;
  onSelect: (id: string) => void;
  onFocus: () => void;
  onToggleRows: () => void;
  onClose: () => void;
}) {
  const t = useTranslations("graph");
  const tc = useTranslations("common");
  const format = useFormatter();
  const drawnById = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
  const groups = useMemo(() => {
    // The page it is inside comes apart, however they are joined (a link to it, say).
    const byGroup = new Map<Group, { other: ClusteredNode; weight: number }[]>();
    for (const e of graph.edges) {
      const otherId = e.source === node.id ? e.target : e.target === node.id ? e.source : null;
      const other = otherId ? drawnById.get(otherId) : undefined;
      if (!other) continue;
      const group: Group = other.id === node.parent ? "parent" : e.kind;
      byGroup.set(group, [...(byGroup.get(group) ?? []), { other, weight: e.weight }]);
    }
    const collator = new Intl.Collator(undefined, { numeric: true });
    return GROUPS.filter((group) => byGroup.has(group)).map((group) => ({
      group,
      items: byGroup.get(group)!.sort((a, b) => b.weight - a.weight || collator.compare(a.other.title, b.other.title)),
    }));
  }, [graph, node.id, node.parent, drawnById]);
  const parent = node.parent ? byId.get(node.parent) : undefined;
  const title = pageLabel(node.title, tc("untitled"));

  return (
    <section
      ref={ref}
      aria-label={title}
      className="absolute inset-x-2 bottom-2 flex max-h-[55%] flex-col overflow-hidden rounded-lg border border-border bg-bg shadow-lg md:inset-x-auto md:top-3 md:right-3 md:bottom-auto md:max-h-[calc(100%-1.5rem)] md:w-80"
    >
      <div className="flex items-start gap-2.5 border-b border-border p-3">
        <span
          className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ background: `var(--graph-${node.kind})` }}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold">
            <PageIcon icon={node.icon} kind={node.kind === "database" ? "database" : "page"} className="text-sm" />
            <span className="truncate">{title}</span>
          </h2>
          <p className="mt-0.5 truncate text-xs text-fg-muted">
            {t(`kinds.${node.kind}`)}
            {parent && ` · ${pageLabel(parent.title, tc("untitled"))}`}
            {rowsInView > 0 && ` · ${t("inspector.rows", { count: rowsInView })}`}
          </p>
        </div>
        <IconButton label={t("inspector.close")} onClick={onClose}>
          <X className="h-4 w-4" />
        </IconButton>
      </div>
      <div className="flex flex-wrap gap-2 border-b border-border p-3">
        <Link
          href={pagePath(workspaceId, node.id)}
          className={buttonClass({ variant: "primary", size: "sm" })}
        >
          {t("inspector.open")}
        </Link>
        <Button size="sm" onClick={onFocus}>
          {t("inspector.focus")}
        </Button>
        {rowsInView > CLUSTER_ROWS && (
          <Button size="sm" onClick={onToggleRows}>
            {expanded ? t("inspector.collapseRows") : t("inspector.expandRows", { count: rowsInView })}
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {!groups.length && <p className="px-1.5 py-2 text-xs text-fg-muted">{t("inspector.none")}</p>}
        {groups.map(({ group, items }) => (
          <div key={group} className="mb-1">
            <h3 className="flex items-center gap-2 px-1.5 pt-2 pb-1 text-xs font-medium text-fg-muted">
              <span className="inline-block h-0.5 w-3" style={{ background: `var(--graph-${group === "parent" ? "child" : group})` }} aria-hidden />
              {group === "parent" ? t("inspector.parent") : t(`edges.${group}`)}
              <span className="text-fg-faint">{format.number(items.length)}</span>
            </h3>
            <ul>
              {items.slice(0, LIST_LIMIT).map(({ other, weight }) => (
                <li key={other.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(other.id)}
                    className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-sm hover:bg-bg-hover"
                  >
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: `var(--graph-${other.kind})` }} aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{pageLabel(other.title, tc("untitled"))}</span>
                    {other.rows ? <span className="shrink-0 text-xs text-fg-faint">{t("inspector.rows", { count: other.rows })}</span> : null}
                    {weight > 1 && <span className="shrink-0 text-xs text-fg-muted tabular-nums">×{format.number(weight)}</span>}
                  </button>
                </li>
              ))}
            </ul>
            {items.length > LIST_LIMIT && <p className="px-1.5 py-1 text-xs text-fg-faint">{t("inspector.more", { count: items.length - LIST_LIMIT })}</p>}
          </div>
        ))}
      </div>
    </section>
  );
}

function ZoomButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex h-8 w-8 items-center justify-center text-fg-muted transition-colors not-last:border-b not-last:border-border hover:bg-bg-hover hover:text-fg"
    >
      {children}
    </button>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <span className="flex items-center gap-2">
      <Switch label={label} checked={checked} onChange={onChange} />
      <span aria-hidden>{label}</span>
    </span>
  );
}

function Legend({ color, label, line }: { color: string; label: string; line?: boolean }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cn("inline-block", line ? "h-0.5 w-4" : "h-2.5 w-2.5 rounded-full")} style={{ background: color }} />
      {label}
    </span>
  );
}

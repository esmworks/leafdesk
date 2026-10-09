"use client";

import { RotateCw, Search, X } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type Sigma from "sigma";
import { useColorScheme } from "@/components/theme/theme-provider";
import { cn, IconButton, pageLabel, PageIcon, Switch } from "@/components/ui";
import { DEFAULT_FILTER, degrees, filterGraph, MAX_DEPTH, type GraphFilter, type GraphNodeKind, type WorkspaceGraph } from "@/lib/graph";
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
 * bigger, and grow with their edges.
 */
const nodeSize = (kind: GraphNodeKind, degree: number) => (kind === "row" ? 4.5 : 6 + Math.sqrt(degree) * 2.2);

/** Below this size on screen a node has no label (unless it's focused or pointed at): rows until zoomed in. */
const LABEL_THRESHOLD = 6;

type Label = { label: string; x: number; y: number; size: number; forceLabel?: boolean };

/**
 * Draws the labels of one frame, the most important first (forced ones, then bigger pages), and
 * leaves out each label that would cover one already drawn. A halo in the background color keeps
 * edges and pages behind a label from crossing its text.
 */
function drawLabels(context: CanvasRenderingContext2D, labels: Label[], font: string, colors: Colors) {
  labels.sort((a, b) => Number(!!b.forceLabel) - Number(!!a.forceLabel) || b.size - a.size);
  const taken: { left: number; top: number; right: number; bottom: number }[] = [];
  context.font = font;
  context.lineWidth = 3;
  context.lineJoin = "round";
  context.strokeStyle = colors.bg;
  context.fillStyle = colors.fg;
  for (const { label, x, y, size } of labels) {
    const left = x + size + 3;
    const box = { left: left - 2, top: y - 9, right: left + context.measureText(label).width + 2, bottom: y + 9 };
    if (taken.some((t) => box.left < t.right && box.right > t.left && box.top < t.bottom && box.bottom > t.top)) continue;
    taken.push(box);
    context.strokeText(label, left, y + 4);
    context.fillText(label, left, y + 4);
  }
}

/**
 * Draws `shown` into `container` with WebGL, laid out in a worker, `focus` labelled; pointing at a
 * page shows its neighbours, clicking opens it. Drawn again when what is shown or the color scheme
 * changes, from where the pages were.
 */
export function useGraphCanvas(
  container: RefObject<HTMLDivElement | null>,
  shown: Pick<WorkspaceGraph, "nodes" | "edges">,
  focus: string | null,
  workspaceId: string,
) {
  const tc = useTranslations("common");
  const router = useRouter();
  const scheme = useColorScheme();
  // Where pages were when the graph was last drawn, so changing a filter doesn't start over.
  const positions = useRef(new Map<string, { x: number; y: number }>());

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
      const degree = degrees(shown.edges);
      const g = new Graph({ type: "undirected" });
      for (const n of shown.nodes) {
        const at = saved.get(n.id) ?? startPosition(n.id);
        g.addNode(n.id, {
          ...at,
          size: nodeSize(n.kind, degree.get(n.id) ?? 0),
          label: pageLabel(n.title, tc("untitled")),
          color: colors[n.kind],
          forceLabel: n.id === focus,
        });
      }
      for (const e of shown.edges) g.addEdge(e.source, e.target, { color: colors[e.kind], size: e.kind === "child" ? 0.8 : 1.2 });
      drawn = g;

      let hovered: string | null = null;
      const near = new Set<string>();
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
          if (data.label) labels.push({ label: data.label, x: data.x, y: data.y, size: data.size, forceLabel: data.forceLabel });
        },
        zIndex: true,
        // Room for the labels drawn to the right of the pages nearest the edge.
        stagePadding: 60,
        minCameraRatio: 0.05,
        maxCameraRatio: 4,
        // A label on a plain tile in the page's colors, not the default white box.
        defaultDrawNodeHover: (context, data, settings) => {
          if (!data.label) return;
          context.font = `${settings.labelWeight} ${settings.labelSize}px ${settings.labelFont}`;
          const width = context.measureText(data.label).width;
          const x = data.x + data.size + 3;
          const height = settings.labelSize + 8;
          context.fillStyle = colors.bg;
          context.strokeStyle = colors.border;
          context.beginPath();
          context.roundRect(x - 4, data.y - height / 2, width + 8, height, 4);
          context.fill();
          context.stroke();
          context.fillStyle = colors.fg;
          context.fillText(data.label, x, data.y + settings.labelSize / 3);
        },
        nodeReducer: (node, data) => {
          if (!hovered || node === hovered || near.has(node)) return { ...data, zIndex: node === hovered ? 2 : 1, forceLabel: data.forceLabel || near.has(node) };
          return { ...data, color: colors.faded, label: "", zIndex: 0 };
        },
        edgeReducer: (edge, data) => {
          if (!hovered) return data;
          const [a, b] = g.extremities(edge);
          return a === hovered || b === hovered
            ? { ...data, color: g.getNodeAttribute(hovered, "color") as string, size: 1.6, zIndex: 1 }
            : { ...data, color: colors.faded, zIndex: 0 };
        },
      });
      const labelContext = renderer.getCanvases().labels.getContext("2d");
      renderer.on("beforeRender", () => {
        labels = [];
      });
      renderer.on("afterRender", () => {
        if (labelContext) drawLabels(labelContext, labels, `12px ${labelFont}`, colors);
      });
      renderer.on("enterNode", ({ node }) => {
        hovered = node;
        near.clear();
        g.forEachNeighbor(node, (other) => near.add(other));
        element.style.cursor = "pointer";
        renderer?.refresh({ skipIndexation: true });
      });
      renderer.on("leaveNode", () => {
        hovered = null;
        near.clear();
        element.style.cursor = "";
        renderer?.refresh({ skipIndexation: true });
      });
      renderer.on("clickNode", ({ node }) => router.push(pagePath(workspaceId, node)));

      if (g.order > 1) {
        const settings = forceAtlas2.inferSettings(g);
        // Strong gravity keeps pages without connections near the rest instead of far out.
        const supervisor = new Layout(g, { settings: { ...settings, strongGravityMode: true, gravity: 1, barnesHutOptimize: g.order > 400 } });
        layout = supervisor;
        supervisor.start();
        timer = setTimeout(() => supervisor.stop(), layoutMs(g.order));
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(timer);
      layout?.kill();
      drawn?.forEachNode((id, attrs) => saved.set(id, { x: attrs.x as number, y: attrs.y as number }));
      renderer?.kill();
    };
  }, [container, shown, scheme, focus, workspaceId, router, tc]);
}

/**
 * The workspace graph: pages, databases and rows the viewer can open, joined by links, relations
 * and the page tree (lib/graph). Drawn with WebGL; the layout runs in a worker. Pointing at a page
 * shows its neighbours, clicking opens it.
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
  const container = useRef<HTMLDivElement>(null);
  const shown = useMemo(() => filterGraph(graph, filter), [graph, filter]);
  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
  const focused = filter.focus ? byId.get(filter.focus) : undefined;

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

  useGraphCanvas(container, shown, filter.focus, workspaceId);

  const toggle = (key: "tree" | "rows" | "orphans") => (checked: boolean) => setChoices((f) => ({ ...f, [key]: checked }));

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-col gap-3 border-b border-border px-4 pt-14 pb-3 md:px-6 md:pt-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
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
                if (e.key === "Escape") setQuery("");
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
        {!shown.nodes.length && (
          <p className="absolute inset-0 flex items-center justify-center px-4 text-center text-sm text-fg-muted">
            {filter.focus && !focused ? t("focusMissing") : t("empty")}
          </p>
        )}
      </div>
    </div>
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

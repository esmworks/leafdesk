/**
 * The workspace graph (server/graph.ts builds it, components/graph draws it): pages as nodes, and
 * as edges the links between them, database relations and the page tree. Everything here is plain
 * data and pure functions, shared by the server and the browser.
 */

export type GraphNodeKind = "page" | "database" | "row";

export type GraphNode = {
  id: string;
  title: string;
  icon: string | null;
  kind: GraphNodeKind;
  /**
   * The page it is inside (a row's database), when the viewer can open that page too: nothing
   * hints at one they can't.
   */
  parent?: string;
};

/**
 * - `link`: one page's body mentions or links to the other.
 * - `relation`: a database row relates to the other (a relation property).
 * - `child`: the other is inside this page (the page tree; rows are inside their database).
 */
export type GraphEdgeKind = "link" | "relation" | "child";

/** Edges have no direction: one per pair of pages, of the first kind in EDGE_KINDS that joins them. */
export type GraphEdge = { source: string; target: string; kind: GraphEdgeKind };

export type WorkspaceGraph = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** More pages than the graph shows: the ones edited longest ago were left out. */
  truncated: boolean;
};

/** Which edge a pair of pages keeps when several join them. */
export const EDGE_KINDS: GraphEdgeKind[] = ["link", "relation", "child"];

export const MAX_DEPTH = 3;

/** One key per pair of pages, whichever way round. */
export const pairKey = (a: string, b: string) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

/**
 * Keeps one edge per pair (the first kind in EDGE_KINDS), drops edges to themselves and edges whose
 * ends aren't both nodes.
 */
export function uniqueEdges(edges: GraphEdge[], nodeIds: Set<string>): GraphEdge[] {
  const rank = (kind: GraphEdgeKind) => EDGE_KINDS.indexOf(kind);
  const kept = new Map<string, GraphEdge>();
  for (const edge of edges) {
    if (edge.source === edge.target || !nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
    const key = pairKey(edge.source, edge.target);
    const before = kept.get(key);
    if (!before || rank(edge.kind) < rank(before.kind)) kept.set(key, edge);
  }
  return [...kept.values()];
}

export type GraphFilter = {
  /** Show the page tree's edges. */
  tree: boolean;
  /** Show database rows (and their edges). */
  rows: boolean;
  /** Show pages without edges (after the other choices). */
  orphans: boolean;
  /** Only this page and the pages up to `depth` edges away from it. */
  focus: string | null;
  depth: number;
};

export const DEFAULT_FILTER: GraphFilter = { tree: true, rows: true, orphans: true, focus: null, depth: 1 };

/** The pages within `depth` edges of `focus` (itself included), through `edges`. */
export function neighborhood(edges: GraphEdge[], focus: string, depth: number): Set<string> {
  const next = new Map<string, string[]>();
  for (const { source, target } of edges) {
    next.set(source, [...(next.get(source) ?? []), target]);
    next.set(target, [...(next.get(target) ?? []), source]);
  }
  const seen = new Set([focus]);
  let frontier = [focus];
  for (let step = 0; step < depth && frontier.length; step++) {
    const found: string[] = [];
    for (const id of frontier) {
      for (const other of next.get(id) ?? []) {
        if (seen.has(other)) continue;
        seen.add(other);
        found.push(other);
      }
    }
    frontier = found;
  }
  return seen;
}

/**
 * The part of the graph the filter shows. The focused page stays even when its kind is filtered out
 * or it has no edges; a focus that isn't in the graph shows nothing.
 */
export function filterGraph(graph: Pick<WorkspaceGraph, "nodes" | "edges">, filter: GraphFilter): Pick<WorkspaceGraph, "nodes" | "edges"> {
  const focus = filter.focus && graph.nodes.some((n) => n.id === filter.focus) ? filter.focus : null;
  if (filter.focus && !focus) return { nodes: [], edges: [] };
  let nodes = graph.nodes.filter((n) => filter.rows || n.kind !== "row" || n.id === focus);
  let ids = new Set(nodes.map((n) => n.id));
  let edges = graph.edges.filter((e) => (filter.tree || e.kind !== "child") && ids.has(e.source) && ids.has(e.target));
  if (focus) {
    const near = neighborhood(edges, focus, Math.min(Math.max(1, filter.depth), MAX_DEPTH));
    nodes = nodes.filter((n) => near.has(n.id));
    ids = new Set(nodes.map((n) => n.id));
    edges = edges.filter((e) => ids.has(e.source) && ids.has(e.target));
  }
  if (!filter.orphans) {
    const joined = new Set(edges.flatMap((e) => [e.source, e.target]));
    nodes = nodes.filter((n) => joined.has(n.id) || n.id === focus);
  }
  return { nodes, edges };
}

/** How many edges each page has. */
export function degrees(edges: GraphEdge[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const { source, target } of edges) {
    out.set(source, (out.get(source) ?? 0) + 1);
    out.set(target, (out.get(target) ?? 0) + 1);
  }
  return out;
}

/** Past this many rows in view, a database's rows are drawn as the database until it's expanded. */
export const CLUSTER_ROWS = 30;

/** A database standing in for its rows: `rows` of them are drawn as it. */
export type ClusteredNode = GraphNode & { rows?: number };

/** An edge standing in for `weight` edges (more than one where rows were drawn as their database). */
export type ClusteredEdge = GraphEdge & { weight: number };

export type ClusteredGraph = { nodes: ClusteredNode[]; edges: ClusteredEdge[] };

/**
 * Draws the rows of each database with more than `threshold` rows in `graph` as the database: the
 * database counts them, their edges lead to it instead (one edge per pair of pages, weighed by how
 * many it stands for, of the first kind in EDGE_KINDS among them) and edges between its own rows
 * and to the database fall away. Databases in `expanded` keep their rows, and so do the rows in
 * `keep` (a focused row). Rows whose database isn't in the graph stay as they are: nothing stands
 * in for a page the viewer can't open.
 */
export function clusterRows(
  graph: Pick<WorkspaceGraph, "nodes" | "edges">,
  { threshold = CLUSTER_ROWS, expanded = new Set<string>(), keep = new Set<string>() }: { threshold?: number; expanded?: Set<string>; keep?: Set<string> } = {},
): ClusteredGraph {
  const ids = new Set(graph.nodes.map((n) => n.id));
  const rowCount = new Map<string, number>();
  for (const n of graph.nodes) if (n.kind === "row" && n.parent && ids.has(n.parent)) rowCount.set(n.parent, (rowCount.get(n.parent) ?? 0) + 1);
  const clustered = new Set([...rowCount].filter(([id, count]) => count > threshold && !expanded.has(id)).map(([id]) => id));
  // Each page and what draws it.
  const drawnAs = new Map<string, string>();
  const hidden = new Map<string, number>();
  for (const n of graph.nodes) {
    const into = n.kind === "row" && n.parent && clustered.has(n.parent) && !keep.has(n.id) ? n.parent : n.id;
    drawnAs.set(n.id, into);
    if (into !== n.id) hidden.set(into, (hidden.get(into) ?? 0) + 1);
  }
  if (!hidden.size) return { nodes: graph.nodes, edges: graph.edges.map((e) => ({ ...e, weight: 1 })) };

  const nodes = graph.nodes
    .filter((n) => drawnAs.get(n.id) === n.id)
    .map((n) => (hidden.has(n.id) ? { ...n, rows: hidden.get(n.id) } : n));
  const rank = (kind: GraphEdgeKind) => EDGE_KINDS.indexOf(kind);
  const edges = new Map<string, ClusteredEdge>();
  for (const e of graph.edges) {
    const source = drawnAs.get(e.source) ?? e.source;
    const target = drawnAs.get(e.target) ?? e.target;
    if (source === target) continue;
    const key = pairKey(source, target);
    const before = edges.get(key);
    if (!before) edges.set(key, { source, target, kind: e.kind, weight: 1 });
    else edges.set(key, { ...before, kind: rank(e.kind) < rank(before.kind) ? e.kind : before.kind, weight: before.weight + 1 });
  }
  return { nodes, edges: [...edges.values()] };
}

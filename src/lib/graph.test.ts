import { describe, expect, it } from "vitest";
import { DEFAULT_FILTER, degrees, filterGraph, neighborhood, uniqueEdges, type GraphEdge, type GraphNode } from "./graph";

const node = (id: string, kind: GraphNode["kind"] = "page"): GraphNode => ({ id, title: id, icon: null, kind });
const edge = (source: string, target: string, kind: GraphEdge["kind"] = "link"): GraphEdge => ({ source, target, kind });
const ids = (list: { id: string }[]) => list.map((n) => n.id).sort();

describe("uniqueEdges", () => {
  it("keeps one edge per pair, the strongest kind, and only between nodes", () => {
    const edges = uniqueEdges(
      [edge("a", "b", "child"), edge("b", "a", "link"), edge("a", "b", "relation"), edge("a", "a"), edge("a", "x")],
      new Set(["a", "b"]),
    );
    expect(edges).toEqual([edge("b", "a", "link")]);
  });
});

describe("neighborhood", () => {
  it("walks edges both ways up to the depth", () => {
    const edges = [edge("a", "b"), edge("c", "b"), edge("c", "d"), edge("x", "y")];
    expect([...neighborhood(edges, "a", 1)].sort()).toEqual(["a", "b"]);
    expect([...neighborhood(edges, "a", 2)].sort()).toEqual(["a", "b", "c"]);
    expect([...neighborhood(edges, "a", 3)].sort()).toEqual(["a", "b", "c", "d"]);
  });
});

describe("filterGraph", () => {
  const graph = {
    nodes: [node("home"), node("notes"), node("db", "database"), node("row1", "row"), node("row2", "row"), node("lonely")],
    edges: [edge("home", "notes", "child"), edge("db", "row1", "child"), edge("db", "row2", "child"), edge("row1", "notes", "relation"), edge("notes", "row2")],
  };

  it("shows everything by default", () => {
    expect(filterGraph(graph, DEFAULT_FILTER)).toEqual(graph);
  });

  it("hides the page tree's edges, rows with their edges, and pages left without edges", () => {
    const noTree = filterGraph(graph, { ...DEFAULT_FILTER, tree: false });
    expect(noTree.edges.map((e) => e.kind).sort()).toEqual(["link", "relation"]);
    const noRows = filterGraph(graph, { ...DEFAULT_FILTER, rows: false });
    expect(ids(noRows.nodes)).toEqual(["db", "home", "lonely", "notes"]);
    expect(noRows.edges).toEqual([edge("home", "notes", "child")]);
    const joined = filterGraph(graph, { ...DEFAULT_FILTER, rows: false, orphans: false });
    expect(ids(joined.nodes)).toEqual(["home", "notes"]);
  });

  it("focuses on a page and its neighbours, keeping the page itself", () => {
    expect(ids(filterGraph(graph, { ...DEFAULT_FILTER, focus: "home" }).nodes)).toEqual(["home", "notes"]);
    expect(ids(filterGraph(graph, { ...DEFAULT_FILTER, focus: "home", depth: 2 }).nodes)).toEqual(["home", "notes", "row1", "row2"]);
    expect(ids(filterGraph(graph, { ...DEFAULT_FILTER, focus: "lonely", orphans: false }).nodes)).toEqual(["lonely"]);
    expect(ids(filterGraph(graph, { ...DEFAULT_FILTER, focus: "row1", rows: false }).nodes)).toEqual(["db", "notes", "row1"]);
    expect(filterGraph(graph, { ...DEFAULT_FILTER, focus: "missing" })).toEqual({ nodes: [], edges: [] });
  });

  it("caps the depth", () => {
    const chain = { nodes: ["a", "b", "c", "d", "e"].map((id) => node(id)), edges: [edge("a", "b"), edge("b", "c"), edge("c", "d"), edge("d", "e")] };
    expect(ids(filterGraph(chain, { ...DEFAULT_FILTER, focus: "a", depth: 9 }).nodes)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("degrees", () => {
  it("counts each page's edges", () => {
    expect(degrees([edge("a", "b"), edge("a", "c")])).toEqual(new Map([["a", 2], ["b", 1], ["c", 1]]));
  });
});

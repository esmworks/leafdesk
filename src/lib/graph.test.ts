import { describe, expect, it } from "vitest";
import { clusterRows, DEFAULT_FILTER, degrees, filterGraph, neighborhood, uniqueEdges, type GraphEdge, type GraphNode } from "./graph";

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

describe("clusterRows", () => {
  const row = (id: string, parent: string): GraphNode => ({ ...node(id, "row"), parent });
  // Two databases of three rows each; every order relates to a customer, a page links to one.
  const graph = {
    nodes: [
      node("customers", "database"),
      row("c1", "customers"),
      row("c2", "customers"),
      row("c3", "customers"),
      node("orders", "database"),
      row("o1", "orders"),
      row("o2", "orders"),
      row("o3", "orders"),
      node("notes"),
    ],
    edges: [
      ...["c1", "c2", "c3"].map((id) => edge("customers", id, "child")),
      ...["o1", "o2", "o3"].map((id) => edge("orders", id, "child")),
      edge("o1", "c1", "relation"),
      edge("o2", "c1", "relation"),
      edge("o3", "c2", "relation"),
      edge("c1", "c2", "relation"),
      edge("notes", "c3"),
    ],
  };
  const weights = (edges: { source: string; target: string; kind: string; weight: number }[]) =>
    Object.fromEntries(edges.map((e) => [[e.source, e.target].sort().join("-"), `${e.kind}×${e.weight}`]));

  it("leaves a database at the threshold as it is", () => {
    const out = clusterRows(graph, { threshold: 3 });
    expect(ids(out.nodes)).toEqual(ids(graph.nodes));
    expect(out.edges.every((e) => e.weight === 1)).toBe(true);
  });

  it("draws the rows of databases past it as the database, their edges weighed", () => {
    const out = clusterRows(graph, { threshold: 2 });
    expect(ids(out.nodes)).toEqual(["customers", "notes", "orders"]);
    expect(out.nodes.find((n) => n.id === "customers")?.rows).toBe(3);
    // Three relations become one edge between the databases; the page tree and c1-c2 fall away.
    expect(weights(out.edges)).toEqual({ "customers-orders": "relation×3", "customers-notes": "link×1" });
  });

  it("keeps the rows of an expanded database, and a kept row", () => {
    const expanded = clusterRows(graph, { threshold: 2, expanded: new Set(["orders"]) });
    expect(ids(expanded.nodes)).toEqual(["customers", "notes", "o1", "o2", "o3", "orders"]);
    expect(weights(expanded.edges)).toEqual({
      "o1-orders": "child×1",
      "o2-orders": "child×1",
      "o3-orders": "child×1",
      "customers-o1": "relation×1",
      "customers-o2": "relation×1",
      "customers-o3": "relation×1",
      "customers-notes": "link×1",
    });
    const kept = clusterRows(graph, { threshold: 2, keep: new Set(["c1"]) });
    expect(ids(kept.nodes)).toEqual(["c1", "customers", "notes", "orders"]);
    expect(kept.nodes.find((n) => n.id === "customers")?.rows).toBe(2);
    expect(weights(kept.edges)).toEqual({ "c1-customers": "relation×2", "c1-orders": "relation×2", "customers-orders": "relation×1", "customers-notes": "link×1" });
  });

  it("leaves rows alone whose database isn't in the graph", () => {
    const rowsOnly = { nodes: graph.nodes.filter((n) => n.id !== "customers"), edges: graph.edges.filter((e) => e.source !== "customers") };
    const out = clusterRows(rowsOnly, { threshold: 2 });
    expect(ids(out.nodes)).toEqual(["c1", "c2", "c3", "notes", "orders"]);
    expect(out.nodes.some((n) => "rows" in n && n.id !== "orders")).toBe(false);
  });
});

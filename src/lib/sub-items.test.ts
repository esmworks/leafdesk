import { describe, expect, it } from "vitest";
import type { RelationConfig } from "@/db/schema/app";
import {
  makesLoop,
  parentProperty,
  parentsAmong,
  singleParent,
  subItemCounts,
  subItemLines,
  subItemsDisplay,
  subItemsProperty,
  topRows,
} from "./sub-items";

const P = "parent";
const row = (id: string, parent?: string | string[]) => ({
  id,
  properties: parent === undefined ? {} : { [P]: Array.isArray(parent) ? parent : [parent] },
});
const shape = (lines: { row: { id: string }; depth: number; children: number; open: boolean }[]) =>
  lines.map((l) => `${"  ".repeat(l.depth)}${l.row.id}${l.children ? ` (${l.children}${l.open ? "" : ", closed"})` : ""}`);

describe("sub-items properties", () => {
  const relation = (id: string, options: RelationConfig) => ({ id, databaseId: "db", type: "relation", options: { relation: options } });
  it("finds the parent property and its other side only on a relation of the database with itself", () => {
    const parent = relation("p", { databaseId: "db", pairedPropertyId: "s", role: "parent" });
    const subs = relation("s", { databaseId: "db", pairedPropertyId: "p" });
    expect(parentProperty([subs, parent])).toBe(parent);
    expect(subItemsProperty([subs, parent])).toBe(subs);
    expect(parentProperty([relation("x", { databaseId: "other", role: "parent" })])).toBeNull();
    expect(parentProperty([subs])).toBeNull();
    // The other side deleted: the tree still works, nothing lists the sub-items.
    expect(subItemsProperty([relation("p", { databaseId: "db", pairedPropertyId: null, role: "parent" })])).toBeNull();
  });

  it("shows views nested unless they say otherwise, and flat without sub-items", () => {
    const parent = relation("p", { databaseId: "db", role: "parent" });
    expect(subItemsDisplay({}, parent)).toBe("nested");
    expect(subItemsDisplay({ subItems: "parents" }, parent)).toBe("parents");
    expect(subItemsDisplay({ subItems: "nested" }, null)).toBe("flat");
  });
});

describe("parentsAmong", () => {
  it("takes the first parent, ignores rows naming themselves or missing rows", () => {
    const parents = parentsAmong([row("a"), row("b", ["a", "c"]), row("c", "c"), row("d", "gone")], P);
    expect(Object.fromEntries(parents)).toEqual({ a: null, b: "a", c: null, d: null });
  });

  it("breaks a loop at the row that comes first", () => {
    const rows = [row("a", "c"), row("b", "a"), row("c", "b")];
    expect(Object.fromEntries(parentsAmong(rows, P))).toEqual({ a: null, b: "a", c: "b" });
    // Another order breaks it elsewhere, still leaving every row reachable.
    expect(Object.fromEntries(parentsAmong([rows[1], rows[2], rows[0]], P))).toEqual({ b: null, c: "b", a: "c" });
  });

  it("keeps a row hanging under a loop it isn't part of", () => {
    const parents = parentsAmong([row("d", "a"), row("a", "b"), row("b", "a")], P);
    expect(parents.get("d")).toBe("a");
    expect([parents.get("a"), parents.get("b")]).toContain(null);
  });
});

describe("subItemLines", () => {
  const rows = [row("a"), row("a1", "a"), row("b"), row("a2", "a"), row("a1x", "a1")];
  it("puts sub-items under their parent in the given order, when open", () => {
    expect(shape(subItemLines(rows, P, () => true))).toEqual(["a (2)", "  a1 (1)", "    a1x", "  a2", "b"]);
    expect(shape(subItemLines(rows, P, (id) => id === "a"))).toEqual(["a (2)", "  a1 (1, closed)", "  a2", "b"]);
    expect(shape(subItemLines(rows, P, () => false))).toEqual(["a (2, closed)", "b"]);
  });

  it("shows a row whose parent isn't shown as a top row", () => {
    expect(shape(subItemLines([row("a1x", "a1"), row("b")], P, () => true))).toEqual(["a1x", "b"]);
  });

  it("shows every row of a loop once", () => {
    const lines = subItemLines([row("a", "b"), row("b", "a")], P, () => true);
    expect(shape(lines)).toEqual(["a (1)", "  b"]);
  });
});

describe("topRows and subItemCounts", () => {
  const all = [row("a"), row("a1", "a"), row("b"), row("a2", "a"), row("a1x", "a1")];
  it("keeps rows without a parent in the whole database", () => {
    // a1x is shown (a filter let it through) but its parent exists, so it isn't a top row.
    expect(topRows([all[0], all[4], all[2]], all, P).map((r) => r.id)).toEqual(["a", "b"]);
    expect(Object.fromEntries(subItemCounts(all, P))).toEqual({ a: 2, a1: 1 });
  });
});

describe("singleParent and makesLoop", () => {
  it("keeps the newly added parent", () => {
    expect(singleParent(["old", "new"], ["old"])).toEqual(["new"]);
    expect(singleParent(["x", "y"], [])).toEqual(["y"]);
    expect(singleParent(["x", "y"], ["x", "y"])).toEqual(["y"]);
    expect(singleParent(["x"], [])).toEqual(["x"]);
  });

  it("refuses a parent that is the row itself or below it", () => {
    const parents = new Map<string, string | null>([
      ["a", null],
      ["b", "a"],
      ["c", "b"],
      ["x", "y"],
      ["y", "x"],
    ]);
    expect(makesLoop(parents, "a", "c")).toBe(true);
    expect(makesLoop(parents, "a", "a")).toBe(true);
    expect(makesLoop(parents, "c", "a")).toBe(false);
    // An old loop elsewhere doesn't hang the check.
    expect(makesLoop(parents, "a", "x")).toBe(false);
  });
});

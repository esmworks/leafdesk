import { describe, expect, it } from "vitest";
import { carryOverBlockIds } from "./page-markdown";

type B = { id?: string; type: string; props?: Record<string, unknown>; content?: unknown; children?: B[] };
const p = (text: string, id?: string, children: B[] = []): B => ({ id, type: "paragraph", content: [{ type: "text", text, styles: {} }], children });

describe("carryOverBlockIds", () => {
  it("gives unchanged blocks their ids back, in order", () => {
    const existing = [p("One", "a"), p("Two", "b"), p("Three", "c")];
    const written = [p("One", "n1"), p("New", "n2"), p("Three", "n3")];
    carryOverBlockIds(written, existing);
    expect(written.map((b) => b.id)).toEqual(["a", "n2", "c"]);
  });

  it("matches repeated text in order, each id once", () => {
    const existing = [p("Same", "a"), p("Same", "b")];
    const written = [p("Same", "x"), p("Other", "y"), p("Same", "z"), p("Same", "w")];
    carryOverBlockIds(written, existing);
    expect(written.map((b) => b.id)).toEqual(["a", "y", "b", "w"]);
  });

  it("goes into nested blocks of matched blocks", () => {
    const existing = [p("Parent", "a", [p("Kid", "k"), p("Old kid", "o")])];
    const written = [p("Parent", "x", [p("Kid", "y")])];
    carryOverBlockIds(written, existing);
    expect(written[0].id).toBe("a");
    expect(written[0].children![0].id).toBe("k");
  });

  it("tells blocks without text apart by what they refer to", () => {
    const db = (databaseId: string, id?: string): B => ({ id, type: "database", props: { databaseId }, children: [] });
    const existing = [db("d1", "a"), db("d2", "b")];
    const written = [db("d2", "x"), db("d1", "y")];
    carryOverBlockIds(written, existing);
    // Order decides which one keeps its id when they swap: only one of them can.
    expect(written.filter((b) => b.id === "a" || b.id === "b")).toHaveLength(1);
    // …and never another database's.
    for (const block of written) if (block.id === "a" || block.id === "b") expect(block.id).toBe(block.props!.databaseId === "d1" ? "a" : "b");
  });

  it("leaves alone blocks that came back with their own ids", () => {
    const existing = [p("One", "a"), p("Two", "b")];
    // "Two" came back as it was (a restored block), "One" was parsed anew.
    const written = [p("One", "x"), p("Two", "b")];
    carryOverBlockIds(written, existing);
    expect(written.map((b) => b.id)).toEqual(["a", "b"]);
  });

  it("ignores formatting and props, and reads string content", () => {
    const existing: B[] = [{ id: "m", type: "math", props: {}, content: [{ type: "text", text: "x^2", styles: {} }], children: [] }];
    const written: B[] = [{ type: "math", content: "x^2", children: [] }];
    carryOverBlockIds(written, existing);
    expect(written[0].id).toBe("m");
  });
});

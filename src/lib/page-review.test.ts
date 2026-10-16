import { describe, expect, it } from "vitest";
import { changeIds, reviewChanges, trimTrailingEmpty, undoChange, withoutKept, type ReviewBlock } from "./page-review";

const p = (id: string, text: string, children: ReviewBlock[] = []): ReviewBlock => ({
  id,
  type: "paragraph",
  props: { textColor: "default" },
  content: text ? [{ type: "text", text, styles: {} }] : [],
  children,
});
const h = (id: string, text: string): ReviewBlock => ({ id, type: "heading", props: { level: 2 }, content: [{ type: "text", text, styles: {} }], children: [] });

/** The body as text lines, children indented. */
function lines(blocks: readonly ReviewBlock[], depth = 0): string[] {
  return blocks.flatMap((b) => {
    const text = Array.isArray(b.content) ? b.content.map((n) => (n as { text?: string }).text ?? "").join("") : "";
    const own = b.type === "columnList" || b.type === "column" ? [] : [`${"  ".repeat(depth)}${b.type === "heading" ? "# " : ""}${text}`];
    return [...own, ...lines(b.children ?? [], b.type === "columnList" || b.type === "column" ? depth : depth + 1)];
  });
}

/** Undoes every change, one at a time, as the review does: the body comes back to `before`. */
function undoAll(before: ReviewBlock[], after: ReviewBlock[]) {
  let live = after;
  for (let guard = 0; guard < 50; guard++) {
    const changes = reviewChanges(before, live);
    const index = changes.findIndex((c) => c.op !== "same");
    if (index < 0) return live;
    const next = undoChange(live, changes, index);
    if (!next) throw new Error("could not undo");
    live = next;
  }
  throw new Error("did not settle");
}

describe("reviewChanges", () => {
  it("leaves out trailing empty paragraphs", () => {
    expect(trimTrailingEmpty([p("a", "One"), p("b", ""), p("c", "")]).map((b) => b.id)).toEqual(["a"]);
    const changes = reviewChanges([p("a", "One")], [p("a", "One"), p("b", "")]);
    expect(changes.map((c) => c.op)).toEqual(["same"]);
  });

  it("gives changes ids that stay while others are undone", () => {
    const before = [p("a", "One"), p("b", "Two"), p("c", "Three")];
    const after = [p("a", "One"), p("x", "Two and a half"), p("c", "Three"), p("y", "Four")];
    const changes = reviewChanges(before, after);
    const ids = changeIds(changes);
    expect(changes.map((c) => c.op)).toEqual(["same", "changed", "same", "added"]);
    const next = undoChange(after, changes, 3)!;
    const again = changeIds(reviewChanges(before, next));
    expect(again[1]).toBe(ids[1]);
  });

  it("shows kept changes as they are now", () => {
    const before = [p("a", "One"), p("b", "Two")];
    const after = [p("a", "One"), p("c", "Three")];
    const changes = reviewChanges(before, after);
    const ids = changeIds(changes);
    expect(changes.map((c) => c.op)).toEqual(["same", "removed", "added"]);
    const shown = withoutKept(changes, ids, new Set([ids[1]!, ids[2]!]));
    expect(shown.map((s) => s.change.op)).toEqual(["same", "same"]);
  });
});

describe("undoChange", () => {
  it("removes an added block, keeping its children", () => {
    const before = [p("a", "One"), p("c", "Child")];
    const after = [p("a", "One"), p("b", "New", [p("c", "Child")])];
    const changes = reviewChanges(before, after);
    const index = changes.findIndex((c) => c.op === "added");
    expect(lines(undoChange(after, changes, index)!)).toEqual(["One", "Child"]);
  });

  it("gives a changed block back its text and type", () => {
    const before = [p("a", "One"), h("b", "Plan for the week")];
    const after = [p("a", "One"), p("b", "Plan for the month")];
    const changes = reviewChanges(before, after);
    const index = changes.findIndex((c) => c.op === "changed");
    const undone = undoChange(after, changes, index)!;
    expect(undone[1]).toMatchObject({ id: "b", type: "heading", props: { level: 2 } });
    expect(lines(undone)).toEqual(["One", "# Plan for the week"]);
  });

  it("puts a removed block back after the block before it", () => {
    const before = [p("a", "One"), p("b", "Two"), p("c", "Three")];
    const after = [p("a", "One"), p("c", "Three")];
    const changes = reviewChanges(before, after);
    const undone = undoChange(after, changes, changes.findIndex((c) => c.op === "removed"))!;
    expect(lines(undone)).toEqual(["One", "Two", "Three"]);
    expect(undone[1].id).toBe("b");
  });

  it("puts a removed first block back at the top, and a removed child under its parent", () => {
    const before = [p("a", "One", [p("b", "Child"), p("c", "Second child")]), p("d", "Two")];
    const after = [p("a", "One", [p("c", "Second child")]), p("d", "Two")];
    let changes = reviewChanges(before, after);
    expect(lines(undoChange(after, changes, changes.findIndex((c) => c.op === "removed"))!)).toEqual(["One", "  Child", "  Second child", "Two"]);

    const shorter = [p("d", "Two")];
    changes = reviewChanges([p("a", "One"), p("d", "Two")], shorter);
    expect(lines(undoChange(shorter, changes, 0)!)).toEqual(["One", "Two"]);
  });

  it("gives a block put back a new id when its id is taken", () => {
    const before = [p("a", "One"), p("b", "Two")];
    const after = [p("b", "Something else entirely here")];
    const changes = reviewChanges(before, after);
    expect(changes.map((c) => c.op)).toEqual(["removed", "removed", "added"]);
    const undone = undoChange(after, changes, 1)!;
    expect(undone.map((b) => b.id).filter((id) => id === "b")).toHaveLength(1);
  });

  it("removes a column left empty", () => {
    const before = [p("a", "One")];
    const after: ReviewBlock[] = [
      p("a", "One"),
      { id: "cl", type: "columnList", props: {}, children: [
        { id: "c1", type: "column", props: {}, children: [p("x", "Left")] },
        { id: "c2", type: "column", props: {}, children: [p("y", "Right")] },
      ] },
    ];
    const changes = reviewChanges(before, after);
    const undone = undoChange(after, changes, changes.findIndex((c) => c.op === "added" && c.block.id === "x"))!;
    expect(undone.map((b) => b.type)).toEqual(["paragraph", "paragraph"]);
    expect(lines(undone)).toEqual(["One", "Right"]);
  });

  it("brings a body back to what it was, one change at a time", () => {
    const before = [h("t", "Plan"), p("a", "Monday: write"), p("b", "Tuesday: review", [p("b1", "with the team")]), p("c", "Friday: ship")];
    const after = [h("t", "Plan for next week"), p("x", "Monday: write the draft"), p("y", "Wednesday: test"), p("c", "Friday: ship"), p("z", "Saturday: rest")];
    expect(lines(undoAll(before, after))).toEqual(lines(before));
  });
});

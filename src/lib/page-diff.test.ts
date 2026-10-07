import { describe, expect, it } from "vitest";
import {
  changeActors,
  diffBlocks,
  diffSequence,
  diffToText,
  diffWords,
  flattenBlocks,
  foldUnchanged,
  onlyFormatChanged,
  similarity,
  type BlockInput,
} from "./page-diff";

const p = (text: string, children: BlockInput[] = []): BlockInput => ({
  type: "paragraph",
  props: {},
  content: [{ type: "text", text, styles: {} }],
  children,
});
const blocks = (...list: BlockInput[]) => flattenBlocks(list);

describe("diffSequence", () => {
  it("keeps common ends and orders deletions before additions", () => {
    const ops = diffSequence("abcxd".split(""), "abyd".split(""), (x, y) => x === y).map((e) => e.op);
    expect(ops).toEqual(["eq", "eq", "del", "del", "add", "eq"]);
  });

  it("finds a longest common subsequence", () => {
    const edits = diffSequence("ABCBDAB".split(""), "BDCABA".split(""), (x, y) => x === y);
    expect(edits.filter((e) => e.op === "eq")).toHaveLength(4);
    // Every element of both sides appears exactly once.
    expect(edits.filter((e) => e.op !== "add").map((e) => e.a)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(edits.filter((e) => e.op !== "del").map((e) => e.b)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("handles empty sides", () => {
    expect(diffSequence([], [1, 2], (x, y) => x === y).map((e) => e.op)).toEqual(["add", "add"]);
    expect(diffSequence([1], [], (x, y) => x === y).map((e) => e.op)).toEqual(["del"]);
  });
});

describe("diffWords", () => {
  it("marks removed and added words", () => {
    expect(diffWords("The quick fox", "The slow fox")).toEqual([
      { op: "eq", text: "The " },
      { op: "del", text: "quick" },
      { op: "add", text: "slow" },
      { op: "eq", text: " fox" },
    ]);
  });

  it("joins neighboring changed words into one replacement", () => {
    expect(diffWords("a quick brown fox", "a slow red fox")).toEqual([
      { op: "eq", text: "a " },
      { op: "del", text: "quick brown" },
      { op: "add", text: "slow red" },
      { op: "eq", text: " fox" },
    ]);
  });

  it("splits punctuation and keeps Turkish letters in words", () => {
    expect(diffWords("Çalışma planı.", "Çalışma planı!")).toEqual([
      { op: "eq", text: "Çalışma planı" },
      { op: "del", text: "." },
      { op: "add", text: "!" },
    ]);
  });

  it("returns the text unchanged when nothing differs", () => {
    expect(diffWords("same", "same")).toEqual([{ op: "eq", text: "same" }]);
  });
});

describe("similarity", () => {
  it("compares words, not spacing", () => {
    expect(similarity("a b c", "a  b   c")).toBe(1);
    expect(similarity("", "")).toBe(1);
    expect(similarity("one two", "three four")).toBe(0);
    expect(similarity("one two three four", "one two three five")).toBeCloseTo(0.75);
  });
});

describe("flattenBlocks", () => {
  it("puts children after their parent and numbers list items", () => {
    const flat = flattenBlocks([
      { type: "heading", props: { level: 2 }, content: [{ type: "text", text: "Plan", styles: {} }] },
      { type: "numberedListItem", props: {}, content: "one", children: [p("nested")] },
      { type: "numberedListItem", props: {}, content: "two" },
      p("after"),
      { type: "numberedListItem", props: { start: 5 }, content: "five" },
      { type: "checkListItem", props: { checked: true }, content: "done" },
      { type: "image", props: { url: "https://x.test/a.png", caption: "" } },
      {
        type: "table",
        props: {},
        content: { type: "tableContent", rows: [{ cells: [[{ type: "text", text: "a" }], { content: [{ type: "text", text: "b" }] }] }] },
      },
    ]);
    expect(flat.map((b) => [b.type, b.depth, b.text, b.ordinal])).toEqual([
      ["heading", 0, "Plan", undefined],
      ["numberedListItem", 0, "one", 1],
      ["paragraph", 1, "nested", undefined],
      ["numberedListItem", 0, "two", 2],
      ["paragraph", 0, "after", undefined],
      ["numberedListItem", 0, "five", 5],
      ["checkListItem", 0, "done", undefined],
      ["image", 0, "https://x.test/a.png", undefined],
      ["table", 0, "a | b", undefined],
    ]);
    expect(flat[0].level).toBe(2);
    expect(flat[6].checked).toBe(true);
    expect(flat[7].url).toBe("https://x.test/a.png");
  });

  it("reads link text", () => {
    const [block] = flattenBlocks([
      { type: "paragraph", content: [{ type: "link", href: "https://x.test", content: [{ type: "text", text: "site" }] }] },
    ]);
    expect(block.text).toBe("site");
  });
});

describe("diffBlocks", () => {
  it("finds added, removed and edited blocks", () => {
    const before = blocks(p("Intro"), p("Keep this"), p("The quick fox jumps"), p("Old ending"));
    const after = blocks(p("Intro"), p("Keep this"), p("The slow fox jumps"), p("A new paragraph"), p("Totally different"));
    const changes = diffBlocks(before, after);
    expect(changes.map((c) => c.op)).toEqual(["same", "same", "changed", "removed", "added", "added"]);
    const changed = changes[2];
    expect(changed.op === "changed" && changed.words.filter((w) => w.op !== "eq").map((w) => w.text)).toEqual([
      "quick",
      "slow",
    ]);
  });

  it("treats a paragraph turned into a heading as changed formatting", () => {
    const before = blocks(p("Title text"));
    const after = flattenBlocks([{ type: "heading", props: { level: 1 }, content: [{ type: "text", text: "Title text", styles: {} }] }]);
    const [change] = diffBlocks(before, after);
    expect(change.op).toBe("changed");
    expect(onlyFormatChanged(change)).toBe(true);
  });

  it("notices styles and checkbox changes", () => {
    const bold = flattenBlocks([{ type: "paragraph", content: [{ type: "text", text: "Hi", styles: { bold: true } }] }]);
    expect(diffBlocks(blocks(p("Hi")), bold)[0].op).toBe("changed");
    const todo = (checked: boolean) => flattenBlocks([{ type: "checkListItem", props: { checked }, content: "Ship" }]);
    expect(diffBlocks(todo(false), todo(true))[0].op).toBe("changed");
  });

  it("reports identical bodies as unchanged", () => {
    const list = blocks(p("a", [p("b")]), p("c"));
    expect(diffBlocks(list, list).every((c) => c.op === "same")).toBe(true);
  });

  it("does not pair blocks that share no words", () => {
    expect(diffBlocks(blocks(p("alpha beta")), blocks(p("gamma delta"))).map((c) => c.op)).toEqual(["removed", "added"]);
  });
});

describe("foldUnchanged", () => {
  it("hides long unchanged runs but keeps one block of context", () => {
    const before = blocks(...["1", "2", "3", "4", "5", "6"].map((t) => p(t)));
    const after = blocks(...["1", "2", "3", "4", "5", "6 changed"].map((t) => p(t)));
    const items = foldUnchanged(diffBlocks(before, after));
    expect(items.map((i) => i.op)).toEqual(["hidden", "same", "changed"]);
    expect(items[0].op === "hidden" && items[0].blocks.map((b) => b.text)).toEqual(["1", "2", "3", "4"]);
  });

  it("keeps short runs between changes visible", () => {
    const before = blocks(p("x one"), p("a"), p("b"), p("y one"));
    const after = blocks(p("x two"), p("a"), p("b"), p("y two"));
    expect(foldUnchanged(diffBlocks(before, after)).map((i) => i.op)).toEqual(["changed", "same", "same", "changed"]);
  });
});

describe("changeActors", () => {
  const v = (reason: Parameters<typeof changeActors>[0][number]["reason"], userName: string | null, clientName: string | null = null) => ({
    reason,
    userName,
    clientName,
  });

  it("marks agents", () => {
    expect(changeActors([v("auto", "Ada"), { reason: "current", userName: "Ticket triager", clientName: null, isAgent: true }])).toEqual([
      { name: "Ticket triager", client: null, isAgent: true },
    ]);
  });

  it("names the AI app behind an MCP write and whoever saved the newer version", () => {
    expect(changeActors([v("before_mcp_write", "Erhan", "Claude"), v("auto", "Ada")])).toEqual([
      { name: "Erhan", client: "Claude" },
      { name: "Ada", client: null },
    ]);
  });

  it("takes a save right after an AI write for the same person to be that write", () => {
    expect(changeActors([v("before_mcp_write", "Erhan", "Claude"), v("current", "Erhan")])).toEqual([
      { name: "Erhan", client: "Claude" },
    ]);
    expect(changeActors([v("before_mcp_write", "Erhan", "Claude"), v("auto", "Ada")])).toHaveLength(2);
  });

  it("ignores the change that follows the newer version and the author of the older one", () => {
    expect(changeActors([v("auto", "Ada"), v("before_mcp_write", "Erhan", "Claude")])).toEqual([]);
  });

  it("collects everyone up to the current page without repeats", () => {
    expect(
      changeActors([
        v("auto", "Old"),
        v("before_restore", "Ada"),
        v("auto", "Ada"),
        v("before_mcp_write", "Ada", "Cursor"),
        v("current", "Bob"),
      ]),
    ).toEqual([
      { name: "Ada", client: null },
      { name: "Ada", client: "Cursor" },
      { name: "Bob", client: null },
    ]);
  });
});

describe("diffToText", () => {
  it("prints changes with markers and folds unchanged blocks", () => {
    const before = blocks(p("1"), p("2"), p("3"), p("The quick fox"), p("gone"));
    const after = flattenBlocks([
      p("1"),
      p("2"),
      p("3"),
      p("The slow fox"),
      { type: "bulletListItem", props: {}, content: "new item" },
    ]);
    expect(diffToText(diffBlocks(before, after))).toBe(
      ["  … 2 unchanged blocks", "  3", "~ The [-quick-]{+slow+} fox", "- gone", "+ * new item"].join("\n"),
    );
  });
});

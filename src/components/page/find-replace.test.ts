import { Slice } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import { describe, expect, it } from "vitest";
import { findMatches, replaceAllMatches } from "@/lib/find-replace";
import { serverEditor } from "@/server/blocknote";
import { findKey, findPlugin, type FindMeta } from "./find-replace";

const docOf = (blocks: unknown[]) => serverEditor._blocksToProsemirrorNode(blocks as any);
const stateOf = (blocks: unknown[]) => EditorState.create({ doc: docOf(blocks), plugins: [findPlugin()] });
const withMeta = (state: EditorState, meta: FindMeta) => state.apply(state.tr.setMeta(findKey, meta));
const find = (state: EditorState) => findKey.getState(state)!;
const decorationCount = (state: EditorState) => find(state).decorations.find().length;
const currentText = (state: EditorState) => {
  const s = find(state);
  const m = s.matches[s.current];
  return m ? state.doc.textBetween(m.from, m.to) : null;
};

describe("find plugin", () => {
  const blocks = [
    { type: "paragraph", content: "one fish two fish" },
    { type: "paragraph", content: "red fish blue fish" },
  ];

  it("highlights every match and tracks the current one", () => {
    let state = withMeta(stateOf(blocks), { query: "fish" });
    expect(find(state).matches).toHaveLength(4);
    expect(find(state).current).toBe(0);
    expect(decorationCount(state)).toBe(4);
    state = withMeta(state, { current: 2 });
    expect(find(state).current).toBe(2);
    const current = find(state).decorations.find(undefined, undefined, (spec) => spec.current === true);
    expect(current).toHaveLength(1);
    expect(current[0].from).toBe(find(state).matches[2].from);
  });

  it("clears everything when the query is emptied", () => {
    let state = withMeta(stateOf(blocks), { query: "fish" });
    state = withMeta(state, { query: "" });
    expect(find(state).matches).toEqual([]);
    expect(find(state).current).toBe(-1);
    expect(decorationCount(state)).toBe(0);
  });

  it("respects the case-sensitive toggle", () => {
    const state = stateOf([{ type: "paragraph", content: "Fish fish" }]);
    expect(find(withMeta(state, { query: "fish" })).matches).toHaveLength(2);
    expect(find(withMeta(state, { query: "fish", caseSensitive: true })).matches).toHaveLength(1);
  });

  it("ignores accents unless the accents toggle is on, and finds again when it changes", () => {
    let state = withMeta(stateOf([{ type: "paragraph", content: "café cafe" }]), { query: "cafe" });
    expect(find(state).matches).toHaveLength(2);
    state = withMeta(state, { matchAccents: true });
    expect(find(state).matches).toHaveLength(1);
    expect(find(state).matchAccents).toBe(true);
    // The toggle stays while the query changes.
    state = withMeta(state, { query: "café" });
    expect(find(state).matches).toHaveLength(1);
    expect(currentText(state)).toBe("café");
  });

  it("finds matches again after a local edit, keeping the current one", () => {
    let state = withMeta(stateOf(blocks), { query: "fish" });
    state = withMeta(state, { current: 1 });
    const second = find(state).matches[1];
    // Type "fish " at the very start: a new first match, and the old current moves along.
    const start = findMatches(state.doc, "one")[0].from;
    state = state.apply(state.tr.insertText("fish ", start));
    expect(find(state).matches).toHaveLength(5);
    expect(find(state).matches[find(state).current].from).toBe(second.from + 5);
    expect(decorationCount(state)).toBe(5);
  });

  it("finds matches again after a remote change that replaces the whole document", () => {
    let state = withMeta(stateOf(blocks), { query: "fish" });
    state = withMeta(state, { current: 2 });
    const before = find(state).matches[2].from;
    // y-prosemirror applies someone else's edit as one step over the whole document.
    const next = docOf([
      { type: "paragraph", content: "one fish two fish" },
      { type: "paragraph", content: "red fish blue fish and a fish" },
    ]);
    state = state.apply(state.tr.replace(0, state.doc.content.size, new Slice(next.content, 0, 0)));
    expect(find(state).matches).toHaveLength(5);
    expect(decorationCount(state)).toBe(5);
    expect(find(state).matches[find(state).current].from).toBe(before);
  });

  it("moves on past a replaced match and survives a replace all", () => {
    let state = withMeta(stateOf(blocks), { query: "fish" });
    const first = find(state).matches[0];
    const tr = state.tr.insertText("cat", first.from, first.to).setMeta(findKey, { anchor: first.from + 3 });
    state = state.apply(tr);
    expect(find(state).matches).toHaveLength(3);
    expect(find(state).current).toBe(0);
    expect(find(state).matches[0].from).toBeGreaterThan(first.from);

    state = state.apply(replaceAllMatches(state.tr, find(state).matches, "fishes"));
    expect(findMatches(state.doc, "fishes")).toHaveLength(3);
    // "fishes" still contains the query, so all three are still found.
    expect(find(state).matches).toHaveLength(3);
    expect(currentText(state)).toBe("fish");
  });
});

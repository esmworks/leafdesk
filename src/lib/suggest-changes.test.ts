import { blockToNode } from "@blocknote/core";
import type { Node } from "prosemirror-model";
import { EditorState, type Transaction } from "prosemirror-state";
import { describe, expect, it } from "vitest";
import { suggestTransaction } from "@/lib/suggest-changes";
import {
  hasSuggestions,
  listSuggestions,
  newSuggestionId,
  onlySuggestionsOf,
  rejectedView,
  resolvedDoc,
  suggestionAuthor,
  ZWSP,
} from "@/lib/suggestions";
import { serverEditor } from "@/server/blocknote";

const schema = serverEditor.editor.pmSchema;

function docOf(...texts: string[]): Node {
  const blocks = texts.map((content, i) => blockToNode({ id: `b${i}`, type: "paragraph", content }, schema));
  return schema.topNodeType.create(null, schema.nodes.blockGroup.create(null, blocks));
}

/** Position of the `nth` occurrence of `text` in the document. */
function at(doc: Node, text: string, nth = 0): number {
  let found = -1;
  let seen = 0;
  doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.isText) {
      let i = node.text!.indexOf(text);
      while (i >= 0) {
        if (seen++ === nth) {
          found = pos + i;
          return false;
        }
        i = node.text!.indexOf(text, i + 1);
      }
    }
    return true;
  });
  if (found < 0) throw new Error(`no "${text}"`);
  return found;
}

/** The blocks' text, ZWSP shown as "·", insertions as [+…], deletions as [-…], formatting changes as [~…]. */
function show(doc: Node): string[] {
  const lines: string[] = [];
  doc.descendants((node) => {
    if (!node.isTextblock) return true;
    let line = "";
    node.forEach((child) => {
      const text = (child.text ?? "").replaceAll(ZWSP, "·");
      const name = child.marks.find((m) => ["insertion", "deletion", "modification"].includes(m.type.name))?.type.name;
      line += name === "insertion" ? `[+${text}]` : name === "deletion" ? `[-${text}]` : name === "modification" ? `[~${text}]` : text;
    });
    lines.push(line);
    return false;
  });
  return lines;
}

const suggest = (state: EditorState, change: (tr: Transaction) => void, authorId = "alice") => {
  const tr = state.tr;
  change(tr);
  const { tr: suggested, untracked } = suggestTransaction(tr, state, { authorId, newId: () => newSuggestionId(authorId) });
  return { state: state.apply(suggested), untracked };
};

const stateOf = (doc: Node) => EditorState.create({ schema, doc });

describe("suggesting", () => {
  it("marks typed text as inserted, and rejecting or accepting it", () => {
    const before = docOf("hello world");
    const { state } = suggest(stateOf(before), (tr) => tr.insertText("big ", at(before, "world")));
    expect(show(state.doc)).toEqual(["hello [+big ]world"]);
    const [only] = listSuggestions(state.doc);
    expect(only.inserted).toBe("big ");
    expect(suggestionAuthor(only.id)).toBe("alice");
    expect(rejectedView(state.doc).eq(before)).toBe(true);
    expect(show(resolvedDoc(state.doc, "accept"))).toEqual(["hello big world"]);
    expect(hasSuggestions(resolvedDoc(state.doc, "accept"))).toBe(false);
  });

  it("keeps deleted text, struck through, until accepted", () => {
    const before = docOf("hello big world");
    const from = at(before, "big ");
    const { state } = suggest(stateOf(before), (tr) => tr.delete(from, from + 4));
    expect(show(state.doc)).toEqual(["hello [-big ]world"]);
    expect(show(resolvedDoc(state.doc, "accept"))).toEqual(["hello world"]);
    expect(rejectedView(state.doc).eq(before)).toBe(true);
  });

  it("grows the author's own suggestion and deletes their own inserted text for real", () => {
    const before = docOf("ab");
    const b = at(before, "b");
    let { state } = suggest(stateOf(before), (tr) => tr.insertText("X", b));
    ({ state } = suggest(state, (tr) => tr.insertText("Y", b + 1)));
    expect(show(state.doc)).toEqual(["a[+XY]b"]);
    expect(listSuggestions(state.doc)).toHaveLength(1);
    ({ state } = suggest(state, (tr) => tr.delete(b + 1, b + 2)));
    expect(show(state.doc)).toEqual(["a[+X]b"]);
  });

  it("starts someone else's suggestion of their own, and leaves others' text alone", () => {
    const before = docOf("ab");
    const b = at(before, "b");
    let { state } = suggest(stateOf(before), (tr) => tr.insertText("X", b), "alice");
    ({ state } = suggest(state, (tr) => tr.insertText("Y", b + 1), "bob"));
    expect(show(state.doc)).toEqual(["a[+X][+Y]b"]);
    const list = listSuggestions(state.doc);
    expect(list.map((s) => suggestionAuthor(s.id))).toEqual(["alice", "bob"]);
    // Bob deleting Alice's insertion neither removes nor marks it.
    const { state: after } = suggest(state, (tr) => tr.delete(b, b + 1), "bob");
    expect(show(after.doc)).toEqual(show(state.doc));
    expect(onlySuggestionsOf(state.doc, after.doc, "bob")).toBe(true);
  });

  it("proposes a new block boundary, which rejecting joins again", () => {
    const before = docOf("helloworld");
    const { state } = suggest(stateOf(before), (tr) => tr.split(at(before, "world"), 2));
    expect(show(state.doc)).toEqual(["hello[+·]", "[+·]world"]);
    expect(rejectedView(state.doc).eq(before)).toBe(true);
    expect(show(resolvedDoc(state.doc, "accept"))).toEqual(["hello", "world"]);
    expect(onlySuggestionsOf(before, state.doc, "alice")).toBe(true);
  });

  it("marks a formatting change with the formatting it had", () => {
    const before = docOf("hello world");
    const from = at(before, "world");
    const { state } = suggest(stateOf(before), (tr) => tr.addMark(from, from + 5, schema.marks.bold.create()));
    expect(show(state.doc)).toEqual(["hello [~world]"]);
    expect(rejectedView(state.doc).eq(before)).toBe(true);
    const accepted = resolvedDoc(state.doc, "accept");
    expect(show(accepted)).toEqual(["hello world"]);
    expect(accepted.rangeHasMark(from, from + 5, schema.marks.bold)).toBe(true);
    // Undoing the change by hand leaves no suggestion.
    const { state: back } = suggest(state, (tr) => tr.removeMark(from, from + 5, schema.marks.bold));
    expect(hasSuggestions(back.doc)).toBe(false);
  });

  it("deletes and inserts whole blocks", () => {
    const before = docOf("one", "two", "three");
    const second = before.firstChild!.child(1);
    const start = 1 + before.firstChild!.child(0).nodeSize;
    const deleted = suggest(stateOf(before), (tr) => tr.delete(start, start + second.nodeSize)).state;
    expect(show(deleted.doc)).toEqual(["one[-·]", "[-two]", "three"]);
    expect(show(resolvedDoc(deleted.doc, "accept"))).toEqual(["one", "three"]);
    expect(rejectedView(deleted.doc).eq(before)).toBe(true);

    const block = blockToNode({ id: "new", type: "paragraph", content: "new" }, schema);
    const inserted = suggest(stateOf(before), (tr) => tr.insert(start, block)).state;
    expect(show(inserted.doc)).toEqual(["one[+·]", "[+new]", "two", "three"]);
    expect(show(resolvedDoc(inserted.doc, "accept"))).toEqual(["one", "new", "two", "three"]);
    expect(rejectedView(inserted.doc).eq(before)).toBe(true);
  });

  it("accepts or rejects one suggestion and leaves the others", () => {
    const before = docOf("hello world");
    let { state } = suggest(stateOf(before), (tr) => tr.insertText("big ", at(before, "world")), "alice");
    ({ state } = suggest(state, (tr) => tr.delete(at(state.doc, "hello"), at(state.doc, "hello") + 5), "bob"));
    const [bobs, alices] = listSuggestions(state.doc);
    expect(suggestionAuthor(bobs.id)).toBe("bob");
    const accepted = resolvedDoc(state.doc, "accept", (id) => id === alices.id);
    expect(show(accepted)).toEqual(["[-hello] big world"]);
    const rejected = resolvedDoc(state.doc, "reject", (id) => id === bobs.id);
    expect(show(rejected)).toEqual(["hello [+big ]world"]);
  });

  it("tells changes that are only the author's suggestions from real ones", () => {
    const before = docOf("hello world");
    const real = before.type.schema.text("x");
    const edited = stateOf(before).apply(stateOf(before).tr.insert(at(before, "world"), real)).doc;
    expect(onlySuggestionsOf(before, edited, "alice")).toBe(false);
    const { state } = suggest(stateOf(before), (tr) => tr.insertText("x", at(before, "world")), "alice");
    expect(onlySuggestionsOf(before, state.doc, "alice")).toBe(true);
    // Someone else's suggestion is a change to the page as far as Alice is concerned.
    expect(onlySuggestionsOf(before, state.doc, "bob")).toBe(false);
  });

  it("makes changes it can't suggest as they are, and says so", () => {
    const before = docOf("hello");
    const { state, untracked } = suggest(stateOf(before), (tr) => tr.setNodeMarkup(1, undefined, { ...before.firstChild!.firstChild!.attrs, id: "renamed" }));
    expect(untracked).toBe(true);
    expect(onlySuggestionsOf(before, state.doc, "alice")).toBe(false);
  });
});

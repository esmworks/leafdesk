import { Schema, type Node as PMNode } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import { ySyncPluginKey } from "y-prosemirror";
import { describe, expect, it } from "vitest";
import { quoteSizePlugin } from "./quote-size";

// The shape of the editor's document: groups of blocks, each with its content and its children.
const schema = new Schema({
  nodes: {
    doc: { content: "blockGroup" },
    blockGroup: { content: "blockContainer+" },
    blockContainer: { content: "blockContent blockGroup?", attrs: { id: { default: null } } },
    paragraph: { group: "blockContent", content: "text*" },
    quote: { group: "blockContent", content: "text*", attrs: { size: { default: "default" } } },
    text: {},
  },
});

type Spec = { id: string; text: string; quote?: "default" | "large" };
const block = ({ id, text, quote }: Spec): PMNode =>
  schema.nodes.blockContainer.create({ id }, [
    quote ? schema.nodes.quote.create({ size: quote }, schema.text(text)) : schema.nodes.paragraph.create(null, schema.text(text)),
  ]);
const stateOf = (specs: Spec[], size: "default" | "large") =>
  EditorState.create({ schema, doc: schema.nodes.doc.create(null, schema.nodes.blockGroup.create(null, specs.map(block))), plugins: [quoteSizePlugin(() => size)] });

/** Each quote's id and size. */
const quotes = (state: EditorState) => {
  const out: [string, string][] = [];
  state.doc.descendants((node) => {
    if (node.type.name === "blockContainer" && node.firstChild?.type.name === "quote") out.push([node.attrs.id, node.firstChild.attrs.size]);
    return true;
  });
  return out;
};

/** Where block `id`'s content starts. */
function contentAt(state: EditorState, id: string): number {
  let at = -1;
  state.doc.descendants((node, pos) => {
    if (node.attrs.id === id) at = pos + 1;
    return at < 0;
  });
  return at;
}

const turnIntoQuote = (state: EditorState, id: string) => state.apply(state.tr.setBlockType(contentAt(state, id), contentAt(state, id) + 1, schema.nodes.quote));

describe("new quotes take the size last picked", () => {
  it("makes a paragraph turned into a quote large when large was picked last", () => {
    const state = turnIntoQuote(stateOf([{ id: "a", text: "Hello" }], "large"), "a");
    expect(quotes(state)).toEqual([["a", "large"]]);
  });

  it("leaves new quotes alone while the usual size was picked last", () => {
    const state = turnIntoQuote(stateOf([{ id: "a", text: "Hello" }], "default"), "a");
    expect(quotes(state)).toEqual([["a", "default"]]);
  });

  it("leaves quotes that were already there as they are, typing in them included", () => {
    let state = stateOf([{ id: "a", text: "Old", quote: "default" }], "large");
    state = state.apply(state.tr.insertText("er", contentAt(state, "a") + 1));
    expect(quotes(state)).toEqual([["a", "default"]]);
  });

  it("leaves changes from others alone", () => {
    const start = stateOf([{ id: "a", text: "Hello" }], "large");
    const pos = contentAt(start, "a");
    const state = start.apply(start.tr.setBlockType(pos, pos + 1, schema.nodes.quote).setMeta(ySyncPluginKey, { isChangeOrigin: true }));
    expect(quotes(state)).toEqual([["a", "default"]]);
  });
});

import { Schema, type Node as PMNode } from "prosemirror-model";
import { describe, expect, it } from "vitest";
import { listMarkerDecorations } from "./list-markers";

// The shape of the editor's document: groups of blocks, each with its content and its children.
const schema = new Schema({
  nodes: {
    doc: { content: "blockGroup" },
    blockGroup: { content: "blockContainer+" },
    blockContainer: { content: "blockContent blockGroup?" },
    paragraph: { group: "blockContent", content: "text*" },
    numberedListItem: { group: "blockContent", content: "text*", attrs: { start: { default: undefined } } },
    text: {},
  },
});

type Spec = { text: string; numbered?: boolean; start?: number; children?: Spec[] };
const block = ({ text, numbered, start, children }: Spec): PMNode =>
  schema.nodes.blockContainer.create(null, [
    numbered ? schema.nodes.numberedListItem.create({ start }, schema.text(text)) : schema.nodes.paragraph.create(null, schema.text(text)),
    ...(children?.length ? [schema.nodes.blockGroup.create(null, children.map(block))] : []),
  ]);

/** Each marked item's text and marker, in document order. */
function markers(specs: Spec[]): [string, string][] {
  const doc = schema.nodes.doc.create(null, schema.nodes.blockGroup.create(null, specs.map(block)));
  return listMarkerDecorations(doc)
    .find()
    .map((deco) => [doc.nodeAt(deco.from)!.textContent, (deco as unknown as { type: { attrs: Record<string, string> } }).type.attrs["data-marker"]]);
}

const item = (text: string, children?: Spec[], start?: number): Spec => ({ text, numbered: true, children, start });

describe("list markers in the editor", () => {
  it("leaves top-level lists to BlockNote's numbers", () => {
    expect(markers([item("one"), item("two")])).toEqual([]);
  });

  it("counts nested lists in letters, then roman numerals, then numbers", () => {
    const doc = [item("1", [item("a"), item("b", [item("i"), item("ii", [item("deep")])])])];
    expect(markers(doc)).toEqual([
      ["a", "a"],
      ["b", "b"],
      ["i", "i"],
      ["ii", "ii"],
    ]);
  });

  it("starts again after other blocks and from a list's start", () => {
    const doc = [item("1", [item("a"), { text: "note" }, item("again"), item("next")]), item("2", [item("third", undefined, 3), item("fourth")])];
    expect(markers(doc)).toEqual([
      ["a", "a"],
      ["again", "a"],
      ["next", "b"],
      ["third", "c"],
      ["fourth", "d"],
    ]);
  });

  it("counts letters only under numbered items", () => {
    expect(markers([{ text: "para", children: [item("x"), item("y")] }])).toEqual([]);
  });
});

import { Schema, type Node as PMNode } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import { describe, expect, it } from "vitest";
import { toggleHeadingPlugin } from "./toggle-headings";

// The shape of the editor's document: groups of blocks, each with its content and its children.
const schema = new Schema({
  nodes: {
    doc: { content: "blockGroup" },
    blockGroup: { content: "blockContainer+" },
    blockContainer: { content: "blockContent blockGroup?", attrs: { id: { default: null } } },
    paragraph: { group: "blockContent", content: "text*" },
    heading: { group: "blockContent", content: "text*", attrs: { level: { default: 1 }, isToggleable: { default: false } } },
    text: {},
  },
});

type Spec = { id: string; text: string; level?: number; toggle?: boolean; children?: Spec[] };
const block = ({ id, text, level, toggle, children }: Spec): PMNode =>
  schema.nodes.blockContainer.create({ id }, [
    level ? schema.nodes.heading.create({ level, isToggleable: !!toggle }, text ? schema.text(text) : null) : schema.nodes.paragraph.create(null, schema.text(text)),
    ...(children?.length ? [schema.nodes.blockGroup.create(null, children.map(block))] : []),
  ]);
const stateOf = (specs: Spec[]) =>
  EditorState.create({ schema, doc: schema.nodes.doc.create(null, schema.nodes.blockGroup.create(null, specs.map(block))), plugins: [toggleHeadingPlugin()] });

/** The outline: each block's id, with its children's. */
function outline(node: PMNode): unknown[] {
  const out: unknown[] = [];
  node.forEach((child) => {
    if (child.type.name !== "blockContainer") return;
    const inner = child.childCount > 1 ? outline(child.child(1)) : [];
    out.push(inner.length ? { [child.attrs.id]: inner } : child.attrs.id);
  });
  return out;
}
const top = (state: EditorState) => outline(state.doc.firstChild!);

/** Where the content of block `id` starts. */
function contentAt(state: EditorState, id: string): number {
  let at = -1;
  state.doc.descendants((node, pos) => {
    if (node.attrs.id === id) at = pos + 1;
    return at < 0;
  });
  return at;
}

const setToggle = (state: EditorState, id: string, toggle: boolean) => state.apply(state.tr.setNodeAttribute(contentAt(state, id), "isToggleable", toggle));

const page: Spec[] = [
  { id: "intro", text: "Intro" },
  { id: "a", text: "Part A", level: 2 },
  { id: "a1", text: "one" },
  { id: "a2", text: "Sub", level: 3 },
  { id: "a3", text: "two" },
  { id: "b", text: "Part B", level: 2 },
  { id: "b1", text: "three" },
  { id: "c", text: "Chapter", level: 1 },
];

describe("toggle heading sections", () => {
  it("takes the blocks up to the next heading of the same or a higher level", () => {
    const state = setToggle(stateOf(page), "a", true);
    expect(top(state)).toEqual(["intro", { a: ["a1", "a2", "a3"] }, "b", "b1", "c"]);
  });

  it("stops at a higher heading too, and adds after children it already had", () => {
    const state = setToggle(stateOf([{ id: "b", text: "B", level: 2, children: [{ id: "k", text: "kid" }] }, { id: "b1", text: "x" }, { id: "c", text: "C", level: 1 }]), "b", true);
    expect(top(state)).toEqual([{ b: ["k", "b1"] }, "c"]);
  });

  it("lets them out after it when made a plain heading again", () => {
    const wrapped = setToggle(stateOf(page), "a", true);
    expect(top(setToggle(wrapped, "a", false))).toEqual(["intro", "a", "a1", "a2", "a3", "b", "b1", "c"]);
  });

  it("is one change, undone at once", () => {
    const before = stateOf(page);
    const result = before.applyTransaction(before.tr.setNodeAttribute(contentAt(before, "a"), "isToggleable", true));
    // The change and the one appended to it, applied together.
    expect(result.transactions).toHaveLength(2);
  });

  it("leaves a heading with nothing under it, and other changes, alone", () => {
    const last = setToggle(stateOf(page), "c", true);
    expect(top(last)).toEqual(["intro", "a", "a1", "a2", "a3", "b", "b1", "c"]);
    const state = stateOf(page);
    const typed = state.apply(state.tr.insertText("!", contentAt(state, "a") + 1));
    expect(top(typed)).toEqual(top(state));
  });

  it("takes nothing for a paragraph turned into a toggle heading", () => {
    const state = stateOf(page);
    const at = contentAt(state, "intro");
    const turned = state.apply(state.tr.setNodeMarkup(at, schema.nodes.heading, { level: 1, isToggleable: true }));
    expect(top(turned)).toEqual(top(state));
  });
});

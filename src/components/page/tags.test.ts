import { Schema, type Node as PMNode } from "prosemirror-model";
import { EditorState, TextSelection } from "prosemirror-state";
import { describe, expect, it } from "vitest";
import { tagsInBlocks } from "@/lib/tag-blocks";
import { tagAtCaret, tagDecorations, tagMarksPlugin } from "./tags";

// The shape of the editor's document: groups of blocks, each with its content, with the marks and
// inline nodes that aren't prose.
const schema = new Schema({
  nodes: {
    doc: { content: "blockGroup" },
    blockGroup: { content: "blockContainer+" },
    blockContainer: { content: "blockContent blockGroup?" },
    paragraph: { group: "blockContent", content: "inline*" },
    heading: { group: "blockContent", content: "inline*" },
    codeBlock: { group: "blockContent", content: "text*", code: true, marks: "" },
    math: { group: "blockContent", content: "text*" },
    mention: { group: "inline", inline: true, atom: true, leafText: () => "@Ada" },
    footnote: { group: "inline", inline: true, content: "text*" },
    text: { group: "inline" },
  },
  marks: { bold: {}, code: {}, link: { attrs: { href: {} } } },
});

const t = (text: string, ...marks: string[]) => schema.text(text, marks.map((name) => (name === "link" ? schema.marks.link.create({ href: "x" }) : schema.marks[name].create())));
const block = (type: string, ...content: PMNode[]) => schema.nodes.blockContainer.create(null, schema.nodes[type].create(null, content));
const docOf = (...blocks: PMNode[]) => schema.nodes.doc.create(null, schema.nodes.blockGroup.create(null, blocks));

/** The marked text and its tag, in document order. */
const marked = (doc: PMNode) =>
  tagDecorations(doc)
    .find()
    .sort((a, b) => a.from - b.from)
    .map((deco) => [doc.textBetween(deco.from, deco.to), (deco as unknown as { type: { attrs: Record<string, string> } }).type.attrs["data-tag"]]);

describe("tag marks in the editor", () => {
  it("marks each tag from its # to its end", () => {
    const doc = docOf(block("paragraph", t("Plan #home/renovation, and #Q3.")), block("heading", t("#title")));
    expect(marked(doc)).toEqual([
      ["#home/renovation", "home/renovation"],
      ["#Q3", "Q3"],
      ["#title", "title"],
    ]);
  });

  it("reads a tag across styles", () => {
    expect(marked(docOf(block("paragraph", t("#ta", "bold"), t("g"))))).toEqual([["#tag", "tag"]]);
  });

  it("leaves out code, equations, links and mentions, as the index does", () => {
    const doc = docOf(
      block("codeBlock", t("#main { }")),
      block("math", t("#x")),
      block("paragraph", t("#code", "code"), t(" "), t("#link", "link"), t(" "), schema.nodes.mention.create(), t("#glued #kept")),
    );
    expect(marked(doc)).toEqual([["#kept", "kept"]]);
  });

  it("marks a footnote's tags on their own", () => {
    const doc = docOf(block("paragraph", t("Claim"), schema.nodes.footnote.create(null, t("#source")), t(" #after")));
    expect(marked(doc)).toEqual([
      ["#source", "source"],
      ["#after", "after"],
    ]);
  });

  it("finds the same tags as the index", () => {
    const doc = docOf(block("paragraph", t("#one "), t("#two", "code"), t(" x#three #four")));
    const index = tagsInBlocks([
      { type: "paragraph", content: [{ type: "text", text: "#one " }, { type: "text", text: "#two", styles: { code: true } }, { type: "text", text: " x#three #four" }] },
    ]);
    expect(marked(doc).map(([, tag]) => tag)).toEqual([...index.values()].map((tag) => tag.label));
  });

  it("only marks: it takes no typing and no keys, so the `# ` heading shortcut and the editor's keys stay as they are", () => {
    const { props } = tagMarksPlugin();
    expect(Object.keys(props).sort()).toEqual(["decorations", "handleDOMEvents"]);
    expect(Object.keys(props.handleDOMEvents ?? {})).toEqual(["click"]);
  });
});

describe("tagAtCaret", () => {
  const at = (doc: PMNode, pos: number) => tagAtCaret(EditorState.create({ schema, doc, selection: TextSelection.create(doc, pos) }));
  // The text of the first block starts at 3 (doc > blockGroup > blockContainer > paragraph).
  const START = 3;

  it("finds the tag being typed at the caret", () => {
    const doc = docOf(block("paragraph", t("notes #ho")));
    expect(at(doc, START + 9)).toEqual({ from: START + 6, query: "ho" });
    expect(at(doc, START + 8)).toBeNull();
  });

  it("is nothing for a lone # or a heading's marker, so a menu never opens for them", () => {
    expect(at(docOf(block("paragraph", t("#"))), START + 1)).toBeNull();
    expect(at(docOf(block("paragraph", t("# "))), START + 2)).toBeNull();
    expect(at(docOf(block("paragraph", t("##"))), START + 2)).toBeNull();
  });

  it("is nothing in code, a code block or a link", () => {
    expect(at(docOf(block("paragraph", t("#tag", "code"))), START + 4)).toBeNull();
    expect(at(docOf(block("codeBlock", t("#tag"))), START + 4)).toBeNull();
    expect(at(docOf(block("paragraph", t("#tag", "link"))), START + 4)).toBeNull();
  });

  it("counts a mention before it as one character", () => {
    const doc = docOf(block("paragraph", schema.nodes.mention.create(), t(" #ab")));
    expect(at(doc, START + 5)).toEqual({ from: START + 2, query: "ab" });
  });
});

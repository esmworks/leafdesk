import { Schema, type Node as PmNode } from "prosemirror-model";
import { describe, expect, it } from "vitest";
import { plainText, writingRange } from "./writing-range";

// The composer's blocks by name, as far as the writer reads them (mail-editor.tsx).
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*" },
    blockquote: { group: "block", content: "block+" },
    bulletList: { group: "block", content: "listItem+" },
    orderedList: { group: "block", content: "listItem+" },
    listItem: { content: "paragraph+" },
    signature: { group: "block", content: "block+" },
    text: { group: "inline" },
    hardBreak: { group: "inline", inline: true, leafText: () => "\n" },
  },
});
const p = (text = "") => schema.node("paragraph", null, text ? [schema.text(text)] : []);
const doc = (...blocks: PmNode[]) => schema.node("doc", null, blocks);
const signature = schema.node("signature", null, [p("Ayşe Yılmaz")]);
const HEADER = "On 5 Oct 2026, Ada wrote:";
const quoted = [p(HEADER), schema.node("blockquote", null, [p("Fiyat nedir?")])];

describe("writingRange", () => {
  it("is the first empty line when nothing is written", () => {
    const d = doc(p(), p(), signature, p(), ...quoted);
    expect(writingRange(d, [HEADER])).toEqual({ from: 0, to: 2 });
    expect(plainText(d, 2)).toBe("");
  });

  it("ends at the last written line above the signature, leaving the empty line before it", () => {
    const d = doc(p("Merhaba,"), p(), p("Ekte."), p(), signature, p(), ...quoted);
    const { to } = writingRange(d, [HEADER]);
    expect(d.textBetween(0, to, "|")).toBe("Merhaba,||Ekte.");
    expect(plainText(d, to)).toBe("Merhaba,\n\nEkte.");
  });

  it("stops at the quoted mail's header when there is no signature", () => {
    const d = doc(p("Olur."), p(), ...quoted);
    const { to } = writingRange(d, [HEADER]);
    expect(plainText(d, to)).toBe("Olur.");
    expect(to).toBe(p("Olur.").nodeSize);
  });

  it("reads lists, quotes and line breaks as the model's plain text", () => {
    const item = (text: string) => schema.node("listItem", null, [p(text)]);
    const d = doc(
      schema.node("paragraph", null, [schema.text("bir"), schema.node("hardBreak"), schema.text("iki")]),
      schema.node("bulletList", null, [item("a"), item("b")]),
      schema.node("orderedList", null, [item("ilk"), item("son")]),
      schema.node("blockquote", null, [p("alıntı")]),
      signature,
    );
    const { to } = writingRange(d, []);
    expect(plainText(d, to)).toBe("bir\niki\n- a\n- b\n1. ilk\n2. son\n> alıntı");
  });
});

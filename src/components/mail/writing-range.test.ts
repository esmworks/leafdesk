import { Schema, type Node as PmNode } from "prosemirror-model";
import { describe, expect, it } from "vitest";
import { plainText, rangePictures, writingRange } from "./writing-range";

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
    picture: { group: "block", atom: true, attrs: { src: { default: null }, cid: { default: null }, alt: { default: null } } },
    text: { group: "inline" },
    hardBreak: { group: "inline", inline: true, leafText: () => "\n" },
  },
});
const p = (text = "") => schema.node("paragraph", null, text ? [schema.text(text)] : []);
const doc = (...blocks: PmNode[]) => schema.node("doc", null, blocks);
const signature = schema.node("signature", null, [p("Ayşe Yılmaz")]);

describe("writingRange", () => {
  it("is the first empty line when nothing is written", () => {
    const d = doc(p(), p(), signature, p());
    expect(writingRange(d)).toEqual({ from: 0, to: 2 });
    expect(plainText(d, 2)).toBe("");
  });

  it("ends at the last written line above the signature, leaving the empty line before it", () => {
    const d = doc(p("Merhaba,"), p(), p("Ekte."), p(), signature, p());
    const { to } = writingRange(d);
    expect(d.textBetween(0, to, "|")).toBe("Merhaba,||Ekte.");
    expect(plainText(d, to)).toBe("Merhaba,\n\nEkte.");
  });

  it("ends at the last written line when there is no signature", () => {
    const d = doc(p("Olur."), p(), p());
    const { to } = writingRange(d);
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
    const { to } = writingRange(d);
    expect(plainText(d, to)).toBe("bir\niki\n- a\n- b\n1. ilk\n2. son\n> alıntı");
  });
});

describe("rangePictures", () => {
  it("gives back the range's pictures as the editor reads them, and none from the signature", () => {
    const picture = schema.node("picture", { src: "blob:x", cid: "a1@leafdesk", alt: 'plan "v2"' });
    const d = doc(p("Ekte plan:"), picture, p(), schema.node("signature", null, [p("Ayşe")]));
    const { to } = writingRange(d);
    expect(plainText(d, to)).toBe("Ekte plan:");
    expect(rangePictures(d, to)).toBe('<img src="blob:x" data-cid="a1@leafdesk" alt="plan &quot;v2&quot;">');
    expect(rangePictures(doc(p("yok")), 5)).toBe("");
  });
});

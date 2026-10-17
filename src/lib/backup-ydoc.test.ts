import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { idRewriter } from "./backup";
import { rewriteDocument } from "./backup-ydoc";

const A = "a".repeat(32);
const B = "b".repeat(32);

function documentNaming(id: string) {
  const doc = new Y.Doc();
  const body = doc.getXmlFragment("blocknote");
  const block = new Y.XmlElement("blockContainer");
  block.setAttribute("id", "block-1");
  const paragraph = new Y.XmlElement("paragraph");
  const text = new Y.XmlText();
  text.insert(0, "Hello ");
  text.insertEmbed(6, { type: "mention", user: id });
  text.insert(7, " there", { comment: { by: id } });
  paragraph.insert(0, [text]);
  const mention = new Y.XmlElement("mention");
  mention.setAttribute("user", id);
  block.insert(0, [paragraph, mention]);
  body.insert(0, [block]);
  const threads = doc.getMap("threads");
  const thread = new Y.Map();
  thread.set("author", id);
  const replies = new Y.Array();
  replies.push([{ by: id, text: "ok" }]);
  thread.set("replies", replies);
  threads.set("t1", thread);
  doc.getText("title").insert(0, `Notes for ${id}`);
  return Y.encodeStateAsUpdate(doc);
}

const read = (state: Uint8Array) => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return JSON.stringify({
    body: doc.getXmlFragment("blocknote").toJSON(),
    delta: (((doc.getXmlFragment("blocknote").get(0) as Y.XmlElement).get(0) as Y.XmlElement).get(0) as Y.XmlText).toDelta(),
    threads: doc.getMap("threads").toJSON(),
    title: doc.getText("title").toString(),
  });
};

describe("rewriteDocument", () => {
  it("rewrites ids in attributes, text formats, embeds, maps, arrays and text", () => {
    const rewritten = rewriteDocument(documentNaming(A), idRewriter(new Map([[A, B]]))!);
    expect(rewritten).not.toBeNull();
    const after = read(rewritten!);
    expect(after).not.toContain(A);
    expect(after).toBe(read(documentNaming(B)));
  });

  it("is null when the document doesn't name anyone in the map", () => {
    expect(rewriteDocument(documentNaming(B), idRewriter(new Map([[A, B]]))!)).toBeNull();
  });
});

import type { Node } from "prosemirror-model";
import { EditorState, type Transaction } from "prosemirror-state";
import { prosemirrorToYXmlFragment } from "y-prosemirror";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { COLLAB_FRAGMENT } from "@/lib/collab-constants";
import { suggestionOfThread, THREADS_MAP } from "@/lib/comments";
import { suggestTransaction } from "@/lib/suggest-changes";
import { listSuggestions, newSuggestionId, rejectedView, ZWSP } from "@/lib/suggestions";
import { serverEditor, type PageBlock } from "@/server/blocknote";
import { onlyOwnSuggestions } from "./suggest-guard";
import { bodyRoot, resolveInFragment, syncSuggestionThreads, writeBlocksKeepingSuggestions } from "./suggestion-doc";

const paragraphs = (...texts: string[]) => texts.map((content, i) => ({ id: `b${i}`, type: "paragraph", content })) as unknown as PageBlock[];

/** A page's document with these paragraphs. */
function pageDoc(...texts: string[]) {
  const doc = new Y.Doc();
  serverEditor.blocksToYXmlFragment(paragraphs(...texts), doc.getXmlFragment(COLLAB_FRAGMENT));
  return doc;
}

const copyOf = (doc: Y.Doc) => {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  return copy;
};

/** What a browser sends for `change` of its copy. */
function updateFrom(client: Y.Doc, change: () => void) {
  const before = Y.encodeStateVector(client);
  change();
  return Y.encodeStateAsUpdate(client, before);
}

/** Position of `text` in the body. */
function at(doc: Node, text: string): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.isText && node.text!.includes(text)) found = pos + node.text!.indexOf(text);
    return true;
  });
  if (found < 0) throw new Error(`no "${text}"`);
  return found;
}

/** Edits the browser's copy as its editor would: suggested in `authorId`'s name, or (null) for real. */
function edit(client: Y.Doc, change: (tr: Transaction, doc: Node) => void, authorId: string | null = "carol") {
  const fragment = client.getXmlFragment(COLLAB_FRAGMENT);
  const state = EditorState.create({ doc: bodyRoot(fragment) });
  const tr = state.tr;
  change(tr, state.doc);
  const next = authorId ? suggestTransaction(tr, state, { authorId, newId: () => newSuggestionId(authorId) }).tr : tr;
  return updateFrom(client, () => prosemirrorToYXmlFragment(state.apply(next).doc, fragment));
}

/** The blocks' text as the page reads (suggestions not applied), and as written with them. */
const texts = (root: Node) => {
  const lines: string[] = [];
  root.descendants((node) => {
    if (!node.isTextblock) return true;
    lines.push(node.textContent.replaceAll(ZWSP, ""));
    return false;
  });
  return lines;
};
const reads = (doc: Y.Doc) => texts(rejectedView(bodyRoot(doc.getXmlFragment(COLLAB_FRAGMENT))));
const written = (doc: Y.Doc) => texts(bodyRoot(doc.getXmlFragment(COLLAB_FRAGMENT)));

describe("onlyOwnSuggestions (what a commenter's connection takes)", () => {
  it("takes their own suggested insertions, deletions and their withdrawal", () => {
    const server = pageDoc("Hello world");
    const client = copyOf(server);
    const insert = edit(client, (tr, doc) => tr.insertText(" dear", at(doc, " world")));
    expect(onlyOwnSuggestions(server, insert, "carol")).toBe(true);
    Y.applyUpdate(server, insert);
    const remove = edit(client, (tr, doc) => tr.delete(at(doc, "Hello"), at(doc, "Hello") + 5));
    expect(onlyOwnSuggestions(server, remove, "carol")).toBe(true);
    Y.applyUpdate(server, remove);
    expect(reads(server)).toEqual(["Hello world"]);
    expect(written(server)).toEqual(["Hello dear world"]);
    // Taking back their own: plain edits that only remove their suggestions.
    const withdraw = updateFrom(client, () => {
      const fragment = client.getXmlFragment(COLLAB_FRAGMENT);
      prosemirrorToYXmlFragment(rejectedView(bodyRoot(fragment)), fragment);
    });
    expect(onlyOwnSuggestions(server, withdraw, "carol")).toBe(true);
  });

  it("refuses real edits, and suggestions in someone else's name", () => {
    const server = pageDoc("Hello world");
    expect(onlyOwnSuggestions(server, edit(copyOf(server), (tr, doc) => tr.insertText("!", at(doc, "world") + 5), null), "carol")).toBe(false);
    expect(onlyOwnSuggestions(server, edit(copyOf(server), (tr, doc) => tr.delete(at(doc, "world"), at(doc, "world") + 5), null), "carol")).toBe(false);
    expect(onlyOwnSuggestions(server, edit(copyOf(server), (tr, doc) => tr.insertText("!", at(doc, "world") + 5), "dave"), "carol")).toBe(false);
  });

  it("refuses touching another person's suggestion", () => {
    const server = pageDoc("Hello world");
    Y.applyUpdate(server, edit(copyOf(server), (tr, doc) => tr.insertText(" dear", at(doc, " world")), "dave"));
    const client = copyOf(server);
    // Taking dave's insertion out, or accepting it, is not carol's to do.
    const drop = updateFrom(client, () => {
      const fragment = client.getXmlFragment(COLLAB_FRAGMENT);
      prosemirrorToYXmlFragment(rejectedView(bodyRoot(fragment)), fragment);
    });
    expect(onlyOwnSuggestions(server, drop, "carol")).toBe(false);
    const accept = updateFrom(client, () => resolveInFragment(client.getXmlFragment(COLLAB_FRAGMENT), "accept", null));
    expect(onlyOwnSuggestions(server, accept, "carol")).toBe(false);
  });

  it("refuses changes outside the body: the title, threads, other fragments", () => {
    const server = pageDoc("Hello world");
    const client = copyOf(server);
    expect(onlyOwnSuggestions(server, updateFrom(client, () => client.getMap("meta").set("title", "Mine")), "carol")).toBe(false);
    expect(onlyOwnSuggestions(server, updateFrom(client, () => client.getMap(THREADS_MAP).set("t", new Y.Map())), "carol")).toBe(false);
    expect(onlyOwnSuggestions(server, updateFrom(client, () => client.getXmlFragment("other").insert(0, [new Y.XmlText("x")])), "carol")).toBe(false);
  });

  it("refuses an update that doesn't apply in full", () => {
    const server = pageDoc("Hello world");
    const client = copyOf(server);
    edit(client, (tr, doc) => tr.insertText(" dear", at(doc, " world")));
    // The second change alone: it builds on the first, which the server never got.
    const second = edit(client, (tr, doc) => tr.insertText(" old", at(doc, " world")));
    expect(onlyOwnSuggestions(server, second, "carol")).toBe(false);
  });
});

describe("accepting and rejecting in the live document", () => {
  it("accepts or rejects one suggestion or all, and reports what it found", () => {
    const doc = pageDoc("Hello world", "Second");
    Y.applyUpdate(doc, edit(copyOf(doc), (tr, d) => tr.insertText(" dear", at(d, " world")), "carol"));
    Y.applyUpdate(doc, edit(copyOf(doc), (tr, d) => tr.delete(at(d, "Second"), at(d, "Second") + 6), "dave"));
    const [carol, dave] = listSuggestions(bodyRoot(doc.getXmlFragment(COLLAB_FRAGMENT))).map((s) => s.id);
    const accepted = copyOf(doc);
    expect(resolveInFragment(accepted.getXmlFragment(COLLAB_FRAGMENT), "accept", [carol])).toEqual([carol]);
    expect(reads(accepted)).toEqual(["Hello dear world", "Second"]);
    expect(resolveInFragment(accepted.getXmlFragment(COLLAB_FRAGMENT), "accept", [carol])).toEqual([]);
    const all = copyOf(doc);
    expect(resolveInFragment(all.getXmlFragment(COLLAB_FRAGMENT), "accept", null).sort()).toEqual([carol, dave].sort());
    expect(written(all)).toEqual(["Hello dear world", ""]);
    const rejected = copyOf(doc);
    resolveInFragment(rejected.getXmlFragment(COLLAB_FRAGMENT), "reject", null);
    expect(written(rejected)).toEqual(["Hello world", "Second"]);
    expect(listSuggestions(bodyRoot(rejected.getXmlFragment(COLLAB_FRAGMENT)))).toEqual([]);
  });
});

describe("writeBlocksKeepingSuggestions", () => {
  it("keeps the suggestions of blocks a write leaves as the page read them", () => {
    const doc = pageDoc("Hello world", "Second");
    Y.applyUpdate(doc, edit(copyOf(doc), (tr, d) => tr.insertText(" dear", at(d, " world")), "carol"));
    Y.applyUpdate(doc, edit(copyOf(doc), (tr, d) => tr.insertText("!", at(d, "Second") + 6), "carol"));
    const fragment = doc.getXmlFragment(COLLAB_FRAGMENT);
    writeBlocksKeepingSuggestions(fragment, paragraphs("Hello world", "Changed"));
    expect(written(doc)).toEqual(["Hello dear world", "Changed"]);
    expect(reads(doc)).toEqual(["Hello world", "Changed"]);
    expect(listSuggestions(bodyRoot(fragment))).toHaveLength(1);
  });
});

describe("syncSuggestionThreads", () => {
  const origin = { source: "local", context: {} };
  const threadsOf = (doc: Y.Doc) =>
    [...doc.getMap<Y.Map<unknown>>(THREADS_MAP).values()].map((t) => ({
      suggestion: suggestionOfThread(t.get("metadata")),
      resolved: Boolean(t.get("resolved")),
      by: (t.get("comments") as Y.Array<Y.Map<unknown>>).get(0).get("userId"),
    }));

  it("opens a thread per suggestion in its author's name, once, and resolves it when the suggestion goes", () => {
    const doc = pageDoc("Hello world");
    Y.applyUpdate(doc, edit(copyOf(doc), (tr, d) => tr.insertText(" dear", at(d, " world")), "carol"));
    const [suggestion] = listSuggestions(bodyRoot(doc.getXmlFragment(COLLAB_FRAGMENT)));
    // Not by someone who didn't write since the last save.
    expect(syncSuggestionThreads(doc, new Set(["dave"]), origin).opened).toEqual([]);
    const first = syncSuggestionThreads(doc, new Set(["carol"]), origin);
    expect(first.opened).toEqual([expect.objectContaining({ suggestionId: suggestion.id, authorId: "carol" })]);
    expect(threadsOf(doc)).toEqual([{ suggestion: suggestion.id, resolved: false, by: "carol" }]);
    // The suggestion's text carries the thread's comment mark.
    let marked = false;
    bodyRoot(doc.getXmlFragment(COLLAB_FRAGMENT)).descendants((node) => {
      if (node.isText && node.marks.some((m) => m.type.name === "comment" && m.attrs.threadId === first.opened[0].threadId)) marked = true;
      return true;
    });
    expect(marked).toBe(true);
    // Saving again changes nothing.
    let changed = false;
    doc.on("update", () => (changed = true));
    expect(syncSuggestionThreads(doc, new Set(["carol"]), origin)).toEqual({ opened: [], closed: [] });
    expect(changed).toBe(false);
    resolveInFragment(doc.getXmlFragment(COLLAB_FRAGMENT), "reject", null);
    expect(syncSuggestionThreads(doc, new Set(), origin).closed).toEqual([{ threadId: first.opened[0].threadId, suggestionId: suggestion.id }]);
    expect(threadsOf(doc)[0].resolved).toBe(true);
  });
});

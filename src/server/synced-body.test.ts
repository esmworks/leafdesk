import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { COLLAB_FRAGMENT } from "@/lib/collab-constants";
import { syncedFragmentName } from "@/lib/synced-blocks";
import { serverEditor } from "./blocknote";
import { blockTexts } from "./semantic-text";
import { bodyBlocks } from "./synced-body";

// What of a page's synced blocks its search index and history read: the blocks it is the source
// of, never a reference's (another page's, which this page's readers may not be allowed to see).

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/server/collab/bridge", () => ({ getCollab: () => ({}) }));
const { snapshotBlocks } = await import("./page-history");

const paragraph = (text: string) => ({ type: "paragraph", content: text });
const synced = (pageId: string, syncId: string) => ({ type: "syncedBlock", props: { pageId, syncId } });

/** Page "host" holding its own synced block "own" and a reference to page "other". */
function hostDoc() {
  const doc = new Y.Doc();
  const write = (fragment: string, blocks: unknown[]) =>
    doc.transact(() => serverEditor.blocksToYXmlFragment(blocks as any, doc.getXmlFragment(fragment)));
  write(COLLAB_FRAGMENT, [paragraph("Intro"), synced("host", "own"), synced("other", "theirs")]);
  write(syncedFragmentName("own"), [paragraph("Shared from the host")]);
  // Never held here in practice; even so, a reference doesn't read it.
  write(syncedFragmentName("theirs"), [paragraph("Another page's text")]);
  return doc;
}

const texts = (blocks: unknown[]) => blockTexts(blocks as Parameters<typeof blockTexts>[0]).map((b) => b.text);

describe("a page's body with its synced blocks", () => {
  it("indexes the blocks of the page's own synced blocks, and none of a reference", () => {
    const doc = hostDoc();
    expect(texts(bodyBlocks(doc, "host"))).toEqual(["Intro", "Shared from the host"]);
  });

  it("is the main fragment alone without the page, as writes take it", () => {
    expect(texts(bodyBlocks(hostDoc(), undefined))).toEqual(["Intro"]);
  });

  it("shows a saved version's synced blocks in the history, and none of a reference", () => {
    const state = Y.encodeStateAsUpdate(hostDoc());
    expect(texts(snapshotBlocks(state, "host"))).toEqual(["Intro", "Shared from the host"]);
    // Page review undoes AI writes on the main fragment, so it reads it alone.
    expect(texts(snapshotBlocks(state))).toEqual(["Intro"]);
  });
});

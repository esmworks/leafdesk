import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { COLLAB_FRAGMENT } from "./collab-constants";
import {
  collapseSyncedRegions,
  holdsSyncedSource,
  mapSyncedBlocks,
  mapSyncedRegions,
  remapSyncedBlocks,
  showsSyncedContent,
  SYNCED_END_LINE,
  syncedBeginLine,
  syncedElementsIn,
  syncedRefOf,
  syncedRegionContent,
  syncedRegions,
  syncedSourceState,
  syncedState,
  withoutBlockIds,
  withoutSyncedBlocks,
  type SyncedSourceFacts,
} from "./synced-blocks";

const facts = (over: Partial<NonNullable<SyncedSourceFacts>> = {}): SyncedSourceFacts => ({
  level: "edit",
  heldBack: false,
  archived: false,
  locked: false,
  kind: "page",
  ...over,
});

describe("what a synced block shows its reader", () => {
  it("edits the source in place with edit or full access", () => {
    expect(syncedSourceState(facts({ level: "edit" }))).toBe("editable");
    expect(syncedSourceState(facts({ level: "full" }))).toBe("editable");
  });

  it("is read only with view or comment access, or when the source page is locked", () => {
    expect(syncedSourceState(facts({ level: "view" }))).toBe("readOnly");
    expect(syncedSourceState(facts({ level: "comment" }))).toBe("readOnly");
    expect(syncedSourceState(facts({ level: "full", locked: true }))).toBe("readOnly");
  });

  it("says no access, and nothing else, for a page the reader can't see, whatever its state", () => {
    expect(syncedSourceState(facts({ level: "none" }))).toBe("noAccess");
    // In the trash or not, a page out of reach reads the same: the trash doesn't leak its existence.
    expect(syncedSourceState(facts({ level: "none", archived: true }))).toBe("noAccess");
    // A session the workspace's policy holds back sees nothing of it either.
    expect(syncedSourceState(facts({ level: "full", heldBack: true }))).toBe("noAccess");
  });

  it("tells the trash and a deleted page apart for readers who may see the page", () => {
    expect(syncedSourceState(facts({ archived: true }))).toBe("trashed");
    expect(syncedSourceState(facts({ level: "view", archived: true }))).toBe("trashed");
    expect(syncedSourceState(null)).toBe("deleted");
  });

  it("reads as removed once the source page no longer holds the block", () => {
    expect(syncedState("editable", false)).toBe("removed");
    expect(syncedState("readOnly", false)).toBe("removed");
    expect(syncedState("readOnly", true)).toBe("readOnly");
    // Out of reach, the reader learns nothing about the block either.
    expect(syncedState("noAccess", false)).toBe("noAccess");
    expect(syncedState("trashed", true)).toBe("trashed");
  });

  it("shows the blocks only when the reader may see them", () => {
    expect(["editable", "readOnly", "noAccess", "trashed", "deleted", "removed"].filter((s) => showsSyncedContent(s as never))).toEqual([
      "editable",
      "readOnly",
    ]);
  });
});

describe("synced block ids", () => {
  it("accepts only well-formed ids", () => {
    expect(syncedRefOf({ pageId: "p1", syncId: "s-1" })).toEqual({ pageId: "p1", syncId: "s-1" });
    expect(syncedRefOf({ pageId: "", syncId: "s" })).toBeNull();
    expect(syncedRefOf({ pageId: "p 1", syncId: "s" })).toBeNull();
    expect(syncedRefOf({ pageId: "p", syncId: "--><script>" })).toBeNull();
    expect(syncedRefOf(null)).toBeNull();
  });
});

describe("synced blocks in block trees", () => {
  const tree = [
    { type: "paragraph", props: {}, children: [] },
    { type: "syncedBlock", props: { pageId: "a", syncId: "s1" }, children: [] },
    {
      type: "bulletListItem",
      props: {},
      children: [{ type: "syncedBlock", props: { pageId: "b", syncId: "s2" }, children: [] }],
    },
    { type: "syncedBlock", props: { pageId: "", syncId: "" }, children: [] },
  ];

  it("replaces them depth first and drops malformed ones", () => {
    type Node = { type: string; props?: Record<string, unknown>; children?: Node[] };
    const out = mapSyncedBlocks<Node>(tree, (_, ref) => [{ type: "paragraph", props: { from: ref.syncId }, children: [] }]);
    expect(out.map((b) => b.type)).toEqual(["paragraph", "paragraph", "bulletListItem"]);
    expect(out[1].props).toEqual({ from: "s1" });
    expect(out[2].children?.[0].props).toEqual({ from: "s2" });
  });

  it("are dropped from a synced block's blocks: they don't nest", () => {
    expect(withoutSyncedBlocks(tree).map((b) => b.type)).toEqual(["paragraph", "bulletListItem"]);
    expect(withoutSyncedBlocks(tree)[1].children).toEqual([]);
  });

  it("lose their ids when unsynced into a copy", () => {
    const copy = withoutBlockIds([{ id: "x", type: "paragraph", children: [{ id: "y", type: "paragraph", children: [] }] }]);
    expect(copy).toEqual([{ type: "paragraph", children: [{ type: "paragraph", children: [] }] }]);
  });
});

describe("synced blocks in Yjs documents", () => {
  const docWith = (blocks: { pageId: string; syncId: string }[]) => {
    const doc = new Y.Doc();
    const group = new Y.XmlElement("blockGroup");
    doc.getXmlFragment(COLLAB_FRAGMENT).insert(0, [group]);
    group.insert(
      0,
      blocks.map((ref) => {
        const container = new Y.XmlElement("blockContainer");
        const element = new Y.XmlElement("syncedBlock");
        element.setAttribute("pageId", ref.pageId);
        element.setAttribute("syncId", ref.syncId);
        container.insert(0, [element]);
        return container;
      }),
    );
    return doc;
  };

  it("finds the blocks the page body holds", () => {
    const doc = docWith([
      { pageId: "src", syncId: "one" },
      { pageId: "other", syncId: "two" },
    ]);
    expect(syncedElementsIn(doc)).toEqual([
      { pageId: "src", syncId: "one" },
      { pageId: "other", syncId: "two" },
    ]);
    expect(holdsSyncedSource(doc, "src", "one")).toBe(true);
    expect(holdsSyncedSource(doc, "src", "two")).toBe(false);
  });

  it("points a copy's sources at the copy, and references to copied pages at their copies", () => {
    const doc = docWith([
      { pageId: "src", syncId: "one" },
      { pageId: "sibling", syncId: "two" },
      { pageId: "elsewhere", syncId: "three" },
    ]);
    const changed = remapSyncedBlocks(
      doc,
      new Map([
        ["src", "copy"],
        ["sibling", "sibling-copy"],
      ]),
    );
    expect(changed).toBe(2);
    expect(syncedElementsIn(doc).map((r) => r.pageId)).toEqual(["copy", "sibling-copy", "elsewhere"]);
  });
});

describe("synced blocks in Markdown", () => {
  const ref = { pageId: "src", syncId: "s1" };
  const other = { pageId: "other", syncId: "s2" };
  const body = [
    "Intro",
    "",
    syncedBeginLine(ref),
    "",
    "Shared **text**",
    "",
    SYNCED_END_LINE,
    "",
    syncedBeginLine(other),
    "",
    SYNCED_END_LINE,
    "",
    "```",
    syncedBeginLine({ pageId: "code", syncId: "c" }),
    "```",
  ].join("\n");

  it("lists regions outside fenced code, with what is between their lines", () => {
    const regions = syncedRegions(body);
    expect(regions.map((r) => r.ref)).toEqual([ref, other]);
    expect(regions[0].inner.trim()).toBe("Shared **text**");
    expect(syncedRegionContent(body, ref)?.trim()).toBe("Shared **text**");
    expect(syncedRegionContent(body, { pageId: "src", syncId: "missing" })).toBeNull();
  });

  it("collapses regions to their begin line for writing: the blocks are never taken from Markdown", () => {
    const collapsed = collapseSyncedRegions(body);
    expect(collapsed).not.toContain("Shared");
    expect(collapsed).not.toContain(SYNCED_END_LINE);
    expect(collapsed).toContain(syncedBeginLine(ref));
    // Fenced code keeps what it says.
    expect(collapsed).toContain(syncedBeginLine({ pageId: "code", syncId: "c" }));
  });

  it("fills a region in for a reader, and leaves the others", () => {
    const out = mapSyncedRegions(body, (r) => (r.pageId === "other" ? "From elsewhere" : null));
    expect(out).toContain(`${syncedBeginLine(other)}\nFrom elsewhere\n${SYNCED_END_LINE}`);
    expect(out).toContain("Shared **text**");
  });

  it("reads a begin line without an end line as an empty region", () => {
    const md = `${syncedBeginLine(ref)}\nAfter`;
    expect(syncedRegions(md)).toEqual([{ ref, inner: "" }]);
    expect(collapseSyncedRegions(md)).toBe(md);
  });
});

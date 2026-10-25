import { beforeEach, describe, expect, it, vi } from "vitest";
import { SYNCED_END_LINE, syncedBeginLine } from "@/lib/synced-blocks";

// Access rules of synced blocks on the server: what one reader gets of a reference's source page,
// whatever page shows it. The database and the collab server are stand-ins.

type Row = { id: string; workspaceId: string; title: string; icon: string | null; kind: "page" | "database"; archived: boolean; lockedAt: Date | null; level: number };
let rows: Row[] = [];
const heldBack = new Set<string>();

vi.mock("@/db", () => ({
  db: { select: () => ({ from: () => ({ where: async () => rows }) }) },
}));
vi.mock("@/server/access", () => ({
  accessRank: () => "rank",
  levelFromRank: (rank: unknown) => (["none", "view", "comment", "content", "edit", "full"] as const)[Number(rank)] ?? "none",
  pageVisibleTo: () => "visible",
  requirePageAccess: vi.fn(),
  workspacesHeldBack: async (_: string, ids: string[]) => new Set(ids.filter((id) => heldBack.has(id))),
}));
const readSynced = vi.fn();
const readPage = vi.fn();
vi.mock("@/server/collab/bridge", () => ({ getCollab: () => ({ readSynced, readPage }) }));

const { expandSyncedBlocks, expandSyncedMarkdown, readerStates, resolveSynced, syncedSourceOf, syncedSources } = await import("./synced-blocks");

const LEVEL = { none: 0, view: 1, comment: 2, edit: 3, full: 4 };
const row = (id: string, over: Partial<Row> = {}): Row => ({
  id,
  workspaceId: "ws",
  title: `Title of ${id}`,
  icon: null,
  kind: "page",
  archived: false,
  lockedAt: null,
  level: LEVEL.edit,
  ...over,
});
const paragraph = (text: string) => ({ type: "paragraph", props: {}, content: [{ type: "text", text, styles: {} }], children: [] });
const synced = (pageId: string, syncId: string) => ({ type: "syncedBlock", props: { pageId, syncId }, children: [] });

beforeEach(() => {
  rows = [];
  heldBack.clear();
  readSynced.mockReset();
  readPage.mockReset();
});

describe("syncedSourceOf", () => {
  it("names nothing of a page the reader can't see", () => {
    expect(syncedSourceOf("p", row("p", { level: LEVEL.none }), false)).toEqual({ pageId: "p", state: "noAccess" });
    expect(syncedSourceOf("p", row("p", { level: LEVEL.none, archived: true }), false)).toEqual({ pageId: "p", state: "noAccess" });
    expect(syncedSourceOf("p", row("p"), true)).toEqual({ pageId: "p", state: "noAccess" });
  });

  it("gives the title and how far the reader may go otherwise", () => {
    expect(syncedSourceOf("p", row("p"), false)).toMatchObject({ state: "editable", title: "Title of p" });
    expect(syncedSourceOf("p", row("p", { level: LEVEL.view }), false)).toMatchObject({ state: "readOnly" });
    expect(syncedSourceOf("p", row("p", { lockedAt: new Date() }), false)).toMatchObject({ state: "readOnly" });
    expect(syncedSourceOf("p", row("p", { archived: true }), false)).toMatchObject({ state: "trashed" });
    expect(syncedSourceOf("p", undefined, false)).toEqual({ pageId: "p", state: "deleted" });
  });

  it("treats a database as no source (it has no synced blocks)", () => {
    expect(syncedSourceOf("d", row("d", { kind: "database" }), false)).toEqual({ pageId: "d", state: "deleted" });
  });
});

describe("syncedSources", () => {
  it("answers for every page at once, held back workspaces as no access", async () => {
    rows = [row("a"), row("b", { workspaceId: "strict" }), row("c", { level: LEVEL.view })];
    heldBack.add("strict");
    const out = await syncedSources("me", ["a", "b", "c", "gone", "a"]);
    expect([...out.keys()]).toEqual(["a", "b", "c", "gone"]);
    expect(out.get("a")?.state).toBe("editable");
    expect(out.get("b")).toEqual({ pageId: "b", state: "noAccess" });
    expect(out.get("c")?.state).toBe("readOnly");
    expect(out.get("gone")).toEqual({ pageId: "gone", state: "deleted" });
  });
});

describe("resolveSynced", () => {
  it("reads each source page once, and never one the reader can't see", async () => {
    rows = [row("seen", { level: LEVEL.view }), row("hidden", { level: LEVEL.none })];
    readSynced.mockImplementation(async (pageId: string, ids: string[]) => new Map(ids.filter((id) => id !== "gone").map((id) => [id, [paragraph(`${pageId}/${id}`)]])));
    const out = await resolveSynced(
      [
        { pageId: "seen", syncId: "one" },
        { pageId: "seen", syncId: "two" },
        { pageId: "seen", syncId: "gone" },
        { pageId: "hidden", syncId: "x" },
      ],
      "host",
      readerStates("me"),
    );
    expect(readSynced).toHaveBeenCalledTimes(1);
    expect(readSynced).toHaveBeenCalledWith("seen", ["one", "two", "gone"]);
    expect(out.get("seen:one")).toEqual({ state: "readOnly", blocks: [paragraph("seen/one")] });
    expect(out.get("seen:gone")).toEqual({ state: "removed", blocks: [] });
    expect(out.get("hidden:x")).toEqual({ state: "noAccess", blocks: [] });
  });

  it("reads the page's own synced blocks without asking about access (the reader reads that page)", async () => {
    readSynced.mockResolvedValue(new Map([["mine", [paragraph("own")]]]));
    const states = vi.fn();
    const out = await resolveSynced([{ pageId: "host", syncId: "mine" }], "host", states);
    expect(states).not.toHaveBeenCalled();
    expect(out.get("host:mine")?.blocks).toEqual([paragraph("own")]);
  });
});

describe("expandSyncedBlocks", () => {
  it("puts the blocks in place for a reader who may see them, the notice otherwise", async () => {
    rows = [row("open"), row("closed", { level: LEVEL.none }), row("bin", { archived: true })];
    readSynced.mockImplementation(async (pageId: string) => new Map([["s", [paragraph(`from ${pageId}`)]]]));
    const body = [paragraph("Intro"), synced("open", "s"), synced("closed", "s"), synced("bin", "s")];
    const out = await expandSyncedBlocks(body as never, "host", readerStates("me"), (state) => [paragraph(`[${state}]`)] as never);
    expect(out.map((b) => (b as unknown as { content: { text: string }[] }).content[0].text)).toEqual([
      "Intro",
      "from open",
      "[noAccess]",
      "[trashed]",
    ]);
    // Neither the closed page nor the one in the trash was read.
    expect(readSynced.mock.calls.map((c) => c[0])).toEqual(["open"]);
  });

  it("never fills in a synced block found inside another's blocks", async () => {
    rows = [row("open")];
    // The collab reader drops nested synced blocks; whatever comes back is laid out as it is.
    readSynced.mockResolvedValue(new Map([["s", [paragraph("shared")]]]));
    const out = await expandSyncedBlocks([synced("open", "s")] as never, "host", readerStates("me"), () => []);
    expect(out).toHaveLength(1);
    expect(readSynced).toHaveBeenCalledTimes(1);
  });
});

describe("expandSyncedMarkdown", () => {
  const region = (pageId: string, syncId: string, inner = "") => [syncedBeginLine({ pageId, syncId }), inner, SYNCED_END_LINE].join("\n");

  it("fills in references from the source page's own Markdown, as far as the reader may see it", async () => {
    rows = [row("src", { level: LEVEL.view }), row("secret", { level: LEVEL.none })];
    readPage.mockResolvedValue({ title: "Src", markdown: `Before\n\n${region("src", "s1", "Shared text")}\n\nAfter`, text: "" });
    const markdown = ["Mine", region("src", "s1"), region("secret", "s9"), region("src", "gone"), region("host", "own", "Own text")].join("\n\n");
    const out = await expandSyncedMarkdown("me", "host", markdown);
    expect(out).toContain(`${syncedBeginLine({ pageId: "src", syncId: "s1" })}\nShared text\n${SYNCED_END_LINE}`);
    expect(out).toContain("*Synced block: no access*");
    expect(out).toContain("*Synced block: the original was removed*");
    // The page's own synced blocks are left as they are.
    expect(out).toContain("Own text");
    // The secret page was never read.
    expect(readPage).toHaveBeenCalledTimes(1);
    expect(readPage).toHaveBeenCalledWith("src");
  });

  it("reads nothing for Markdown without references", async () => {
    const markdown = region("host", "own", "Own");
    expect(await expandSyncedMarkdown("me", "host", markdown)).toBe(markdown);
    expect(readPage).not.toHaveBeenCalled();
  });
});

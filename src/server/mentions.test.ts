import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { blocksToPlainText } from "@/lib/blocks";
import { COLLAB_FRAGMENT } from "@/lib/collab-constants";
import { linkPlaces } from "@/lib/link-context";
import {
  blockIdOfHash,
  bodyReferences,
  carryOverMentions,
  eachMention,
  isIsoDate,
  linkedPageId,
  linkedPageRef,
  markdownPageIds,
  MARKDOWN_PAGE_LINK,
  splitMentionText,
  stripReminders,
} from "@/lib/mentions";
import { blocksToMarkdown, markdownToBlocks, pageSchema, serverEditor, type PageBlock } from "./blocknote";
import { bodySegmentsFromYdoc } from "./published-body";

function docFrom(blocks: unknown[]) {
  const doc = new Y.Doc();
  doc.transact(() => serverEditor.blocksToYXmlFragment(blocks as any, doc.getXmlFragment(COLLAB_FRAGMENT)));
  return doc;
}
const read = (doc: Y.Doc) => serverEditor.yXmlFragmentToBlocks(doc.getXmlFragment(COLLAB_FRAGMENT));
const stored = (blocks: unknown[]) => read(docFrom(blocks));

const WS = "ws-1";
const PAGE = "3f0c9a4e-1111-4222-8333-444455556666";
const OTHER = "7a1b2c3d-1111-4222-8333-444455556666";
const people = [
  { id: "u-ada", name: "Ada Lovelace" },
  { id: "u-ad", name: "Ada" },
  { id: "u-grace", name: "Grace Hopper" },
];

const text = (value: string) => ({ type: "text", text: value, styles: {} });
const mention = (props: Record<string, string>) => ({ type: "mention", props });

const sample = [
  {
    type: "paragraph",
    content: [
      text("Ask "),
      mention({ kind: "user", id: "m1", userId: "u-ada", name: "Ada Lovelace" }),
      text(" about "),
      mention({ kind: "page", pageId: PAGE }),
      text(" by "),
      mention({ kind: "date", id: "m2", date: "2026-10-01", remindAt: "2026-10-01T07:00:00.000Z" }),
    ],
  },
  { type: "pageLink", props: { pageId: OTHER } },
];

function mentions(blocks: unknown[]) {
  const out: Record<string, string>[] = [];
  eachMention(blocks as PageBlock[], (m) => out.push({ ...m }));
  return out;
}

describe("mentions in the server schema", () => {
  it("are known to the schema", () => {
    expect(pageSchema.inlineContentSchema).toHaveProperty("mention");
    expect(pageSchema.blockSchema).toHaveProperty("pageLink");
  });

  it("round-trip through the Yjs document with every prop", () => {
    const blocks = stored(sample);
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "pageLink"]);
    expect(blocks[1].props).toMatchObject({ pageId: OTHER });
    expect(mentions(blocks)).toEqual([
      { kind: "user", id: "m1", userId: "u-ada", name: "Ada Lovelace", pageId: "", blockId: "", date: "", remindAt: "" },
      { kind: "page", id: "", userId: "", name: "", pageId: PAGE, blockId: "", date: "", remindAt: "" },
      { kind: "date", id: "m2", userId: "", name: "", pageId: "", blockId: "", date: "2026-10-01", remindAt: "2026-10-01T07:00:00.000Z" },
    ]);
  });

  it("read as people and dates in plain text, never the page's title", () => {
    expect(blocksToPlainText(stored(sample))).toBe("Ask @Ada Lovelace about  by @2026-10-01");
  });

  it("list what the body points at", () => {
    const refs = bodyReferences(stored(sample));
    expect(refs.pageIds.sort()).toEqual([PAGE, OTHER].sort());
    expect(refs.people).toEqual([{ key: "m1", userId: "u-ada" }]);
    expect(refs.reminders).toEqual([{ key: "m2", date: "2026-10-01", remindAt: "2026-10-01T07:00:00.000Z" }]);
  });
});

describe("mentions in Markdown", () => {
  it("are written as links, @names and ISO dates", async () => {
    const markdown = (await blocksToMarkdown(stored(sample), { workspaceId: WS })).trim();
    expect(markdown).toBe(
      `Ask @Ada Lovelace about [page](/w/${WS}/p/${PAGE}) by @2026-10-01\n\n[page](/w/${WS}/p/${OTHER}) <!-- leafdesk:page-link -->`,
    );
  });

  it("are read back, keeping the ids and reminders of the page's mentions", async () => {
    const existing = stored(sample);
    const markdown = await blocksToMarkdown(existing, { workspaceId: WS });
    const back = stored(await markdownToBlocks(markdown, existing, { people }));
    expect(back.map((b) => b.type)).toEqual(["paragraph", "pageLink"]);
    expect(mentions(back)).toEqual(mentions(existing));
    expect((await blocksToMarkdown(back, { workspaceId: WS })).trim()).toBe(markdown.trim());
  });

  it("turn any link to a page of the app into a page mention, whatever its text", async () => {
    const blocks = stored(
      await markdownToBlocks(`See [Roadmap](/w/other/p/${PAGE}), [abs](https://app.test/w/x/p/${OTHER}#top) and [site](https://example.com/w/x/p/y).`, [], {
        appUrl: "https://app.test",
      }),
    );
    expect(mentions(blocks).map((m) => m.pageId)).toEqual([PAGE, OTHER]);
    const content = blocks[0].content as { type: string; href?: string }[];
    expect(content.find((n) => n.type === "link")?.href).toBe("https://example.com/w/x/p/y");
  });

  it("read a page-link line as the block, with any link text", async () => {
    const blocks = stored(await markdownToBlocks(`Intro\n\n[Q3 plan](/w/${WS}/p/${PAGE}) <!-- leafdesk:page-link -->\n\nOutro`));
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "pageLink", "paragraph"]);
    expect(blocks[1].props).toMatchObject({ pageId: PAGE });
  });

  it("match the longest name, ignore case and leave emails and code alone", async () => {
    const blocks = stored(
      await markdownToBlocks("Hi @ada lovelace and @Ada, mail ada@example.com, not @Adam; `@Grace Hopper` @2026-02-30 @2026-02-28", [], { people }),
    );
    expect(mentions(blocks).map((m) => m.userId || m.date)).toEqual(["u-ada", "u-ad", "2026-02-28"]);
    expect(blocksToPlainText(blocks)).toBe("Hi @Ada Lovelace and @Ada, mail ada@example.com, not @Adam; @Grace Hopper @2026-02-30 @2026-02-28");
    // Every new mention gets an id.
    expect(mentions(blocks).every((m) => m.id)).toBe(true);
  });

  it("gives the n-th mention of a person the n-th id the page had, and new ones fresh ids", () => {
    const existing = [
      { type: "paragraph", content: [mention({ kind: "user", id: "a1", userId: "u-ada" }), mention({ kind: "user", id: "a2", userId: "u-ada" })] },
    ];
    const next = [
      {
        type: "paragraph",
        content: [
          mention({ kind: "user", id: "", userId: "u-ada" }),
          mention({ kind: "user", id: "", userId: "u-grace" }),
          mention({ kind: "user", id: "", userId: "u-ada" }),
          mention({ kind: "user", id: "", userId: "u-ada" }),
        ],
      },
    ];
    carryOverMentions(next, existing);
    const ids = mentions(next).map((m) => m.id);
    expect(ids.slice(0, 1)).toEqual(["a1"]);
    expect(ids[2]).toBe("a2");
    expect(new Set(ids).size).toBe(4);
  });
});

describe("mention helpers", () => {
  it("recognise links to pages of the app", () => {
    expect(linkedPageId(`/w/a/p/${PAGE}`)).toBe(PAGE);
    expect(linkedPageId(`/w/a/p/${PAGE}/`)).toBe(PAGE);
    expect(linkedPageId(`https://app.test/w/a/p/${PAGE}?x=1`, "https://app.test/")).toBe(PAGE);
    expect(linkedPageId(`https://evil.test/w/a/p/${PAGE}`, "https://app.test")).toBeNull();
    expect(linkedPageId(`//evil.test/w/a/p/${PAGE}`)).toBeNull();
    expect(linkedPageId("/w/a/p/")).toBeNull();
  });

  it("check calendar dates", () => {
    expect(isIsoDate("2024-02-29")).toBe(true);
    expect(isIsoDate("2026-02-29")).toBe(false);
    expect(isIsoDate("2026-1-01")).toBe(false);
  });

  it("split text at mentions", () => {
    expect(splitMentionText("@Grace Hopper's talk", people)).toEqual([
      { mention: expect.objectContaining({ kind: "user", userId: "u-grace", name: "Grace Hopper" }) },
      { text: "'s talk" },
    ]);
    expect(splitMentionText("x@Grace Hopper", people)).toEqual([{ text: "x@Grace Hopper" }]);
  });

  it("drop reminders from a copied document", () => {
    const doc = docFrom(sample);
    expect(stripReminders(doc)).toBe(true);
    expect(mentions(read(doc)).find((m) => m.kind === "date")).toMatchObject({ id: "m2", remindAt: "" });
    expect(stripReminders(doc)).toBe(false);
  });
});

describe("mentions on published pages", () => {
  it("show linked pages the resolver allows, and plain text for the rest", async () => {
    const doc = docFrom(sample);
    const segments = await bodySegmentsFromYdoc(Y.encodeStateAsUpdate(doc), {
      resolvePages: async (ids) =>
        new Map(
          ids.map((id) => [id, id === PAGE ? { text: "Roadmap <b>", href: `/s/token/${id}` } : { text: "Private page", href: null }]),
        ),
    });
    const html = segments.map((s) => (s.kind === "html" ? s.html : "")).join("");
    expect(html).toContain('<a href="/s/token/' + PAGE + '"');
    expect(html).toContain("Roadmap &lt;b&gt;");
    expect(html).toContain("@Ada Lovelace");
    expect(html).toContain("@2026-10-01");
    expect(html).toContain("Private page");
    expect(html).not.toContain(OTHER);
  });

  it("never name a page without a resolver", async () => {
    const doc = docFrom(sample);
    const html = (await bodySegmentsFromYdoc(Y.encodeStateAsUpdate(doc))).map((s) => (s.kind === "html" ? s.html : "")).join("");
    expect(html).not.toContain(PAGE);
    expect(html).not.toContain(OTHER);
  });
});

describe("links to a block of a page", () => {
  const BLOCK = "9c8b7a6d-1111-4222-8333-444455556666";

  it("are read from links to pages of the app", () => {
    expect(linkedPageRef(`/w/a/p/${PAGE}#block-${BLOCK}`)).toEqual({ pageId: PAGE, blockId: BLOCK });
    expect(linkedPageRef(`https://app.test/w/a/p/${PAGE}/?view=1#block-${BLOCK}`, "https://app.test")).toEqual({ pageId: PAGE, blockId: BLOCK });
    expect(linkedPageRef(`/w/a/p/${PAGE}`)).toEqual({ pageId: PAGE, blockId: "" });
    // Another fragment, or a block id that isn't one, is a link to the page.
    expect(linkedPageRef(`/w/a/p/${PAGE}#top`)).toEqual({ pageId: PAGE, blockId: "" });
    expect(linkedPageRef(`/w/a/p/${PAGE}#block-a"b`)).toEqual({ pageId: PAGE, blockId: "" });
    expect(linkedPageRef(`/w/a/p/${PAGE}#block-`)).toEqual({ pageId: PAGE, blockId: "" });
    expect(linkedPageRef(`https://evil.test/w/a/p/${PAGE}#block-${BLOCK}`, "https://app.test")).toBeNull();
    expect(linkedPageId(`/w/a/p/${PAGE}#block-${BLOCK}`)).toBe(PAGE);
    expect(blockIdOfHash(`#block-${BLOCK}`)).toBe(BLOCK);
    expect(blockIdOfHash(`#block-${"x".repeat(101)}`)).toBeNull();
    expect(blockIdOfHash("#heading-2")).toBeNull();
  });

  it("are found in Markdown with their block, as links to the page", () => {
    const markdown = `[A](/w/${WS}/p/${PAGE}#block-${BLOCK}) [B](/w/${WS}/p/${OTHER}) [C](/w/${WS}/p/${OTHER}#top)`;
    expect([...markdown.matchAll(MARKDOWN_PAGE_LINK)].map((m) => [m[3], m[4]])).toEqual([
      [PAGE, `#block-${BLOCK}`],
      [OTHER, undefined],
    ]);
    expect(markdownPageIds(markdown)).toEqual([PAGE, OTHER]);
  });

  it("keep their block through Markdown and back, as mentions and page-link blocks", async () => {
    const markdown = `See [x](/w/${WS}/p/${PAGE}#block-${BLOCK}) and [y](/w/${WS}/p/${PAGE}).\n\n[z](/w/${WS}/p/${OTHER}#block-${BLOCK}) <!-- leafdesk:page-link -->`;
    const blocks = stored(await markdownToBlocks(markdown));
    expect(mentions(blocks).map((m) => [m.pageId, m.blockId])).toEqual([
      [PAGE, BLOCK],
      [PAGE, ""],
    ]);
    expect(blocks[1]).toMatchObject({ type: "pageLink", props: { pageId: OTHER, blockId: BLOCK } });
    const written = (await blocksToMarkdown(blocks, { workspaceId: WS })).trim();
    expect(written).toBe(
      `See [page](/w/${WS}/p/${PAGE}#block-${BLOCK}) and [page](/w/${WS}/p/${PAGE}).\n\n[page](/w/${WS}/p/${OTHER}#block-${BLOCK}) <!-- leafdesk:page-link -->`,
    );
    const again = stored(await markdownToBlocks(written, blocks));
    expect((await blocksToMarkdown(again, { workspaceId: WS })).trim()).toBe(written);
  });

  it("count as links to the page for backlinks, at the block linking", async () => {
    const blocks = stored([
      { type: "paragraph", content: [text("Read "), mention({ kind: "page", pageId: PAGE, blockId: BLOCK }), text(" first")] },
      { type: "pageLink", props: { pageId: OTHER, blockId: BLOCK } },
    ]);
    expect(bodyReferences(blocks).pageIds.sort()).toEqual([PAGE, OTHER].sort());
    const places = linkPlaces(blocks);
    expect(places.get(PAGE)).toEqual([{ block: blocks[0].id, context: expect.stringContaining("Read ") }]);
    expect(places.get(OTHER)).toEqual([{ block: blocks[1].id, context: null }]);
  });
});

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { agentChatLine } from "@/lib/agent-chat";
import { buttonLine, serializeButtonConfig } from "@/lib/buttons";
import { blocksToPlainText } from "@/lib/blocks";
import { COLLAB_FRAGMENT } from "@/lib/collab-constants";
import { dashboardLine, newWidget, serializeDashboard } from "@/lib/dashboard";
import { LINKED_VIEW_TYPES, parseLinkedView, remapInlineDatabases, serializeLinkedView } from "@/lib/embed-blocks";
import { blocksToMarkdown, markdownToBlocks, serverEditor, type PageBlock } from "./blocknote";
import { anchorThread, reanchor, threadQuotes } from "./collab/comment-marks";
import { bodySegmentsFromYdoc } from "./published-body";

const DB = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

function docFrom(blocks: unknown[]) {
  const doc = new Y.Doc();
  doc.transact(() => serverEditor.blocksToYXmlFragment(blocks as any, doc.getXmlFragment(COLLAB_FRAGMENT)));
  return doc;
}

const read = (doc: Y.Doc) => serverEditor.yXmlFragmentToBlocks(doc.getXmlFragment(COLLAB_FRAGMENT));

const linked = serializeLinkedView({ type: "board", config: { sorts: [{ propertyId: "title", direction: "desc" }] } });

describe("database blocks in page bodies", () => {
  it("round-trip through the Yjs document", () => {
    const doc = docFrom([
      { type: "paragraph", content: "Intro" },
      { type: "database", props: { databaseId: DB } },
      { type: "linkedView", props: { databaseId: OTHER, view: linked } },
    ]);
    const blocks = read(doc);
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "database", "linkedView"]);
    expect(blocks[1].props).toEqual({ databaseId: DB });
    expect(blocks[2].props).toEqual({ databaseId: OTHER, view: linked });
  });

  it("write a title-free reference line to Markdown and no search text", async () => {
    const blocks = read(
      docFrom([
        { type: "paragraph", content: "Before" },
        { type: "database", props: { databaseId: DB } },
        { type: "bulletListItem", content: "item", children: [{ type: "linkedView", props: { databaseId: OTHER, view: linked } }] },
        { type: "database", props: { databaseId: "" } },
        { type: "paragraph", content: "After" },
      ]),
    );
    const markdown = (await blocksToMarkdown(blocks)).trim();
    expect(markdown).toContain(`Before\n\n<!-- leafdesk:database ${DB} -->\n\n`);
    expect(markdown).toContain(`<!-- leafdesk:linked-view ${OTHER} -->`);
    expect(markdown).toContain("After");
    expect(markdown).not.toContain("leafdesk" + "embed");
    // No settings, no titles: just the kind and the id.
    expect(markdown).not.toContain("board");
    expect(blocksToPlainText(blocks)).toBe("Before\nitem\nAfter");
  });

  it("parse reference lines back into blocks, keeping a linked view's settings", async () => {
    const existing = read(docFrom([{ type: "linkedView", props: { databaseId: OTHER, view: linked } }]));
    const markdown = [
      "# Title",
      "",
      `<!-- leafdesk:database ${DB} -->`,
      "",
      "```",
      `<!-- leafdesk:database ${OTHER} -->`,
      "```",
      "",
      `<!-- leafdesk:linked-view ${OTHER} -->`,
      "",
      `Inline <!-- leafdesk:linked-view ${DB} --> mention`,
    ].join("\n");
    const blocks = await markdownToBlocks(markdown, existing);
    expect(blocks.map((b) => b.type)).toEqual(["heading", "database", "codeBlock", "linkedView", "paragraph"]);
    expect(blocks[1].props).toEqual({ databaseId: DB });
    expect(blocks[3].props).toEqual({ databaseId: OTHER, view: linked });
    // Stored the way the collab service stores it, and read back.
    const doc = new Y.Doc();
    doc.transact(() => serverEditor.blocksToYXmlFragment(blocks, doc.getXmlFragment(COLLAB_FRAGMENT)));
    const again = (await blocksToMarkdown(read(doc))).trim();
    expect(again).toContain(`<!-- leafdesk:database ${DB} -->`);
    expect(again).toContain(`<!-- leafdesk:linked-view ${OTHER} -->`);
  });

  it("keep inline databases a rewrite leaves out, but not linked views", async () => {
    const existing = read(
      docFrom([
        { type: "paragraph", content: "Old" },
        { type: "database", props: { databaseId: DB } },
        { type: "linkedView", props: { databaseId: OTHER, view: linked } },
      ]),
    );
    const replaced = await markdownToBlocks("New text", existing);
    expect(replaced.map((b) => [b.type, b.props])).toEqual([
      ["paragraph", expect.anything()],
      ["database", { databaseId: DB }],
    ]);
    const appended = await markdownToBlocks("More", existing, { keepMissingInline: false });
    expect(appended.map((b) => b.type)).toEqual(["paragraph"]);
    const moved = await markdownToBlocks(`<!-- leafdesk:database ${DB} -->\n\nText`, existing);
    expect(moved.map((b) => b.type)).toEqual(["database", "paragraph"]);
  });

  it("keep a dashboard a rewrite names, with its widgets, and make none from Markdown", async () => {
    const widgets = serializeDashboard([newWidget("w1", DB)]);
    const existing = read(
      docFrom([
        { type: "paragraph", content: "Old" },
        { id: "dash1", type: "dashboard", props: { widgets } },
      ]),
    );
    const markdown = (await blocksToMarkdown(existing)).trim();
    expect(markdown).toBe(`Old\n\n${dashboardLine("dash1")}`);
    // The widgets never show in the Markdown: only the block's id.
    expect(markdown).not.toContain(DB);

    const kept = await markdownToBlocks(`${dashboardLine("dash1")}\n\nNew`, existing);
    expect(kept.map((b) => [b.type, b.id ?? null])).toEqual([
      ["dashboard", "dash1"],
      ["paragraph", expect.anything()],
    ]);
    expect(kept[0].props).toEqual({ widgets });
    const doc = new Y.Doc();
    doc.transact(() => serverEditor.blocksToYXmlFragment(kept, doc.getXmlFragment(COLLAB_FRAGMENT)));
    expect(read(doc)[0].props).toEqual({ widgets, layout: "grid" });

    const dropped = await markdownToBlocks("New", existing);
    expect(dropped.map((b) => b.type)).toEqual(["paragraph"]);
    const unknown = await markdownToBlocks(dashboardLine("elsewhere"), existing);
    expect(unknown.map((b) => b.type)).toEqual([]);
    const appended = await markdownToBlocks(dashboardLine("dash1"), existing, { keepMissingInline: false });
    expect(appended).toEqual([]);
  });

  it("write a meeting as its region, keep it on a rewrite, and make plain blocks of it elsewhere", async () => {
    const meeting = {
      meetingId: "m1",
      title: "Weekly sync",
      status: "done",
      seconds: 90,
      transcript: JSON.stringify([
        { c: 0, t: 0, d: 30, x: "We ship in May." },
        { c: 1, t: 30, d: 30, x: "Ayşe tells the customer." },
      ]),
      summary: "- Shipping moves to May [00:00]",
      actions: "- [ ] @Ayşe: Tell the customer [00:30]",
    };
    const existing = read(
      docFrom([
        { type: "paragraph", content: "Notes" },
        { id: "meet1", type: "meeting", props: meeting },
      ]),
    );
    expect(existing[1].props).toMatchObject(meeting);
    const markdown = (await blocksToMarkdown(existing)).trim();
    expect(markdown).toContain("<!-- leafdesk:meeting m1 -->\n### Weekly sync");
    expect(markdown).toContain("- [00:30] Ayşe tells the customer.");
    expect(markdown).toContain("- [ ] @Ayşe: Tell the customer [00:30]");
    expect(markdown.endsWith("<!-- leafdesk:/meeting -->")).toBe(true);
    expect(blocksToPlainText(existing)).toContain("Ayşe tells the customer.");

    const kept = await markdownToBlocks(`${markdown}\n\nNew`, existing);
    expect(kept.map((b) => [b.type, b.id ?? null])).toEqual([
      ["paragraph", expect.anything()],
      ["meeting", "meet1"],
      ["paragraph", expect.anything()],
    ]);
    expect(kept[1].props).toMatchObject(meeting);
    expect(kept[1].children).toEqual([]);

    // Added to a page (or written where the page has no such meeting): its text, as blocks.
    const appended = await markdownToBlocks(markdown, existing, { keepMissingInline: false });
    expect(appended.some((b) => b.type === "meeting")).toBe(false);
    expect(blocksToPlainText(appended)).toContain("Tell the customer");
    expect(appended.find((b) => b.type === "heading")).toBeTruthy();
  });

  it("points copied inline databases at their copies, not linked views", () => {
    const doc = docFrom([
      { type: "database", props: { databaseId: DB } },
      { type: "paragraph", content: "x", children: [{ type: "database", props: { databaseId: DB } }] },
      { type: "linkedView", props: { databaseId: DB, view: "" } },
      { type: "database", props: { databaseId: OTHER } },
    ]);
    expect(remapInlineDatabases(doc, new Map([[DB, "copy"]]))).toBe(2);
    const blocks = read(doc) as PageBlock[];
    expect(blocks[0].props).toEqual({ databaseId: "copy" });
    expect(blocks[1].children[0].props).toEqual({ databaseId: "copy" });
    expect(blocks[2].props).toMatchObject({ databaseId: DB });
    expect(blocks[3].props).toEqual({ databaseId: OTHER });
  });
});

describe("comment marks", () => {
  const paragraph = (text: string) => ({ type: "paragraph", content: text });

  it("keep the text they mark readable, and out of published HTML", async () => {
    const doc = docFrom([paragraph("Ship the comments feature.")]);
    const fragment = doc.getXmlFragment(COLLAB_FRAGMENT);
    expect(anchorThread(fragment, "t1", { quote: "comments feature" })).toBe(true);
    expect(blocksToPlainText(read(doc))).toBe("Ship the comments feature.");
    const [segment] = await bodySegmentsFromYdoc(Y.encodeStateAsUpdate(doc));
    expect("html" in segment && segment.html).not.toMatch(/thread|comment--/);
  });

  it("anchor quotes within one paragraph only", () => {
    const fragment = docFrom([paragraph("First part."), paragraph("Second part.")]).getXmlFragment(COLLAB_FRAGMENT);
    expect(anchorThread(fragment, "t1", { quote: "part.Second" })).toBe(false);
    expect(anchorThread(fragment, "t1", { quote: "Second" })).toBe(true);
    expect(Object.fromEntries(threadQuotes(fragment))).toEqual({ t1: "Second" });
  });

  it("anchor a browser's selection where it is, not where the text first appears", () => {
    const doc = docFrom([paragraph("go go go"), { ...paragraph("go again"), id: "b2" }]);
    const fragment = doc.getXmlFragment(COLLAB_FRAGMENT);
    expect(anchorThread(fragment, "t1", { quote: "go", blockId: "b2", offset: 0 })).toBe(true);
    expect(anchorThread(fragment, "t2", { quote: "go", blockId: read(doc)[0].id, offset: 3 })).toBe(true);
    const json = JSON.stringify(doc.getXmlFragment(COLLAB_FRAGMENT).toJSON());
    expect(threadQuotes(fragment)).toEqual(new Map([["t2", "go"], ["t1", "go"]]));
    // t2 marks the second "go" of the first paragraph: its text splits there.
    expect(json).toMatch(/go <comment--[^>]*>go<\/comment--[^>]*> go/);
  });

  it("come back after a rewrite keeps their text", () => {
    const doc = docFrom([paragraph("Keep this sentence.")]);
    const fragment = doc.getXmlFragment(COLLAB_FRAGMENT);
    anchorThread(fragment, "t1", { quote: "this sentence" });
    const quotes = threadQuotes(fragment);
    serverEditor.blocksToYXmlFragment([paragraph("New intro."), paragraph("Keep this sentence!")] as never, fragment);
    reanchor(fragment, quotes, new Set(["t1"]));
    expect(Object.fromEntries(threadQuotes(fragment))).toEqual({ t1: "this sentence" });
  });
});

describe("published body segments", () => {
  it("split the HTML around database blocks and never serialize them", async () => {
    const doc = docFrom([
      { type: "paragraph", content: "One" },
      { type: "database", props: { databaseId: DB } },
      { type: "bulletListItem", content: "Two", children: [{ type: "linkedView", props: { databaseId: OTHER, view: linked } }] },
      { type: "paragraph", content: "Three" },
    ]);
    const segments = await bodySegmentsFromYdoc(Y.encodeStateAsUpdate(doc));
    expect(segments.map((s) => (s.kind === "embed" ? s.type : s.kind))).toEqual(["html", "database", "html", "linkedView", "html"]);
    expect(segments[1]).toEqual({ kind: "embed", type: "database", databaseId: DB, view: null });
    expect(segments[3]).toEqual({
      kind: "embed",
      type: "linkedView",
      databaseId: OTHER,
      view: { type: "board", config: { sorts: [{ propertyId: "title", direction: "desc" }] } },
    });
    const html = segments.map((s) => (s.kind === "html" ? s.html : "")).join("");
    expect(html).toContain("Two");
    expect(html).not.toContain(DB);
    expect(html).not.toContain(OTHER);
  });

  it("keep empty lines as line breaks, not replacement characters", async () => {
    const doc = docFrom([{ type: "paragraph", content: "One" }, { type: "paragraph" }, { type: "heading" }]);
    const [segment] = await bodySegmentsFromYdoc(Y.encodeStateAsUpdate(doc));
    const html = segment.kind === "html" ? segment.html : "";
    expect(html).not.toContain("\uFFFC");
    expect(html).toContain("<p><br></p>");
  });

  it("wrap linked images in their link: a web address, or a page where it is published", async () => {
    const doc = docFrom([
      { type: "image", props: { url: "https://x.test/a.png", name: "Web", link: "https://example.com/x" } },
      { type: "image", props: { url: "https://x.test/b.png", name: "Shared", link: "/w/ws1/p/shared" } },
      { type: "image", props: { url: "https://x.test/c.png", name: "Private", link: "/w/ws1/p/private" } },
    ]);
    const resolvePages = async (ids: string[]) => new Map(ids.map((id) => [id, { text: id, href: id === "shared" ? "/s/token/shared" : null }]));
    const html = (await bodySegmentsFromYdoc(Y.encodeStateAsUpdate(doc), { resolvePages })).map((s) => (s.kind === "html" ? s.html : "")).join("");
    expect(html).toMatch(/<a href="https:\/\/example.com\/x"[^>]*><img src="https:\/\/x.test\/a.png"/);
    expect(html).toMatch(/<a href="\/s\/token\/shared"[^>]*><img src="https:\/\/x.test\/b.png"/);
    expect(html).not.toContain("/w/ws1/p/");
    expect(html).toContain('src="https://x.test/c.png"');
  });
});

describe("linked images", () => {
  it("round-trip through Markdown, a caption and a page link too", async () => {
    const blocks = [
      { type: "image", props: { url: "https://x.test/a.png", name: "Chart", link: "https://example.com/x" } },
      { type: "image", props: { url: "/api/files/f1", name: "Plan", caption: "Draft", link: "/w/ws1/p/page-1" } },
    ] as unknown as PageBlock[];
    const markdown = await blocksToMarkdown(blocks);
    expect(markdown).toContain("[![Chart](https://x.test/a.png)](https://example.com/x)");
    const back = await markdownToBlocks(markdown);
    expect(back.map((b) => b.props)).toMatchObject([
      { url: "https://x.test/a.png", name: "Chart", link: "https://example.com/x" },
      { url: "/api/files/f1", name: "Plan", caption: "Draft", link: "/w/ws1/p/page-1" },
    ]);
  });

  it("keep their link through the Yjs document, and read a pasted image in a link", async () => {
    const doc = docFrom([{ type: "image", props: { url: "https://x.test/a.png", link: "https://example.com/x" } }]);
    expect(read(doc)[0].props).toMatchObject({ link: "https://example.com/x" });
    const pasted = await serverEditor.tryParseHTMLToBlocks('<a href="https://example.com/y"><img src="https://x.test/b.png" alt="B"></a>');
    expect(pasted[0]).toMatchObject({ type: "image", props: { url: "https://x.test/b.png", link: "https://example.com/y" } });
    const unsafe = await serverEditor.tryParseHTMLToBlocks('<a href="javascript:alert(1)"><img src="https://x.test/b.png"></a>');
    expect(unsafe[0]).toMatchObject({ type: "image", props: { link: "" } });
  });
});

describe("linked view settings", () => {
  it("fall back to a plain table when malformed", () => {
    expect(parseLinkedView("")).toEqual({ type: "table", config: {} });
    expect(parseLinkedView("{nope")).toEqual({ type: "table", config: {} });
    expect(parseLinkedView(JSON.stringify({ type: "kanban", config: {} }))).toEqual({ type: "table", config: {} });
    expect(parseLinkedView(JSON.stringify({ type: "list", config: { filters: "bad" } }))).toEqual({ type: "list", config: {} });
    expect(parseLinkedView(JSON.stringify({ type: "gallery", config: { cardSize: "huge" } }))).toEqual({ type: "gallery", config: {} });
    expect(parseLinkedView(linked).type).toBe("board");
  });

  it("never take the form layout: forms belong to the database's own views", () => {
    const form = { type: "form", config: { form: { questions: [{ propertyId: "title", required: true }] } } };
    expect(parseLinkedView(JSON.stringify(form))).toEqual({ type: "table", config: {} });
    expect(LINKED_VIEW_TYPES).not.toContain("form");
    // Charts only read rows, so a page can show one of its own.
    expect(LINKED_VIEW_TYPES).toContain("chart");
    expect(parseLinkedView(JSON.stringify({ type: "chart", config: { chartType: "donut" } }))).toEqual({
      type: "chart",
      config: { chartType: "donut" },
    });
  });
});

describe("synced blocks in page bodies", () => {
  const SRC = "33333333-3333-4333-8333-333333333333";
  const begin = (pageId: string, syncId: string) => `<!-- leafdesk:synced-block ${pageId} ${syncId} -->`;
  const end = "<!-- leafdesk:synced-block-end -->";

  it("write their blocks between marker lines, and a reference as the lines alone", async () => {
    const markdown = await blocksToMarkdown([
      { type: "paragraph", props: {}, content: [{ type: "text", text: "Intro", styles: {} }], children: [] },
      {
        type: "syncedBlock",
        props: { pageId: SRC, syncId: "s1" },
        // A source page's reader passes the blocks in as children (see collab/service bodyBlocks).
        children: [{ type: "paragraph", props: {}, content: [{ type: "text", text: "Shared", styles: {} }], children: [] }],
      },
      { type: "syncedBlock", props: { pageId: OTHER, syncId: "s2" }, children: [] },
    ] as unknown as PageBlock[]);
    expect(markdown).toContain(`${begin(SRC, "s1")}\n\nShared\n\n${end}`);
    expect(markdown).toContain(`${begin(OTHER, "s2")}\n\n${end}`);
  });

  it("come back from Markdown as the block alone: its blocks are never written from Markdown", async () => {
    const blocks = await markdownToBlocks(`Intro\n\n${begin(SRC, "s1")}\n\nRewritten by someone\n\n${end}\n\nOutro`);
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "syncedBlock", "paragraph"]);
    expect(blocks[1].props).toEqual({ pageId: SRC, syncId: "s1" });
    expect(blocksToPlainText(blocks)).not.toContain("Rewritten");
  });

  it("stay on their page when a rewrite leaves them out, as other pages show them", async () => {
    const existing = read(docFrom([{ type: "syncedBlock", props: { pageId: SRC, syncId: "s1" } }, { type: "syncedBlock", props: { pageId: OTHER, syncId: "s2" } }]));
    const blocks = await markdownToBlocks("Only text", existing, { pageId: SRC });
    // The page's own synced block stays; the reference to another page's goes, as written.
    expect(blocks.map((b) => [b.type, (b.props as { syncId?: string }).syncId])).toEqual([
      ["paragraph", undefined],
      ["syncedBlock", "s1"],
    ]);
  });

  it("show nothing on a published page unless the publication fills them in", async () => {
    const doc = docFrom([{ type: "paragraph", content: "Visible" }, { type: "syncedBlock", props: { pageId: OTHER, syncId: "s2" } }]);
    const segments = await bodySegmentsFromYdoc(Y.encodeStateAsUpdate(doc));
    expect(JSON.stringify(segments)).not.toContain("syncedBlock");
    expect(JSON.stringify(segments)).toContain("Visible");
  });
});

describe("tables in Markdown", () => {
  const cell = (text: string, colspan = 1, rowspan = 1) => ({
    type: "tableCell",
    content: [{ type: "text", text, styles: {} }],
    props: { colspan, rowspan, backgroundColor: "default", textColor: "default", textAlignment: "left" },
  });
  const texts = (block: PageBlock) =>
    (block.content as unknown as { rows: { cells: { content: { text: string }[] }[] }[] }).rows.map((row) =>
      row.cells.map((c) => c.content.map((node) => node.text).join("")),
    );

  it("write merged cells out as a full grid, with the places they covered empty", async () => {
    const table = {
      id: "t1",
      type: "table",
      props: { textColor: "default" },
      content: {
        type: "tableContent",
        columnWidths: [undefined, undefined, undefined],
        headerRows: 1,
        rows: [{ cells: [cell("Wide", 2), cell("C")] }, { cells: [cell("Tall", 1, 2), cell("b1"), cell("c1")] }, { cells: [cell("b2"), cell("c2")] }],
      },
      children: [],
    } as unknown as PageBlock;
    const back = await markdownToBlocks(await blocksToMarkdown([table]));
    expect(texts(back[0])).toEqual([
      ["Wide", "", "C"],
      ["Tall", "b1", "c1"],
      ["", "b2", "c2"],
    ]);
  });

  it("write a line break in a cell as <br>, keeping the row on one line", async () => {
    const table = {
      id: "t2",
      type: "table",
      props: { textColor: "default" },
      content: { type: "tableContent", columnWidths: [undefined, undefined], headerRows: 1, rows: [{ cells: [cell("A"), cell("B")] }, { cells: [cell("Jan\nFeb"), cell("y")] }] },
      children: [],
    } as unknown as PageBlock;
    const markdown = await blocksToMarkdown([table]);
    expect(markdown).toContain("Jan<br>Feb");
    expect(texts((await markdownToBlocks(markdown))[0])).toEqual([
      ["A", "B"],
      ["Jan\nFeb", "y"],
    ]);
  });
});

describe("agent chats in page bodies", () => {
  it("round-trip through the Yjs document and Markdown, keeping their conversations' id", async () => {
    const doc = docFrom([
      { type: "paragraph", content: "Ask" },
      { type: "agentChat", props: { agentId: "a1", chatId: "c1" } },
    ]);
    const blocks = read(doc);
    expect(blocks[1]).toMatchObject({ type: "agentChat", props: { agentId: "a1", chatId: "c1" } });
    const markdown = (await blocksToMarkdown(blocks)).trim();
    expect(markdown).toBe(`Ask\n\n${agentChatLine("a1", "c1")}`);
    const back = await markdownToBlocks(markdown);
    expect(back.map((b) => [b.type, b.props])).toEqual([
      ["paragraph", expect.anything()],
      ["agentChat", { agentId: "a1", chatId: "c1" }],
    ]);
  });

  it("get a chat id when written in Markdown without one", async () => {
    const [block] = await markdownToBlocks(agentChatLine("a1", ""));
    expect(block.type).toBe("agentChat");
    expect((block.props as { chatId: string }).chatId).toMatch(/^[\w-]{8,}$/);
  });

  it("show a note, never the agent, on a published page", async () => {
    const doc = docFrom([{ type: "paragraph", content: "Visible" }, { type: "agentChat", props: { agentId: "a1", chatId: "c1" } }]);
    const segments = await bodySegmentsFromYdoc(Y.encodeStateAsUpdate(doc));
    expect(segments.map((s) => s.kind)).toEqual(["html", "agentChat"]);
    expect(JSON.stringify(segments)).not.toContain("a1");
  });
});

describe("buttons in page bodies", () => {
  const config = serializeButtonConfig({ confirm: true, steps: [{ type: "insert", at: "below", markdown: "- [ ] {{today}}" }] });
  const existing = () =>
    read(
      docFrom([
        { type: "paragraph", content: "Before" },
        { id: "btn1", type: "button", props: { label: "Start the week", icon: "🚀", config } },
      ]),
    );

  it("write their id and label to Markdown, and keep what they do on a rewrite", async () => {
    const blocks = existing();
    const markdown = (await blocksToMarkdown(blocks)).trim();
    expect(markdown).toBe(`Before\n\n${buttonLine("btn1", "Start the week")}`);
    // What it does stays in the page.
    expect(markdown).not.toContain("today");
    expect(blocksToPlainText(blocks)).toContain("🚀 Start the week");

    const renamed = await markdownToBlocks(`${buttonLine("btn1", "Begin")}\n\nAfter`, blocks);
    expect(renamed.map((b) => [b.type, b.id ?? null])).toEqual([
      ["button", "btn1"],
      ["paragraph", expect.anything()],
    ]);
    expect(renamed[0].props).toEqual({ label: "Begin", icon: "🚀", config, color: "" });
  });

  it("can't be made from Markdown", async () => {
    expect(await markdownToBlocks(buttonLine("elsewhere", "Mine"), existing())).toEqual([]);
    expect(await markdownToBlocks(buttonLine("btn1", "Copy"), existing(), { keepMissingInline: false })).toEqual([]);
    // Named twice, it stays once.
    const twice = await markdownToBlocks(`${buttonLine("btn1", "A")}\n\n${buttonLine("btn1", "B")}`, existing());
    expect(twice.filter((b) => b.type === "button")).toHaveLength(1);
  });

  it("show their label, disabled and without their steps, on a published page", async () => {
    const doc = docFrom([
      { type: "paragraph", content: "Visible" },
      { id: "btn1", type: "button", props: { label: "Start the week", icon: "", config } },
    ]);
    const html = JSON.stringify(await bodySegmentsFromYdoc(Y.encodeStateAsUpdate(doc)));
    expect(html).toContain("Start the week");
    expect(html).toContain("disabled");
    expect(html).not.toContain("today");
  });
});

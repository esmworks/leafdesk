import { ServerBlockNoteEditor } from "@blocknote/server-util";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { COLLAB_FRAGMENT } from "@/lib/collab-constants";
import { serverEditor } from "./blocknote";
import { bodyHtmlFromYdoc, bodySegmentsFromYdoc, isSafeLink, isSafeMediaUrl, sanitizeBlocks } from "./published-body";

const editor = ServerBlockNoteEditor.create();

async function ydocFrom(blocks: unknown[]) {
  const doc = new Y.Doc();
  doc.transact(() => editor.blocksToYXmlFragment(blocks as any, doc.getXmlFragment(COLLAB_FRAGMENT)));
  return Y.encodeStateAsUpdate(doc);
}

describe("published page body", () => {
  it("accepts only http(s)/mailto links and http(s) or same-origin media", () => {
    expect(isSafeLink("https://example.com")).toBe(true);
    expect(isSafeLink("mailto:a@b.c")).toBe(true);
    expect(isSafeLink(" javascript:alert(1)")).toBe(false);
    expect(isSafeLink("data:text/html,x")).toBe(false);
    expect(isSafeMediaUrl("/files/a.png")).toBe(true);
    expect(isSafeMediaUrl("//evil.example/a.png")).toBe(false);
    expect(isSafeMediaUrl("/\\evil.example/a.png")).toBe(false);
    expect(isSafeMediaUrl("javascript:alert(1)")).toBe(false);
  });

  it("unwraps unsafe links in table cells of the older, array form", () => {
    const [block] = sanitizeBlocks([
      {
        type: "table",
        props: {},
        content: {
          type: "tableContent",
          rows: [{ cells: [[{ type: "link", href: "javascript:alert(1)", content: [{ type: "text", text: "x", styles: {} }] }]] }],
        },
        children: [],
      },
    ]);
    expect(JSON.stringify(block)).not.toContain("javascript:");
    expect((block.content as any).rows[0].cells[0]).toEqual([{ type: "text", text: "x", styles: {} }]);
  });

  it("unwraps unsafe links and clears unsafe media urls", () => {
    const [block] = sanitizeBlocks([
      {
        type: "paragraph",
        props: {},
        content: [
          { type: "link", href: "javascript:alert(1)", content: [{ type: "text", text: "bad", styles: {} }] },
          { type: "link", href: "https://ok.example", content: [{ type: "text", text: "ok", styles: {} }] },
        ],
        children: [{ type: "image", props: { url: "javascript:alert(2)" }, content: undefined, children: [] }],
      },
    ]);
    expect(block.content).toEqual([
      { type: "text", text: "bad", styles: {} },
      { type: "link", href: "https://ok.example", content: [{ type: "text", text: "ok", styles: {} }] },
    ]);
    expect(block.children[0].props.url).toBe("");
  });

  it("serializes the stored document to escaped HTML", async () => {
    const state = await ydocFrom([
      { type: "heading", props: { level: 2 }, content: "<script>alert(1)</script>" },
      {
        type: "paragraph",
        content: [
          { type: "text", text: "see ", styles: {} },
          { type: "link", href: "javascript:alert(1)", content: [{ type: "text", text: "this", styles: {} }] },
        ],
      },
    ]);
    const html = await bodyHtmlFromYdoc(state);
    expect(html).toContain("<h2");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("see this");
    expect(await bodyHtmlFromYdoc(null)).toBe("");
  });

  it("colors code in its language, keeping the text as text", async () => {
    const code = 'def f(x):\n    return "</code><script>alert(1)</script>"';
    const state = await ydocFrom([
      { type: "codeBlock", props: { language: "py" }, content: code },
      { type: "codeBlock", props: { language: "text" }, content: "plain <b>" },
      { type: "codeBlock", props: { language: "brainfuck" }, content: "+[-->]" },
      // Under a list item too.
      { type: "bulletListItem", content: "item", children: [{ type: "codeBlock", props: { language: "js" }, content: "let a = 1;" }] },
    ]);
    const html = await bodyHtmlFromYdoc(state);
    const root = await editor._withJSDOM(async () => {
      const div = document.createElement("div");
      div.innerHTML = html;
      return div;
    });
    const [python, plain, unknown, nested] = [...root.querySelectorAll("pre > code")];
    expect(python.classList.contains("code-colors")).toBe(true);
    expect(python.textContent).toBe(code);
    expect(root.querySelector("script")).toBeNull();
    const keyword = [...python.querySelectorAll("span")].find((span) => span.textContent === "def");
    expect(keyword?.getAttribute("style")).toMatch(/^--shiki-light:#[0-9a-f]{6};--shiki-dark:#[0-9a-f]{6}$/i);
    expect(plain.querySelector("span")).toBeNull();
    expect(plain.textContent).toBe("plain <b>");
    expect(unknown.querySelector("span")).toBeNull();
    expect(nested.textContent).toBe("let a = 1;");
    expect(nested.classList.contains("code-colors")).toBe(true);
  });

  it("prefixes heading anchors when asked (several bodies in one print)", async () => {
    const state = await ydocFrom([
      { type: "heading", props: { level: 2 }, content: "One" },
      { type: "paragraph", content: "text" },
      { type: "heading", props: { level: 3 }, content: "Two" },
    ]);
    const [plain] = await bodySegmentsFromYdoc(state);
    const [prefixed] = await bodySegmentsFromYdoc(state, { anchorPrefix: "p2-" });
    expect(plain.kind === "html" && plain.html).toContain('id="heading-1"');
    const html = prefixed.kind === "html" ? prefixed.html : "";
    expect(html).toContain('<h2 id="p2-heading-1"');
    expect(html).toContain('<h3 id="p2-heading-2"');
  });

  it("anchors only the real headings: '<h2' typed into a link, a media url or an attribute stays text", async () => {
    // Attribute values come out of the serializer with "<" as is; a heading tag spelled inside one
    // must not get an anchor spliced in (that would close the quote and leave the handler live).
    const typed = 'x<h2 onmouseover=alert(1)//"quoted';
    const imageUrl = "https://x.invalid/<h2 onerror=alert(document.domain)//";
    const linkUrl = "https://x.com/<h2 onmouseover=alert(1)//";
    const state = await ydocFrom([
      { type: "heading", props: { level: 2 }, content: "One" },
      { type: "paragraph", content: [{ type: "link", href: linkUrl, content: [{ type: "text", text: "hover", styles: {} }] }] },
      { type: "image", props: { url: imageUrl, caption: typed, name: typed } },
      { type: "file", props: { url: "https://x.invalid/f", caption: typed, name: typed } },
      { type: "codeBlock", props: { language: typed }, content: "code" },
      { type: "paragraph", props: { textColor: typed, backgroundColor: typed }, content: [{ type: "text", text: "t", styles: { textColor: typed } }] },
      {
        type: "heading",
        props: { level: 2, isToggleable: true },
        content: "Two",
        children: [{ type: "heading", props: { level: 3 }, content: "Three" }],
      },
    ]);
    const [segment] = await bodySegmentsFromYdoc(state);
    const html = segment.kind === "html" ? segment.html : "";
    const root = await editor._withJSDOM(async () => {
      const div = document.createElement("div");
      div.innerHTML = html;
      return div;
    });
    const all = [...root.querySelectorAll("*")];
    expect(all.flatMap((element) => [...element.attributes].map((a) => a.name)).filter((name) => name.startsWith("on"))).toEqual([]);
    expect(root.querySelector("img")?.getAttribute("src")).toBe(imageUrl);
    expect(root.querySelector("a[href^='https://x.com']")?.getAttribute("href")).toBe(linkUrl);
    expect(root.querySelector("img")?.getAttribute("alt")).toBe(typed);
    expect([...root.querySelectorAll("[id]:not(.block-anchor)")].map((element) => [element.tagName, element.id, element.textContent])).toEqual([
      ["H2", "heading-1", "One"],
      ["H2", "heading-2", "Two"],
      ["H3", "heading-3", "Three"],
    ]);
  });

  it("shows uploaded PDFs and workbooks in place and keeps other files as links", async () => {
    const id = "AbCdEfGhIjKlMnOpQrStUv_-";
    const state = await ydocFrom([
      { type: "paragraph", content: "before" },
      { type: "file", props: { url: `/api/files/${id}`, name: "Report.pdf", caption: "Q3" } },
      { type: "file", props: { url: `/api/files/${id}`, name: "Teklif.xlsx", caption: "" } },
      { type: "file", props: { url: `/api/files/${id}`, name: "data.csv", caption: "" } },
      { type: "file", props: { url: "https://example.com/other.pdf", name: "other.pdf", caption: "" } },
    ]);
    const segments = await bodySegmentsFromYdoc(state);
    expect(segments.map((s) => s.kind)).toEqual(["html", "pdf", "spreadsheet", "html"]);
    expect(segments[1]).toEqual({ kind: "pdf", fileId: id, name: "Report.pdf", caption: "Q3" });
    expect(segments[2]).toEqual({ kind: "spreadsheet", fileId: id, name: "Teklif.xlsx", caption: "" });
    const rest = segments[3].kind === "html" ? segments[3].html : "";
    expect(rest).toContain("data.csv");
    expect(rest).toContain("other.pdf");
  });
  it("anchors each block with text, nested ones too, so a link to a block opens the page there", async () => {
    const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
    const state = await ydocFrom([
      { id: id(1), type: "heading", props: { level: 2 }, content: "Title" },
      { id: id(2), type: "paragraph", content: [{ type: "text", text: "bold", styles: { bold: true } }, { type: "text", text: " rest", styles: {} }] },
      { id: id(3), type: "bulletListItem", content: "one", children: [{ id: id(4), type: "bulletListItem", content: "nested" }] },
      { id: id(5), type: "numberedListItem", content: "first" },
      { id: id(6), type: "numberedListItem", content: "second" },
      { id: id(7), type: "codeBlock", props: { language: "js" }, content: "let a = 1;" },
      { id: id(8), type: "paragraph", content: "" },
      { id: id(9), type: "image", props: { url: "https://x.invalid/a.png" } },
    ]);
    const html = await bodyHtmlFromYdoc(state);
    const root = await editor._withJSDOM(async () => {
      const div = document.createElement("div");
      div.innerHTML = html;
      return div;
    });
    const anchors = [...root.querySelectorAll(".block-anchor")];
    expect(anchors.map((a) => a.id)).toEqual([1, 2, 3, 4, 5, 6, 7].map((n) => `block-${id(n)}`));
    expect(anchors.every((a) => a.textContent === "" && a.attributes.length === 2)).toBe(true);
    // Where each lands: its block's own element, the heading keeping its anchor.
    expect(anchors[0].parentElement?.outerHTML).toMatch(/^<h2 id="heading-1"/);
    expect(anchors[1].nextSibling?.textContent).toBe("bold");
    expect(anchors[3].closest("li")?.textContent).toBe("nested");
    // The numbered list stays one list.
    expect(root.querySelectorAll("ol")).toHaveLength(1);
    expect(root.querySelectorAll("ol > li")).toHaveLength(2);
    // Before the code, which is colored as before.
    expect(anchors[6].parentElement?.tagName).toBe("PRE");
    expect(root.querySelector("pre > code")?.textContent).toBe("let a = 1;");
    expect(root.querySelector("pre > code")?.classList.contains("code-colors")).toBe(true);
    // No marker is left anywhere, and the text reads as before.
    expect(html).not.toMatch(/[\uE000\uE001]/);
    expect(root.textContent).toContain("Titlebold restonenestedfirstsecond");
  });

  it("anchors nothing from the document: an id or a marker typed as text stays text", async () => {
    const typed = '\uE0000:0\uE001 <span id="block-x"> #block-y';
    const state = await ydocFrom([{ id: "not an id!", type: "paragraph", content: typed }, { type: "paragraph", content: typed }]);
    const html = await bodyHtmlFromYdoc(state);
    const root = await editor._withJSDOM(async () => {
      const div = document.createElement("div");
      div.innerHTML = html;
      return div;
    });
    expect(root.querySelector("#block-x")).toBeNull();
    const anchors = [...root.querySelectorAll("[id]")];
    // Only the second paragraph, which has a real id, is anchored; both keep the text as typed.
    expect(anchors).toHaveLength(1);
    expect(anchors[0].id).toMatch(/^block-[\w-]+$/);
    expect([...root.querySelectorAll("p")].map((p) => p.textContent)).toEqual([typed, typed]);
  });

  it("links a mention of a block of a published page to that block", async () => {
    const target = "11111111-1111-4111-8111-111111111111";
    const block = "22222222-2222-4222-8222-222222222222";
    const doc = new Y.Doc();
    const blocks = [
      { type: "paragraph", content: [{ type: "mention", props: { kind: "page", pageId: target, blockId: block } }] },
      { type: "pageLink", props: { pageId: target, blockId: block } },
      { type: "paragraph", content: [{ type: "mention", props: { kind: "page", pageId: target, blockId: "bad id" } }] },
    ];
    doc.transact(() => serverEditor.blocksToYXmlFragment(blocks as never, doc.getXmlFragment(COLLAB_FRAGMENT)));
    const state = Y.encodeStateAsUpdate(doc);
    const segments = await bodySegmentsFromYdoc(state, {
      resolvePages: async (ids) => new Map(ids.map((i) => [i, { text: "Target", href: "/s/site/target" }])),
    });
    const html = segments.map((s) => (s.kind === "html" ? s.html : "")).join("");
    expect(html.match(/href="[^"]*"/g)).toEqual([`href="/s/site/target#block-${block}"`, `href="/s/site/target#block-${block}"`, 'href="/s/site/target"']);
  });
});

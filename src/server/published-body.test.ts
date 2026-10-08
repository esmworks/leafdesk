import { ServerBlockNoteEditor } from "@blocknote/server-util";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { COLLAB_FRAGMENT } from "@/lib/collab-constants";
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
    expect(isSafeMediaUrl("javascript:alert(1)")).toBe(false);
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
    expect([...root.querySelectorAll("[id]")].map((element) => [element.tagName, element.id, element.textContent])).toEqual([
      ["H2", "heading-1", "One"],
      ["H2", "heading-2", "Two"],
      ["H3", "heading-3", "Three"],
    ]);
  });

  it("shows uploaded PDFs in place and keeps other files as links", async () => {
    const id = "AbCdEfGhIjKlMnOpQrStUv_-";
    const state = await ydocFrom([
      { type: "paragraph", content: "before" },
      { type: "file", props: { url: `/api/files/${id}`, name: "Report.pdf", caption: "Q3" } },
      { type: "file", props: { url: `/api/files/${id}`, name: "data.csv", caption: "" } },
      { type: "file", props: { url: "https://example.com/other.pdf", name: "other.pdf", caption: "" } },
    ]);
    const segments = await bodySegmentsFromYdoc(state);
    expect(segments.map((s) => s.kind)).toEqual(["html", "pdf", "html"]);
    expect(segments[1]).toEqual({ kind: "pdf", fileId: id, name: "Report.pdf", caption: "Q3" });
    const rest = segments[2].kind === "html" ? segments[2].html : "";
    expect(rest).toContain("data.csv");
    expect(rest).toContain("other.pdf");
  });
});

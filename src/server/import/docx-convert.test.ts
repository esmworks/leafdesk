import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { ImportError } from "@/lib/import/result";
import type { PageBlock } from "../blocknote";
import { checkDocx, DOCX_LIMITS, docxBlocks, docxToHtml, IMAGE_TOKEN, imageSources, placeImages } from "./docx-convert";
import { bullet, docx, footnoteReference, hyperlink, image, numbered, pageBreak, paragraph, PNG, run, table } from "./docx-fixtures";

/** A document's blocks and title, the way the import reads it. */
async function read(file: Uint8Array) {
  const { html, images } = await docxToHtml("Test.docx", file);
  return { ...(await docxBlocks("Test.docx", html)), images };
}

type Inline = { type: string; text?: string; href?: string; styles?: Record<string, boolean>; content?: Inline[] };
const text = (block: PageBlock) => ((block.content ?? []) as Inline[]).map((i) => i.text ?? (i.content ?? []).map((c) => c.text).join("")).join("");
const shape = (blocks: PageBlock[]): unknown[] =>
  blocks.map((b) => {
    const level = (b.props as { level?: number }).level;
    const head = `${b.type}${level ? level : ""}: ${text(b)}`;
    return b.children?.length ? [head, shape(b.children)] : head;
  });

async function failure(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    if (error instanceof ImportError) return error.code;
    throw error;
  }
}

describe("reading a Word document", () => {
  it("takes the first heading as the title, and keeps headings, lists and quotes", async () => {
    const { title, blocks } = await read(
      docx({
        body: [
          paragraph("Quarterly report", { style: "Heading1" }),
          paragraph("Intro"),
          paragraph("Section", { style: "Heading2" }),
          paragraph("Detail", { style: "Heading3" }),
          paragraph("Deeper", { style: "Heading4" }),
          paragraph("Deepest", { style: "Heading5" }),
          bullet("One"),
          bullet("Nested", 1),
          bullet("Two"),
          numbered("First"),
          numbered("Inner", 1),
          numbered("Second"),
          paragraph("Said someone", { style: "Quote" }),
          paragraph("Said louder", { style: "IntenseQuote" }),
          paragraph([run("Before"), pageBreak(), run("after")]),
        ].join(""),
      }),
    );
    expect(title).toBe("Quarterly report");
    expect(shape(blocks)).toEqual([
      "paragraph: Intro",
      "heading2: Section",
      "heading3: Detail",
      "heading3: Deeper",
      "heading3: Deepest",
      ["bulletListItem: One", ["bulletListItem: Nested"]],
      "bulletListItem: Two",
      ["numberedListItem: First", ["numberedListItem: Inner"]],
      "numberedListItem: Second",
      "quote: Said someone",
      "quote: Said louder",
      "paragraph: Beforeafter",
    ]);
  });

  it("takes a Title paragraph as the title too, and otherwise leaves the title to the file name", async () => {
    const titled = await read(docx({ body: paragraph("The title", { style: "Title" }) + paragraph("Body") }));
    expect(titled.title).toBe("The title");
    expect(shape(titled.blocks)).toEqual(["paragraph: Body"]);

    const untitled = await read(docx({ body: paragraph("Body first") + paragraph("Later", { style: "Heading1" }) }));
    expect(untitled.title).toBeNull();
    expect(shape(untitled.blocks)).toEqual(["paragraph: Body first", "heading1: Later"]);
  });

  it("keeps bold, italic, underline and strikethrough, and only safe links", async () => {
    const { blocks } = await read(
      docx({
        body: [
          paragraph([run("B", { bold: true }), run("I", { italic: true }), run("U", { underline: true }), run("S", { strike: true })]),
          paragraph([hyperlink("rIdWeb", "web"), run(" "), hyperlink("rIdMail", "mail"), run(" "), hyperlink("rIdScript", "script")]),
        ].join(""),
        relationships: [
          { id: "rIdWeb", type: "hyperlink", target: "https://example.com/page", external: true },
          { id: "rIdMail", type: "hyperlink", target: "mailto:someone@example.com", external: true },
          { id: "rIdScript", type: "hyperlink", target: "javascript:alert(1)", external: true },
        ],
      }),
    );
    const styled = blocks[0].content as Inline[];
    expect(styled.map((i) => [i.text, Object.keys(i.styles ?? {})])).toEqual([
      ["B", ["bold"]],
      ["I", ["italic"]],
      ["U", ["underline"]],
      ["S", ["strike"]],
    ]);
    const links = (blocks[1].content as Inline[]).filter((i) => i.type === "link").map((i) => i.href);
    expect(links).toEqual(["https://example.com/page", "mailto:someone@example.com"]);
    expect(text(blocks[1])).toBe("web mail script");
  });

  it("reads tables with their header row", async () => {
    const { blocks } = await read(docx({ body: table([["Plant", "Water"], ["Fern", "Daily"]], { header: true }) + table([["a", "b"]]) }));
    expect(blocks.map((b) => b.type)).toEqual(["table", "table"]);
    const content = blocks[0].content as unknown as { headerRows?: number; rows: { cells: { content: Inline[] }[] }[] };
    expect(content.headerRows).toBe(1);
    expect(content.rows.map((r) => r.cells.map((c) => c.content.map((i) => i.text).join("")))).toEqual([
      ["Plant", "Water"],
      ["Fern", "Daily"],
    ]);
    expect((blocks[1].content as unknown as { headerRows?: number }).headerRows ?? 0).toBe(0);
  });

  it("hands pictures back for upload and leaves those linked from outside without a source", async () => {
    const { blocks, images } = await read(
      docx({
        body: paragraph([image({ embed: "rIdPicture" }, "A dot")]) + paragraph([image({ link: "rIdOutside" })]),
        relationships: [
          { id: "rIdPicture", type: "image", target: "media/image1.png" },
          { id: "rIdOutside", type: "image", target: "https://example.com/tracker.png", external: true },
        ],
        media: { "image1.png": PNG },
      }),
    );
    expect(images).toHaveLength(1);
    expect(images[0].contentType).toBe("image/png");
    expect([...images[0].data]).toEqual([...PNG]);
    expect(imageSources(blocks)).toEqual([images[0].token, ""]);
    expect(images[0].token.startsWith(IMAGE_TOKEN)).toBe(true);

    const placed = placeImages(blocks, new Map([[images[0].token, "/api/files/abc"]]));
    expect(placed.map((b) => [b.type, (b.props as { url?: string }).url, (b.props as { name?: string }).name])).toEqual([
      ["image", "/api/files/abc", "A dot"],
    ]);
    // Not uploaded: no picture at all, never a URL from elsewhere.
    expect(placeImages(blocks, new Map())).toEqual([]);
  });

  it("reads monospace paragraphs as code", async () => {
    const { blocks } = await read(
      docx({
        body: [
          paragraph([run("const a = 1;", { font: "Courier New" })]),
          paragraph([run("const b = 2;", { font: "Consolas" })]),
          paragraph([run("Mixed "), run("code", { font: "Consolas" })]),
        ].join(""),
      }),
    );
    expect(blocks[0].type).toBe("codeBlock");
    expect(text(blocks[0])).toBe("const a = 1;\nconst b = 2;");
    expect(shape(blocks.slice(1))).toEqual(["paragraph: Mixed code"]);
  });

  it("adds footnotes at the end as a list", async () => {
    const { blocks } = await read(docx({ body: paragraph([run("Claim"), footnoteReference(1)]), footnotes: ["The source."] }));
    expect(shape(blocks)).toEqual(["paragraph: Claim[1]", "numberedListItem: The source."]);
    // The reference keeps its superscript but not its in-page link, and the back link is gone.
    expect(JSON.stringify(blocks)).not.toContain("#footnote");
    expect(JSON.stringify(blocks)).not.toContain("↑");
  });

  it("refuses files that aren't Word documents, and documents over the limits", async () => {
    expect(await failure(() => docxToHtml("old.doc", new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])))).toBe("badDocx");
    expect(await failure(() => docxToHtml("cut.docx", docx({ body: paragraph("x") }).slice(0, 100)))).toBe("badDocx");
    expect(await failure(() => docxToHtml("other.docx", zipSync({ "notes.txt": strToU8("hi") })))).toBe("badDocx");
    // A package without a document part: mammoth can't find one.
    expect(await failure(() => docxToHtml("empty.docx", zipSync({ "[Content_Types].xml": strToU8("<Types/>") })))).toBe("badDocx");
    const huge = zipSync({ "[Content_Types].xml": strToU8("<Types/>"), "word/document.xml": new Uint8Array(DOCX_LIMITS.xmlBytes + 1) });
    expect(() => checkDocx("huge.docx", huge)).toThrow(expect.objectContaining({ code: "docxTooComplex" }));
  });

  it("gives up on a document that takes too long", async () => {
    const limit = DOCX_LIMITS.timeoutMs;
    DOCX_LIMITS.timeoutMs = 1;
    try {
      expect(await failure(() => docxToHtml("slow.docx", docx({ body: paragraph("x") })))).toBe("docxTooComplex");
    } finally {
      DOCX_LIMITS.timeoutMs = limit;
    }
  });
});

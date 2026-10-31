import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import type { MdBlock } from "@/lib/content-markdown";
import { imageData, imageSize, renderDocx, tableWidths, type DocxInput } from "./docx-document";
import type { PdfLetterhead, PdfSection } from "./pdf-document";

const text = (value: string, styles: Record<string, unknown> = {}) => ({ type: "text", text: value, styles });
const block = (type: string, content: unknown = [], props: Record<string, unknown> = {}, children: MdBlock[] = []): MdBlock => ({
  id: `${type}-${Math.random()}`,
  type,
  props,
  content,
  children,
});
const cell = (value: string, props: Record<string, unknown> = {}) => ({ type: "tableCell", content: [text(value)], props: { colspan: 1, rowspan: 1, ...props } });

/** A 2×1 PNG (red, then blue), as a data URL. */
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAEUlEQVR4nGP4z8DwnwEIGAAAHvkC/s6qO7gAAAAASUVORK5CYII=";

function input(blocks: MdBlock[], extra: Partial<PdfSection> = {}, more: Partial<DocxInput> = {}): DocxInput {
  return {
    title: "Offer",
    sections: [{ title: "Offer", blocks, properties: [], database: null, embeds: new Map(), crumbs: [], children: [], ...extra }],
    images: new Map(),
    link: (url) => (url.startsWith("/") ? `https://app.example${url}` : url),
    labels: { untitled: "Untitled", unavailable: "Not available" },
    ...more,
  };
}

/** The .docx file's parts, as text by path. */
async function parts(i: DocxInput): Promise<Record<string, string>> {
  const files = unzipSync(new Uint8Array(await renderDocx(i)));
  return Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, path.startsWith("word/media/") ? `${bytes.length} bytes` : strFromU8(bytes)]));
}

describe("docx document", () => {
  it("starts with the title, without a first heading repeating it, and uses Word's heading styles", async () => {
    const doc = (await parts(input([block("heading", [text("offer")], { level: 1 }), block("heading", [text("Terms")], { level: 2 }), block("paragraph", [text("Body")])])))[
      "word/document.xml"
    ];
    expect(doc).toContain('<w:pStyle w:val="Title"/>');
    expect(doc.match(/>offer</g)).toBeNull();
    expect(doc).toContain('<w:pStyle w:val="Heading2"/>');
    expect(doc).toContain(">Terms<");
    expect(doc).toContain(">Body<");
  });

  it("writes inline styles, links made absolute and Word footnotes", async () => {
    const files = await parts(
      input([
        block("paragraph", [
          text("bold", { bold: true }),
          text("slanted", { italic: true }),
          { type: "link", href: "/w/1/p/2", content: [text("page")] },
          { type: "footnote", content: [text("A note")] },
        ]),
      ]),
    );
    const doc = files["word/document.xml"];
    expect(doc).toMatch(/<w:b\/>.*>bold</s);
    expect(doc).toMatch(/<w:i\/>.*>slanted</s);
    expect(doc).toContain("<w:hyperlink");
    expect(files["word/_rels/document.xml.rels"]).toContain('Target="https://app.example/w/1/p/2"');
    expect(doc).toContain("<w:footnoteReference");
    expect(files["word/footnotes.xml"]).toContain(">A note<");
  });

  it("makes lists of Word's numbering, each numbered list counting from 1 on its own", async () => {
    const doc = (
      await parts(
        input([
          block("numberedListItem", [text("one")]),
          block("numberedListItem", [text("two")], {}, [block("numberedListItem", [text("nested")])]),
          block("paragraph", [text("between")]),
          block("numberedListItem", [text("again")]),
          block("bulletListItem", [text("dot")]),
        ]),
      )
    )["word/document.xml"];
    const ids = [...doc.matchAll(/<w:ilvl w:val="(\d)"\/><w:numId w:val="(\d+)"\/>/g)].map((m) => [Number(m[1]), Number(m[2])]);
    expect(ids).toHaveLength(5);
    // "one" and "two" share a list; "nested" is a level in; "again" is a list of its own.
    expect(ids[0]).toEqual(ids[1]);
    expect(ids[2][0]).toBe(1);
    expect(ids[3][1]).not.toBe(ids[0][1]);
    expect(doc).not.toContain(">1.<");
  });

  it("writes tables with merged cells, repeated header rows and amounts on the right", async () => {
    const table = block("table", {
      type: "tableContent",
      headerRows: 1,
      rows: [
        { cells: [cell("Item"), cell("Price")] },
        { cells: [cell("Pump", { rowspan: 2 }), cell("1.250,00 ₺")] },
        { cells: [cell("90,50 ₺")] },
        { cells: [cell("Total", { colspan: 2 })] },
      ],
    });
    const doc = (await parts(input([table])))["word/document.xml"];
    expect(doc).toContain("<w:tblHeader/>");
    expect(doc).toContain('<w:gridSpan w:val="2"/>');
    expect(doc).toContain('<w:vMerge w:val="restart"/>');
    expect(doc).toContain('<w:vMerge w:val="continue"/>');
    expect(doc).toMatch(/<w:jc w:val="right"\/>.*>1\.250,00 ₺</s);
    expect(doc).toContain('w:type="dxa"');
    expect(doc).not.toContain('w:type="pct"');
  });

  it("puts a letterhead's logo and lines in the header, and its lines and page numbers in the footer", async () => {
    const letterhead: PdfLetterhead = { logo: PNG, logoPlace: "left", header: "ESM Soğutma\nİstanbul", footer: "www.example.com", accent: "#1f6f43", pageNumbers: true };
    const files = await parts(input([block("paragraph", [text("Body")])], {}, { letterhead }));
    const header = Object.entries(files).find(([path]) => /word\/header\d*\.xml/.test(path))?.[1] ?? "";
    const footer = Object.entries(files).find(([path]) => /word\/footer\d*\.xml/.test(path))?.[1] ?? "";
    expect(header).toContain(">ESM Soğutma<");
    expect(header).toContain(">İstanbul<");
    expect(header).toContain("<pic:pic");
    expect(header).toContain('w:color="1F6F43"');
    expect(footer).toContain(">www.example.com<");
    expect(footer).toContain("PAGE");
    expect(footer).toContain("NUMPAGES");
    expect(Object.keys(files).some((path) => path.startsWith("word/media/"))).toBe(true);
  });

  it("embeds the images it is given at their size, and names the others as links", async () => {
    const images = new Map([["/api/files/a", PNG]]);
    const files = await parts(
      input([block("image", [], { url: "/api/files/a", caption: "Front", previewWidth: 400 }), block("image", [], { url: "/api/files/b", name: "back.heic" })], {}, { images }),
    );
    const doc = files["word/document.xml"];
    // 2×1 pixels, at 9525 EMU each.
    expect(doc).toContain('cx="19050" cy="9525"');
    expect(doc).toContain(">Front<");
    expect(doc).toContain(">back.heic<");
    expect(files["word/_rels/document.xml.rels"]).toContain("https://app.example/api/files/b");
  });

  it("drops control characters XML doesn't allow, which pasted text carries", async () => {
    const files = await parts(
      input([
        block("paragraph", [text("a\u000bb\u0001c")]),
        block("codeBlock", [text("x\u0002y")]),
        block("callout", [text("note")], { title: "Ti\u0003tle" }),
        block("paragraph", [{ type: "link", href: "https://example.com/\u0004", content: [text("link")] }]),
      ]),
    );
    const doc = files["word/document.xml"];
    expect(doc).toContain(">abc<");
    expect(doc).toContain(">xy<");
    expect(doc).toContain(">Title<");
    for (const part of Object.values(files)) expect(part).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
  });

  it("lists a row's values and a database's rows as tables", async () => {
    const doc = (
      await parts(
        input([], {
          properties: [{ name: "Customer", value: "ESM" }],
          database: { header: ["Name", "Amount"], rows: [["Pump", "1250"]], align: [undefined, "right"] },
        }),
      )
    )["word/document.xml"];
    expect(doc).toContain(">Customer<");
    expect(doc).toContain(">ESM<");
    expect(doc).toMatch(/<w:jc w:val="right"\/>.*>1250</s);
  });
});

describe("imageSize", () => {
  it("reads a PNG's and a JPEG's size from the header", () => {
    expect(imageSize(Buffer.from(PNG.split(",")[1], "base64"))).toEqual({ width: 2, height: 1 });
    // SOI, an APP0 segment, then SOF0 with 3 × 5 pixels.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x05, 0x00, 0x03, 0x03, 0x01, 0x22, 0x00]);
    expect(imageSize(jpeg)).toEqual({ width: 3, height: 5 });
    expect(imageSize(Buffer.from("GIF89a"))).toBeNull();
    expect(imageData("data:image/gif;base64,R0lGODlh")).toBeNull();
  });
});

describe("tableWidths", () => {
  it("adds up to the width, the editor's own widths scaled down to fit", () => {
    const sized = tableWidths(null, [["Item", "A much longer description of it"]], 2, 9638);
    expect(sized.reduce((a, b) => a + b, 0)).toBe(9638);
    expect(sized[1]).toBeGreaterThan(sized[0]);
    const given = tableWidths([400, 400], [], 2, 9638);
    expect(given.reduce((a, b) => a + b, 0)).toBe(9638);
    expect(given[0]).toBe(given[1]);
    expect(tableWidths([100, 50], [], 2, 9638)).toEqual([1500, 750]);
  });
});

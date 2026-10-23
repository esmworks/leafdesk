import { describe, expect, it } from "vitest";
import pdfmake from "pdfmake";
import roboto from "pdfmake/fonts/Roboto.js";
import type { ContentTable, ContentText, ContentUnorderedList } from "pdfmake/interfaces";
import type { MdBlock } from "@/lib/content-markdown";
import { tint } from "@/lib/letterheads";
import { pdfDocument, type PdfInput, type PdfSection } from "./pdf-document";

const text = (value: string, styles: Record<string, unknown> = {}) => ({ type: "text", text: value, styles });
const block = (type: string, content: unknown = [], props: Record<string, unknown> = {}, children: MdBlock[] = []): MdBlock => ({
  id: `${type}-${Math.random()}`,
  type,
  props,
  content,
  children,
});
const cell = (value: string) => ({ type: "tableCell", content: [text(value)], props: { colspan: 1, rowspan: 1 } });

function input(blocks: MdBlock[], extra: Partial<PdfSection> = {}, images = new Map<string, string>()): PdfInput {
  return {
    title: "Offer",
    sections: [{ title: "Offer", blocks, properties: [], database: null, embeds: new Map(), crumbs: [], children: [], ...extra }],
    images,
    link: (url) => (url.startsWith("/") ? `https://app.example${url}` : url),
    labels: { untitled: "Untitled", unavailable: "Not available" },
  };
}

const contentOf = (i: PdfInput) => pdfDocument(i).content as unknown[];

describe("pdfDocument", () => {
  it("starts with the title, without a first heading repeating it", () => {
    const content = contentOf(input([block("heading", [text("offer")], { level: 1 }), block("paragraph", [text("Body")])]));
    expect((content[0] as ContentText).text).toBe("Offer");
    expect(JSON.stringify(content)).not.toContain('"offer"');
    expect(JSON.stringify(content)).toContain("Body");
  });

  it("draws inline styles, links and footnotes, the notes at the end", () => {
    const content = contentOf(
      input([
        block("paragraph", [
          text("bold", { bold: true }),
          text("slanted", { italic: true }),
          { type: "link", href: "https://example.com", content: [text("site")] },
          { type: "footnote", content: [text("A note")] },
        ]),
      ]),
    );
    const runs = (content[1] as ContentText).text as ContentText[];
    expect(runs[0]).toMatchObject({ text: "bold", bold: true });
    expect(runs[1]).toMatchObject({ text: "slanted", italics: true });
    expect(runs[2]).toMatchObject({ text: "site", link: "https://example.com" });
    expect(runs[3]).toMatchObject({ text: "1", sup: true });
    expect(JSON.stringify(content.at(-1))).toContain("A note");
  });

  it("makes one list of consecutive items, nested items inside", () => {
    const content = contentOf(
      input([block("bulletListItem", [text("one")], {}, [block("bulletListItem", [text("inner")])]), block("bulletListItem", [text("two")])]),
    );
    const list = content[1] as ContentUnorderedList;
    expect(list.ul).toHaveLength(2);
    expect(JSON.stringify(list.ul[0])).toContain("inner");
  });

  it("lays out a table: header shaded, spans filled in, amounts on the right, the longest column taking the room", () => {
    const table = block("table", {
      type: "tableContent",
      headerRows: 1,
      columnWidths: [null, null, null],
      rows: [
        { cells: [cell("#"), cell("Product"), cell("Amount")] },
        { cells: [cell("1"), cell("A very long product description"), cell("244,13 $")] },
        { cells: [{ ...cell("Total"), props: { colspan: 2, rowspan: 1 } }, cell("₺ 1.250,00")] },
      ],
    });
    const drawn = contentOf(input([table]))[1] as ContentTable;
    expect(drawn.table.headerRows).toBe(1);
    expect(drawn.table.widths).toEqual(["auto", "*", "auto"]);
    const [header, first, total] = drawn.table.body as Record<string, unknown>[][];
    expect(header[0]).toMatchObject({ bold: true });
    expect(first[1].alignment).toBeUndefined();
    expect(first[2]).toMatchObject({ alignment: "right" });
    expect(total[0]).toMatchObject({ colSpan: 2 });
    expect(total[1]).toEqual({});
    expect(total[2]).toMatchObject({ alignment: "right" });
  });

  it("shows images it was given, and others as their name linking to the file", () => {
    const images = new Map([["/api/files/aaaaaaaaaaaaaaaaaaaaaaaa", "data:image/png;base64,AAAA"]]);
    const content = contentOf(
      input(
        [
          block("image", undefined, { url: "/api/files/aaaaaaaaaaaaaaaaaaaaaaaa", name: "logo.png", caption: "" }),
          block("image", undefined, { url: "/api/files/bbbbbbbbbbbbbbbbbbbbbbbb", name: "other.webp", caption: "" }),
        ],
        {},
        images,
      ),
    );
    expect(JSON.stringify(content[1])).toContain('"image":"data:image/png;base64,AAAA"');
    expect(JSON.stringify(content[2])).toContain('"link":"https://app.example/api/files/bbbbbbbbbbbbbbbbbbbbbbbb"');
  });

  it("prints a database block as its table, or a note when the reader can't see it", () => {
    const shown = block("database", undefined, { databaseId: "d1" });
    const hidden = block("database", undefined, { databaseId: "d2" });
    const content = contentOf(
      input([shown, hidden], { embeds: new Map([[shown.id!, { title: "Prices", table: { header: ["Name", "Price"], rows: [["A", "10"]] } }]]) }),
    );
    expect(JSON.stringify(content)).toContain("Prices");
    expect(JSON.stringify(content)).toContain("Not available");
  });

  it("lists a row's values under the title when given", () => {
    const content = contentOf(input([], { properties: [{ name: "Status", value: "Sent" }] }));
    expect(JSON.stringify(content[1])).toContain("Sent");
  });

  it("prints a letterhead: its logo and lines at the top, its lines and page numbers at the foot, the body below", () => {
    const logo = "data:image/png;base64,AAAA";
    const letterhead = { logo, logoPlace: "left" as const, header: "3E Soğutma\nİstanbul\nTel", footer: "IBAN TR00", accent: "#0b5ea8", pageNumbers: true };
    const table = block("table", { type: "tableContent", headerRows: 1, rows: [{ cells: [cell("A")] }, { cells: [cell("1")] }] });
    const doc = pdfDocument({ ...input([table]), letterhead });
    const plain = pdfDocument(input([table]));
    const top = (doc.header as () => unknown)();
    expect(JSON.stringify(top)).toContain(logo);
    expect(JSON.stringify(top)).toContain("3E Soğutma");
    expect(JSON.stringify(top)).toContain('"lineColor":"#0b5ea8"');
    // The body starts below the letterhead, and ends above its foot.
    const [, docTop, , docBottom] = doc.pageMargins as number[];
    const [, plainTop, , plainBottom] = plain.pageMargins as number[];
    expect(docTop).toBeGreaterThan(plainTop + 40);
    expect(docBottom).toBeGreaterThanOrEqual(plainBottom);
    const foot = (doc.footer as (c: number, t: number) => unknown)(1, 1);
    expect(JSON.stringify(foot)).toContain("IBAN TR00");
    expect(JSON.stringify(foot)).toContain("1 / 1");
    // Without a letterhead a single page has no number.
    expect((plain.footer as (c: number, t: number) => unknown)(1, 1)).toBeNull();
    // Table headers take a tint of the accent.
    const drawn = (doc.content as unknown[])[1] as ContentTable;
    expect((drawn.table.body[0][0] as { fillColor?: string }).fillColor).toBe(tint("#0b5ea8", 0.86));
  });

  it("leaves the top as without one when a letterhead has neither logo nor lines there", () => {
    const doc = pdfDocument({ ...input([]), letterhead: { logo: null, logoPlace: "center", header: "", footer: "", accent: "", pageNumbers: false } });
    expect(doc.header).toBeUndefined();
    expect((doc.footer as (c: number, t: number) => unknown)(1, 2)).toBeNull();
  });

  it("renders a PDF whose text reads back, Turkish letters included", async () => {
    pdfmake.setFonts(roboto);
    pdfmake.setUrlAccessPolicy(() => false);
    pdfmake.setLocalAccessPolicy(() => true);
    const bytes = await pdfmake
      .createPdf(pdfDocument(input([block("paragraph", [text("Sayın ESM Soğutma — İstanbul, ödeme: 90 gün çek")])])))
      .getBuffer();
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    const { extractText, getDocumentProxy } = await import("unpdf");
    const { text: read } = await extractText(await getDocumentProxy(new Uint8Array(bytes)), { mergePages: true });
    expect(read).toContain("Sayın ESM Soğutma");
    expect(read).toContain("İstanbul");
    expect(read).toContain("ödeme: 90 gün çek");
  });
});

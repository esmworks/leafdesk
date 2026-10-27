import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import pdfmake from "pdfmake";
import roboto from "pdfmake/fonts/Roboto.js";
import type { ContentTable, ContentText, ContentUnorderedList } from "pdfmake/interfaces";
import type { MdBlock } from "@/lib/content-markdown";
import { tint } from "@/lib/letterheads";
import { ENGLISH_STARTER_LABELS, starterTheme } from "@/lib/pdf-theme-starter";
import type { PdfTheme } from "@/lib/pdf-themes";
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

  it("writes a code block's caption under it", () => {
    const content = contentOf(input([block("codeBlock", "let a = 1;", { language: "js", caption: "Setting a" }), block("codeBlock", "b()", { language: "js", caption: "" })]));
    expect(JSON.stringify(content[1])).toContain('"text":"Setting a"');
    expect(JSON.stringify(content[2])).not.toContain("caption");
    expect(content[2]).toMatchObject({ table: expect.anything() });
  });

  it("draws a cropped image as an SVG showing only its part", () => {
    const url = "/api/files/aaaaaaaaaaaaaaaaaaaaaaaa";
    const images = new Map([[url, "data:image/png;base64,AAAA"]]);
    const crop = JSON.stringify({ x: 0.25, y: 0.5, w: 0.5, h: 0.25, ar: 2 });
    const content = contentOf(input([block("image", undefined, { url, name: "a.png", caption: "", crop })], {}, images));
    const svg = (content[1] as { stack: { svg?: string; image?: string }[] }).stack[0];
    expect(svg.image).toBeUndefined();
    // The image is 1000 by 500; the part starts at (250, 250) and is 500 by 125.
    expect(svg.svg).toContain('viewBox="250 250 500 125"');
    expect(svg.svg).toContain('width="1000" height="500"');
    expect(svg.svg).toContain('xlink:href="data:image/png;base64,AAAA"');
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

  it("prints the comment threads after the body when given, and nothing without them", async () => {
    const comments: PdfSection["comments"] = {
      heading: "Comments",
      resolved: "Resolved",
      threads: [
        {
          about: "“Invoices downloadable as PDF”",
          resolved: true,
          comments: [
            { author: "Ada Demir", date: "2026-10-24 09:12 UTC", body: [{ type: "paragraph", content: [text("Also by email?") as never] }] },
            { author: "Bora Kaya", date: "2026-10-24 09:15 UTC", body: [{ type: "paragraph", content: [text("Yes") as never] }] },
          ],
        },
      ],
    };
    expect(JSON.stringify(contentOf(input([block("paragraph", [text("Body")])], { comments: null })))).not.toContain("Comments");
    pdfmake.setFonts(roboto);
    pdfmake.setUrlAccessPolicy(() => false);
    pdfmake.setLocalAccessPolicy(() => true);
    const bytes = await pdfmake.createPdf(pdfDocument(input([block("paragraph", [text("Body")])], { comments }))).getBuffer();
    const { extractText, getDocumentProxy } = await import("unpdf");
    const { text: read } = await extractText(await getDocumentProxy(new Uint8Array(bytes)), { mergePages: true });
    expect(read.indexOf("Body")).toBeLessThan(read.indexOf("Comments"));
    for (const expected of ["Invoices downloadable as PDF", "Resolved", "Ada Demir", "2026-10-24 09:12 UTC", "Also by email?", "Bora Kaya", "Yes"]) {
      expect(read).toContain(expected);
    }
  });

  it("draws a built-in page or callout icon, and never prints an icon's stored text", async () => {
    const callout = block("callout", [text("Remember")], { icon: "icon:lightbulb:yellow", backgroundColor: "gray" });
    const content = contentOf(input([callout, block("callout", [text("Plain")], { icon: "💡" })], { icon: "icon:star:blue" }));
    const json = JSON.stringify(content);
    expect(json).toContain("<svg");
    expect(json).toContain("#0b6fa7");
    expect(json).toContain("#7f6606");
    pdfmake.setFonts(roboto);
    pdfmake.setUrlAccessPolicy(() => false);
    pdfmake.setLocalAccessPolicy(() => true);
    const bytes = await pdfmake.createPdf(pdfDocument(input([callout], { icon: "icon:star:blue" }))).getBuffer();
    const { extractText, getDocumentProxy } = await import("unpdf");
    const { text: read } = await extractText(await getDocumentProxy(new Uint8Array(bytes)), { mergePages: true });
    expect(read).toContain("Offer");
    expect(read).toContain("Remember");
    expect(read).not.toContain("icon:");
    // An emoji page icon draws nothing: the title stays plain text.
    expect((contentOf(input([], { icon: "⭐" }))[0] as ContentText).text).toBe("Offer");
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

  it("counts nested numbered lists in letters, then roman numerals", () => {
    const deep = block("numberedListItem", [text("a")], {}, [block("numberedListItem", [text("i")])]);
    const content = contentOf(input([block("numberedListItem", [text("1")], {}, [deep])]));
    const json = JSON.stringify(content);
    expect(json).toContain('"type":"lower-alpha"');
    expect(json).toContain('"type":"lower-roman"');
    expect((content[1] as { type?: string }).type).toBeUndefined();
  });

  it("scales the body's text, not the letterhead's", () => {
    const letterhead = { logo: null, logoPlace: "center" as const, header: "ESM", footer: "", accent: "", pageNumbers: true };
    const plain = pdfDocument({ ...input([block("heading", [text("Part")], { level: 2 })]), letterhead });
    const big = pdfDocument({ ...input([block("heading", [text("Part")], { level: 2 })]), letterhead, textScale: 1.5 });
    expect(big.defaultStyle?.fontSize).toBe(15.8);
    const sizes = (doc: typeof plain) => [...JSON.stringify(doc.content).matchAll(/"fontSize":([\d.]+)/g)].map((m) => Number(m[1]));
    expect(sizes(big)).toEqual(sizes(plain).map((n) => Math.round(n * 15) / 10));
    expect(JSON.stringify(typeof big.header === "function" ? big.header(1, 1, { width: 0, height: 0, orientation: "portrait" }) : null)).toBe(
      JSON.stringify(typeof plain.header === "function" ? plain.header(1, 1, { width: 0, height: 0, orientation: "portrait" }) : null),
    );
  });

  it("sets Chinese, Japanese and Korean text in the CJK font, the rest in Roboto", () => {
    const content = contentOf({ ...input([block("paragraph", [text("Offer 見積書 for 한국")])]), cjkFont: "CJK" });
    expect(content[1]).toMatchObject({
      text: [{ text: [{ text: "Offer " }, { text: "見積書", font: "CJK" }, { text: " for " }, { text: "한국", font: "CJK" }] }],
    });
    // Without a CJK font nothing changes.
    expect(JSON.stringify(contentOf(input([block("paragraph", [text("見積書")])])))).not.toContain('"font"');
  });

  const NOTO = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc";
  it.skipIf(!existsSync(NOTO))("renders CJK text that reads back where Noto Sans CJK is installed", async () => {
    const face = [NOTO, "NotoSansCJKjp-Regular"] as unknown as string;
    pdfmake.setFonts({ ...roboto, CJK: { normal: face, bold: face } });
    pdfmake.setLocalAccessPolicy(() => true);
    const bytes = await pdfmake
      .createPdf(pdfDocument({ ...input([block("paragraph", [text("見積書 — 한국어, 中文 and English")])]), cjkFont: "CJK" }))
      .getBuffer();
    const { extractText, getDocumentProxy } = await import("unpdf");
    const { text: read } = await extractText(await getDocumentProxy(new Uint8Array(bytes)), { mergePages: true });
    expect(read).toContain("見積書");
    expect(read).toContain("한국어");
    expect(read).toContain("English");
  });
});

describe("pdfDocument in a theme", () => {
  const values = {
    title: "Cold room offer",
    date: "27.10.2026",
    locale: "tr",
    workspace: "Acme",
    properties: [
      { name: "Customer", value: "Akdeniz Gıda" },
      { name: "Quote no", value: "Q-42" },
      { name: "Contact", value: "" },
    ],
  };
  const themed = (theme: PdfTheme, blocks: MdBlock[] = [block("paragraph", [text("Body")])]): PdfInput => ({
    ...input(blocks),
    theme: { theme, logo: null, values },
  });

  it("lays its elements out around the body, placeholders filled, the title left to them", () => {
    const content = contentOf(
      themed({
        title: false,
        content: [{ type: "text", text: "Offer {{property:Quote no}} for {{property:customer}}" }, { type: "body" }, { type: "text", text: "Thanks, {{workspace}}" }],
      }),
    );
    const json = JSON.stringify(content);
    expect(json.indexOf("Offer Q-42 for Akdeniz Gıda")).toBeGreaterThanOrEqual(0);
    expect(json.indexOf("Offer Q-42")).toBeLessThan(json.indexOf("Body"));
    expect(json.indexOf("Body")).toBeLessThan(json.indexOf("Thanks, Acme"));
    expect(json).not.toContain('"text":"Offer"');
  });

  it("puts the body at the end when no element stands for it, after the title", () => {
    const json = JSON.stringify(contentOf(themed({ content: [{ type: "text", text: "Top" }] })));
    expect(json.indexOf("Top")).toBeLessThan(json.indexOf("Offer"));
    expect(json.indexOf("Offer")).toBeLessThan(json.indexOf("Body"));
  });

  it("leaves out fields whose value is empty, and writes capitals the reader's way", () => {
    const json = JSON.stringify(
      contentOf(
        themed({
          content: [
            {
              type: "fields",
              label_caps: true,
              rows: [
                { label: "Firma", value: "{{property:Customer}}" },
                { label: "Yetkili", value: "{{property:Contact}}" },
              ],
            },
          ],
        }),
      ),
    );
    expect(json).toContain("FİRMA");
    expect(json).not.toContain("YETKİLİ");
  });

  it("takes its margins, colors, tables and page numbers from the theme", () => {
    const table = block("table", { type: "tableContent", headerRows: 1, rows: [{ cells: [cell("Item"), cell("Price")] }, { cells: [cell("Fan"), cell("10")] }] });
    const doc = pdfDocument(
      themed(
        {
          colors: { accent: "#003399" },
          margins: { top: 30, left: 36 },
          tables: { header_fill: "accent", header_color: "white" },
          footer: [{ type: "text", text: "{{page}} / {{pages}}" }],
        },
        [table],
      ),
    );
    expect(doc.pageMargins).toEqual([36, 30, 48, 56]);
    const json = JSON.stringify(doc.content);
    expect(json).toContain('"fillColor":"#003399"');
    expect(json).toContain('"color":"#ffffff"');
    const footer = (doc.footer as (current: number, total: number) => unknown)(2, 3);
    expect(JSON.stringify(footer)).toContain("2 / 3");
  });

  it("prints the starter quote on one page, its values read back", async () => {
    pdfmake.setFonts(roboto);
    pdfmake.setUrlAccessPolicy(() => false);
    pdfmake.setLocalAccessPolicy(() => true);
    const theme = starterTheme(ENGLISH_STARTER_LABELS);
    const table = block("table", {
      type: "tableContent",
      headerRows: 1,
      rows: [["Item", "Qty", "Price"], ...Array.from({ length: 6 }, (_, i) => [`Evaporator ${i + 1}`, "2", "1.840,00"])].map((r) => ({ cells: r.map(cell) })),
    });
    const doc = pdfDocument({ ...input([block("paragraph", [text("Thank you for asking.")]), table]), theme: { theme, logo: null, values } });
    const bytes = await pdfmake.createPdf(doc).getBuffer();
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    expect(pdf.numPages).toBe(1);
    const { text: read } = await extractText(pdf, { mergePages: true });
    for (const expected of ["Quote", "Q-42", "Akdeniz Gıda", "Evaporator 6", "Signature", "1 / 1"]) expect(read).toContain(expected);
  });
});

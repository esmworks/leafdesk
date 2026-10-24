import { describe, expect, it } from "vitest";
import { joinLines, pageLines, pdfHtml, type PdfPageText, type PdfTextItem } from "./pdf";

/** A piece of text with a width as wide as its characters at half the size each. */
const at = (str: string, x: number, y: number, size = 11): PdfTextItem => ({ str, x, y, size, width: str.length * size * 0.5 });
const page = (items: PdfTextItem[]): PdfPageText => ({ width: 595, height: 842, items });
/** Body lines from `y` down, 13 points apart. */
const lines = (texts: string[], y: number, x = 40, size = 11) => texts.map((text, i) => at(text, x, y - i * 13, size));

describe("pageLines", () => {
  it("orders a line's pieces by place and joins a split word without a space", () => {
    // "the" ends at 56.5; "fi" (a ligature drawn on its own) at 60, and the rest of its word right after it.
    const [line] = pageLines(page([at("rst check", 66, 700), at("the", 40, 700), { str: "fi", x: 60, y: 700, size: 11, width: 6 }]), 0);
    expect(line.text).toBe("the first check");
  });

  it("puts a space where the gap is wider than a space", () => {
    const [line] = pageLines(page([at("Order the parts.", 56, 600), at("1.", 40, 600)]), 0);
    expect(line.text).toBe("1. Order the parts.");
  });

  it("keeps a superscript on its line and takes the line's size from most of its text", () => {
    const [line] = pageLines(page([at("A note", 40, 600), at("1", 73, 604, 7)]), 0);
    expect(line).toMatchObject({ text: "A note1", size: 11 });
  });

  it("reads right-to-left lines from the right", () => {
    const [line] = pageLines(page([{ ...at("שלום", 200, 600), rtl: true }, { ...at("עולם", 150, 600), rtl: true }]), 0);
    expect(line.text).toBe("שלום עולם");
  });
});

describe("joinLines", () => {
  it("joins a hyphenated word and keeps a hyphen before a capital", () => {
    expect(joinLines("a long para-", "graph")).toBe("a long paragraph");
    expect(joinLines("Coca-", "Cola")).toBe("Coca- Cola");
    expect(joinLines("会議", "について")).toBe("会議について");
  });
});

describe("pdfHtml", () => {
  it("makes headings by size, paragraphs of wrapped lines and lists of numbered lines", () => {
    const { html, chars } = pdfHtml([
      page([
        at("Service report", 40, 780, 24),
        ...lines(["Cold rooms keep food fresh when their doors", "close well and their compressors run."], 740),
        at("What we found", 40, 700, 16),
        ...lines(["1. Order the spare parts.", "2. Book the second visit, which takes"], 670),
        at("a whole day.", 52, 644),
        ...lines(["• Doors were fine.", "• Seals too."], 620),
        at("Details", 40, 580, 13),
        ...lines(["Last words."], 560),
      ]),
    ]);
    expect(chars).toBeGreaterThan(0);
    expect(html).toBe(
      "<h1>Service report</h1>" +
        "<p>Cold rooms keep food fresh when their doors close well and their compressors run.</p>" +
        "<h2>What we found</h2>" +
        "<ol><li><p>Order the spare parts.</p></li><li><p>Book the second visit, which takes a whole day.</p></li></ol>" +
        "<ul><li><p>Doors were fine.</p></li><li><p>Seals too.</p></li></ul>" +
        "<h3>Details</h3>" +
        "<p>Last words.</p>",
    );
  });

  it("keeps spaced items in one list and a wrapped item's line at the margin in its item", () => {
    const { html } = pdfHtml([
      page([
        ...lines(["• The fan was replaced; its wiring was checked because the first check found a", "loose connection."], 700),
        at("• The seals are worn.", 40, 666),
        at("1. Order the seals.", 40, 640),
        at("2. Book the visit.", 40, 614),
        at("• Apples", 40, 588),
        ...lines(["A paragraph right under the list."], 575),
      ]),
    ]);
    expect(html).toBe(
      "<ul><li><p>The fan was replaced; its wiring was checked because the first check found a loose connection.</p></li>" +
        "<li><p>The seals are worn.</p></li></ul>" +
        "<ol><li><p>Order the seals.</p></li><li><p>Book the visit.</p></li></ol>" +
        "<ul><li><p>Apples</p></li></ul>" +
        "<p>A paragraph right under the list.</p>",
    );
  });

  it("nests an item that stands further in", () => {
    const { html } = pdfHtml([page([at("• Fruit", 40, 700), at("– Apples", 60, 687), at("• Bread", 40, 674)])]);
    expect(html).toBe("<ul><li><p>Fruit</p><ul><li><p>Apples</p></li></ul></li><li><p>Bread</p></li></ul>");
  });

  it("starts a paragraph after a gap, and after a short line that ended a sentence", () => {
    const { html } = pdfHtml([
      page([
        ...lines(["The first paragraph runs on over a full line of text", "and ends here."], 700),
        ...lines(["After a gap, another paragraph starts that is long", "and ends."], 660),
        ...lines(["Then one more, right under it without a gap at all."], 634),
      ]),
    ]);
    expect(html.match(/<p>/g)).toHaveLength(3);
  });

  it("carries a paragraph across a page break and leaves out running headers, footers and page numbers", () => {
    const furniture = (n: number) => [at("Acme Cooling — report", 40, 815, 9), at(`Page ${n} of 2`, 270, 30, 9)];
    const { html } = pdfHtml([
      page([...furniture(1), at("Report", 40, 780, 20), ...lines(["A paragraph that starts on the first page and goes"], 740)]),
      page([...furniture(2), ...lines(["on to the second one, where it", "ends. Then another one follows after a gap."], 780), ...lines(["Its last words."], 740)]),
    ]);
    expect(html).toBe(
      "<h1>Report</h1>" +
        "<p>A paragraph that starts on the first page and goes on to the second one, where it ends. Then another one follows after a gap.</p>" +
        "<p>Its last words.</p>",
    );
  });

  it("keeps body lines that happen to repeat at the edges of pages", () => {
    const body = (y: number) => lines(["The same words again and again,", "the same words again and again,", "the same words again and again,"], y);
    const { html } = pdfHtml([page(body(80)), page(body(800))]);
    expect(html.split("ame words").length).toBe(7);
  });

  it("drops a lone page number at the bottom of a one-page PDF and escapes the text", () => {
    const { html } = pdfHtml([page([...lines(["Fish & chips <cheap>"], 700), at("1", 297, 30)])]);
    expect(html).toBe("<p>Fish &amp; chips &lt;cheap&gt;</p>");
  });

  it("finds no text in a scan", () => {
    expect(pdfHtml([page([]), page([at("  ", 40, 700)])])).toEqual({ html: "", chars: 0 });
  });

  it("makes a paragraph of long text in a large size", () => {
    const long = "A lead paragraph set larger than the body ".repeat(6);
    const { html } = pdfHtml([page([at(long, 40, 760, 14), ...lines(["Body text that is the most of the document, long enough to be the body size.", "More of it."], 700)])]);
    expect(html.startsWith(`<p>${long.trim()}</p>`)).toBe(true);
  });
});

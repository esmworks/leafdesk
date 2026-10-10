import { strToU8, zipSync } from "fflate";

/**
 * Small Word documents for the DOCX import's tests, written out of WordprocessingML by hand: just
 * the parts a document needs (content types, relationships, styles, numbering, footnotes and the
 * body), with helpers for the paragraphs, runs, lists, tables, links and images the tests use.
 */

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export type RunOptions = { bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; font?: string };

export function run(text: string, options: RunOptions = {}): string {
  const props = [
    options.font ? `<w:rFonts w:ascii="${escape(options.font)}" w:hAnsi="${escape(options.font)}"/>` : "",
    options.bold ? "<w:b/>" : "",
    options.italic ? "<w:i/>" : "",
    options.strike ? "<w:strike/>" : "",
    options.underline ? '<w:u w:val="single"/>' : "",
  ].join("");
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}<w:t xml:space="preserve">${escape(text)}</w:t></w:r>`;
}

/** A paragraph of runs (or of plain text), with a style id and list numbering when given. */
export function paragraph(content: string | string[], options: { style?: string; list?: { numId: number; level: number } } = {}): string {
  const runs = typeof content === "string" ? run(content) : content.join("");
  const props = [
    options.style ? `<w:pStyle w:val="${options.style}"/>` : "",
    options.list ? `<w:numPr><w:ilvl w:val="${options.list.level}"/><w:numId w:val="${options.list.numId}"/></w:numPr>` : "",
  ].join("");
  return `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ""}${runs}</w:p>`;
}

export const bullet = (text: string, level = 0) => paragraph(text, { style: "ListParagraph", list: { numId: 1, level } });
export const numbered = (text: string, level = 0) => paragraph(text, { style: "ListParagraph", list: { numId: 2, level } });

export function hyperlink(relationshipId: string, text: string): string {
  return `<w:hyperlink r:id="${relationshipId}">${run(text)}</w:hyperlink>`;
}

/** A run with a footnote reference. */
export const footnoteReference = (id: number) => `<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="${id}"/></w:r>`;

/** The footnote's own number, at the start of its text. */
const FOOTNOTE_MARK = '<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r>';

/** A run with a manual page break. */
export const pageBreak = () => '<w:r><w:br w:type="page"/></w:r>';

/** A table of text cells; the first row repeats as a header row when `header` is set. */
export function table(rows: string[][], { header = false } = {}): string {
  const body = rows
    .map(
      (cells, i) =>
        `<w:tr>${i === 0 && header ? "<w:trPr><w:tblHeader/></w:trPr>" : ""}${cells.map((c) => `<w:tc>${paragraph(c)}</w:tc>`).join("")}</w:tr>`,
    )
    .join("");
  return `<w:tbl><w:tblPr/>${body}</w:tbl>`;
}

/** An inline picture: `embed` is the id of an image relationship, `link` of an external one. */
export function image(target: { embed?: string; link?: string }, alt = ""): string {
  const blip = target.embed ? `r:embed="${target.embed}"` : `r:link="${target.link}"`;
  return `<w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="952500" cy="952500"/><wp:docPr id="1" name="Picture 1" descr="${escape(alt)}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="1" name="Picture 1"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip ${blip}/></pic:blipFill><pic:spPr/></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
}

export type Relationship = { id: string; type: "hyperlink" | "image"; target: string; external?: boolean };

const STYLES = [
  ["Normal", "Normal", "paragraph"],
  ["Title", "Title", "paragraph"],
  ["Heading1", "heading 1", "paragraph"],
  ["Heading2", "heading 2", "paragraph"],
  ["Heading3", "heading 3", "paragraph"],
  ["Heading4", "heading 4", "paragraph"],
  ["Heading5", "heading 5", "paragraph"],
  ["Quote", "Quote", "paragraph"],
  ["IntenseQuote", "Intense Quote", "paragraph"],
  ["ListParagraph", "List Paragraph", "paragraph"],
  ["FootnoteText", "footnote text", "paragraph"],
  ["FootnoteReference", "footnote reference", "character"],
] as const;

const levels = (format: string) =>
  [0, 1, 2]
    .map((l) => `<w:lvl w:ilvl="${l}"><w:start w:val="1"/><w:numFmt w:val="${format}"/><w:lvlText w:val="${format === "bullet" ? "•" : `%${l + 1}.`}"/></w:lvl>`)
    .join("");

/** A .docx file with `body` (the paragraphs and tables of w:body) and the parts it refers to. */
export function docx({
  body,
  relationships = [],
  media = {},
  footnotes = [],
}: {
  body: string;
  relationships?: Relationship[];
  /** Files under word/media/ by name. */
  media?: Record<string, Uint8Array>;
  /** Footnote texts; footnote `i + 1` is `footnotes[i]`. */
  footnotes?: string[];
}): Uint8Array {
  const rels = [
    `<Relationship Id="rIdStyles" Type="${REL}/styles" Target="styles.xml"/>`,
    `<Relationship Id="rIdNumbering" Type="${REL}/numbering" Target="numbering.xml"/>`,
    `<Relationship Id="rIdFootnotes" Type="${REL}/footnotes" Target="footnotes.xml"/>`,
    ...relationships.map(
      (r) =>
        `<Relationship Id="${r.id}" Type="${REL}/${r.type}" Target="${escape(r.target)}"${r.external ? ' TargetMode="External"' : ""}/>`,
    ),
  ].join("");
  const footnoteParts = footnotes
    .map((text, i) => `<w:footnote w:id="${i + 1}">${paragraph([FOOTNOTE_MARK, run(` ${text}`)], { style: "FootnoteText" })}</w:footnote>`)
    .join("");
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="gif" ContentType="image/gif"/><Default Extension="emf" ContentType="image/x-emf"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`,
    ),
    "word/_rels/document.xml.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`,
    ),
    "word/styles.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="${W}">${STYLES.map(
        ([id, name, type]) => `<w:style w:type="${type}" w:styleId="${id}"><w:name w:val="${name}"/></w:style>`,
      ).join("")}</w:styles>`,
    ),
    "word/numbering.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="10">${levels("bullet")}</w:abstractNum><w:abstractNum w:abstractNumId="20">${levels("decimal")}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="10"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="20"/></w:num></w:numbering>`,
    ),
    "word/footnotes.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:footnotes xmlns:w="${W}"><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>${footnoteParts}</w:footnotes>`,
    ),
    "word/document.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${body}<w:sectPr/></w:body></w:document>`,
    ),
  };
  for (const [name, bytes] of Object.entries(media)) files[`word/media/${name}`] = bytes;
  return zipSync(files);
}

/** A 1×1 transparent PNG. */
export const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="),
  (c) => c.charCodeAt(0),
);

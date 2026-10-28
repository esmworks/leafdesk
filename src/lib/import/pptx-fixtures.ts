import { strToU8, zipSync } from "fflate";

/**
 * Small PowerPoint presentations for the tests of lib/import/pptx and server/file-text, written out
 * of PresentationML by hand: the package's relationships, the slide list, slides and notes pages.
 */

const NS = `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** A slide's shape tree with one text box per paragraph list. */
export const slideXml = (root: "sld" | "notes", ...boxes: string[][]) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:${root} ${NS}><p:cSld><p:spTree>${boxes
    .map((paragraphs) => `<p:sp><p:txBody><a:bodyPr/>${paragraphs.map((p) => `<a:p>${p}</a:p>`).join("")}</p:txBody></p:sp>`)
    .join("")}</p:spTree></p:cSld></p:${root}>`;

export const run = (text: string) => `<a:r><a:rPr lang="en-US"/><a:t>${text}</a:t></a:r>`;

const rels = (items: [id: string, type: string, target: string][]) =>
  `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items
    .map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`)
    .join("")}</Relationships>`;

/** A presentation listing `order` (slide part numbers), with the given slides and notes. */
export function deck({ order, slides, notes = {} }: { order: number[]; slides: Record<number, string>; notes?: Record<number, string> }) {
  const files: Record<string, string> = {
    "_rels/.rels": rels([["rId1", "officeDocument", "ppt/presentation.xml"]]),
    "ppt/presentation.xml": `<?xml version="1.0"?><p:presentation ${NS}><p:sldIdLst>${order
      .map((n, i) => `<p:sldId id="${256 + i}" r:id="rId${n}"/>`)
      .join("")}</p:sldIdLst></p:presentation>`,
    "ppt/_rels/presentation.xml.rels": rels(Object.keys(slides).map((n) => [`rId${n}`, "slide", `slides/slide${n}.xml`])),
  };
  for (const [n, xml] of Object.entries(slides)) {
    files[`ppt/slides/slide${n}.xml`] = xml;
    if (notes[Number(n)]) {
      files[`ppt/slides/_rels/slide${n}.xml.rels`] = rels([["rId1", "notesSlide", `../notesSlides/notesSlide${n}.xml`]]);
      files[`ppt/notesSlides/notesSlide${n}.xml`] = notes[Number(n)];
    }
  }
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, xml]) => [name, strToU8(xml)])));
}

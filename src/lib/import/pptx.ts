import { Package, relationships } from "./xlsx";

/**
 * Reading the text of PowerPoint presentations (.pptx), for search, the AI chat and get_file (see
 * server/file-text): each slide's paragraphs in the presentation's order, then its speaker notes.
 * Pure and without a DOM. The ZIP's parts are unpacked one at a time within one budget, as a
 * workbook's are (lib/import/xlsx), and only the slides' and notes' parts are read: pictures and
 * media inside the file are never unpacked.
 */

export type SlideText = { text: string; notes: string };

export type PresentationText = {
  slides: SlideText[];
  /** Slides in the presentation, including those past `chars` that weren't read. */
  total: number;
  /** Whether slides were left out because the text read had reached `chars`. */
  partial: boolean;
};

/**
 * The paragraphs of a slide or notes part, one per line. Fields (the slide number, a date) are left
 * out: they are the layout's, not what someone wrote. A notes page's own placeholders hold only such
 * fields and the slide's picture, so its text is what was written in it.
 */
function partText(pkg: Package, path: string): string {
  const paragraphs: string[] = [];
  let paragraph: string[] | null = null;
  let inText = 0;
  let inField = 0;
  pkg.scan(path, {
    open(name, _attrs, empty) {
      if (name === "p") paragraph = [];
      else if (name === "fld") inField++;
      else if (name === "t" && !empty) inText++;
      else if ((name === "br" || name === "tab") && paragraph && !inField) paragraph.push(name === "br" ? "\n" : " ");
    },
    close(name) {
      if (name === "fld") inField--;
      else if (name === "t") inText = Math.max(0, inText - 1);
      else if (name === "p" && paragraph) {
        const line = paragraph.join("").trim();
        if (line) paragraphs.push(line);
        paragraph = null;
      }
    },
    text(text) {
      if (inText && !inField && paragraph) paragraph.push(text);
    },
  });
  return paragraphs.join("\n");
}

const slideNumber = (path: string) => Number(/(\d+)\.xml$/i.exec(path)?.[1] ?? Infinity);

/**
 * Opens a presentation and reads its slides' text until `chars` characters are read. Throws when it
 * can't be read or isn't one (a password-protected file is an OLE container, not a ZIP), or once the
 * parts it reads unpack to more than `unpackedBytes`.
 */
export function presentationText(bytes: Uint8Array, { chars, unpackedBytes }: { chars: number; unpackedBytes: number }): PresentationText {
  const pkg = new Package(bytes, unpackedBytes);
  const root = relationships(pkg, "");
  const mainPath = [...root.values()].find((r) => r.type === "officeDocument")?.target || "ppt/presentation.xml";
  const rels = relationships(pkg, mainPath);
  const slideRels = [...rels.entries()].filter(([, rel]) => rel.type === "slide" && rel.target);

  // The order the presentation lists its slides in (moving a slide doesn't rename its part).
  const order: string[] = [];
  const found = pkg.scan(mainPath, {
    open(name, attrs) {
      // Both `id` and `r:id` read as `id`; only the relationship's id names a part.
      if (name === "sldId" && rels.get(attrs.id ?? "")?.type === "slide") order.push(rels.get(attrs.id!)!.target);
    },
  });
  if (!found) throw new Error("Not a presentation");
  const paths = order.length ? order : slideRels.map(([, rel]) => rel.target).sort((a, b) => slideNumber(a) - slideNumber(b));

  const slides: SlideText[] = [];
  let size = 0;
  for (const path of paths) {
    if (size >= chars) break;
    const text = partText(pkg, path);
    const notesPath = [...relationships(pkg, path).values()].find((r) => r.type === "notesSlide")?.target;
    const notes = notesPath ? partText(pkg, notesPath) : "";
    slides.push({ text, notes });
    size += text.length + notes.length;
  }
  return { slides, total: paths.length, partial: slides.length < paths.length };
}

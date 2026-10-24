import { Worker } from "node:worker_threads";
import { unzipSync } from "fflate";
import { plainText } from "@/lib/content-markdown";
import { isImageFile } from "@/lib/files";
import { ImportError, type ImportErrorCode } from "@/lib/import/result";
import { serverEditor, type PageBlock } from "@/server/blocknote";
import { sanitizeBlocks } from "@/server/published-body";

/**
 * Reading a Word document (.docx) as a page body: mammoth turns the document into HTML, and the
 * editor's own HTML reader turns that into blocks, so only what the page schema knows survives
 * (no scripts, styles or unknown elements). Links keep only http(s) and mailto targets (the same
 * check published pages make); pictures come back as their bytes for the import to upload, and
 * the blocks showing them carry a token until then.
 *
 * The document is untrusted: its ZIP directory is checked against the limits before anything is
 * unpacked, and mammoth runs in a worker thread with a bounded heap and a time limit, so a
 * malformed or hostile file ends as an ImportError rather than taking the server with it.
 * Mammoth reads only the document's own parts: external files and the style map a document can
 * carry are switched off.
 */

const MB = 1024 * 1024;

export const DOCX_LIMITS = {
  /** One document's parts once unpacked, pictures included. */
  unpackedBytes: 100 * MB,
  /** Its XML parts (text, styles, numbering, notes): what mammoth holds as a tree. */
  xmlBytes: 30 * MB,
  /** Parts in the document's ZIP. */
  entries: 5000,
  /** Converting one document. */
  timeoutMs: 30_000,
  /** The converter's heap. */
  heapMb: 512,
  /** The HTML of one document. */
  htmlBytes: 10 * MB,
  /** Blocks of one page, nested ones included. */
  blocks: 20_000,
};

/** A picture of the document: what the block showing it points at until it is uploaded. */
export type DocxImage = { token: string; contentType: string; data: Uint8Array };

/**
 * How an image block's token starts. A same-origin path, so the link and media check (which runs
 * before the pictures are uploaded) lets it through; placeImages swaps it for the upload's URL.
 */
export const IMAGE_TOKEN = "/leafdesk-docx-image/";

/**
 * Mammoth's rules on top of its defaults (ours come first and win): underline kept, headings past
 * the third read as the third, the Title style as a first-level heading (which then names the
 * page, see docxBlocks), quotes as quotes, and monospace paragraphs (tagged by the worker) as code.
 */
const STYLE_MAP = [
  "u => u",
  "p[style-name='Title'] => h1:fresh",
  ...[4, 5, 6].flatMap((n) => [
    `p.Heading${n} => h3:fresh`,
    `p[style-name='Heading ${n}'] => h3:fresh`,
    `p[style-name='heading ${n}'] => h3:fresh`,
  ]),
  "p[style-name='Quote'] => blockquote:fresh",
  "p[style-name='Intense Quote'] => blockquote:fresh",
  "p[style-name='Leafdesk Code'] => pre > code:separator('\\n')",
];

/**
 * The worker, as CommonJS source (it runs outside the app's bundle and loads mammoth from
 * node_modules). Paragraphs whose text is all in a monospace font, with no style beyond the body
 * text's, are tagged as code. Pictures are read into memory and replaced by a token; one it can't
 * read (a picture linked from outside the document) gets an empty source, which the import drops.
 */
const WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const mammoth = require("mammoth");
const { getDescendantsOfType } = mammoth.transforms;
const MONOSPACE = /^(courier|consolas|menlo|monaco|lucida console|lucida sans typewriter|andale mono|source code|fira (code|mono)|jetbrains mono|cascadia (code|mono)|dejavu sans mono|liberation mono|roboto mono|sf mono|ibm plex mono|ubuntu mono|inconsolata|noto sans mono|pt mono|droid sans mono)/i;
const PLAIN = /^(normal|body|body text|plain text|html preformatted|code)$/i;
const images = [];
const code = mammoth.transforms.paragraph((paragraph) => {
  if (paragraph.numbering || (paragraph.styleName && !PLAIN.test(paragraph.styleName))) return paragraph;
  const runs = getDescendantsOfType(paragraph, "run").filter((run) =>
    getDescendantsOfType(run, "text").some((text) => text.value.trim()),
  );
  if (!runs.length || !runs.every((run) => run.font && MONOSPACE.test(run.font))) return paragraph;
  return Object.assign(paragraph, { styleId: null, styleName: "Leafdesk Code" });
});
mammoth
  .convertToHtml(
    { buffer: Buffer.from(workerData.data.buffer, workerData.data.byteOffset, workerData.data.byteLength) },
    {
      styleMap: workerData.styleMap,
      includeEmbeddedStyleMap: false,
      externalFileAccess: false,
      transformDocument: code,
      convertImage: mammoth.images.imgElement(async (image) => {
        let bytes;
        try {
          bytes = await image.readAsBuffer();
        } catch {
          return { src: "" };
        }
        const token = workerData.token + images.length;
        images.push({ token, contentType: String(image.contentType || ""), data: new Uint8Array(bytes) });
        return { src: token };
      }),
    },
  )
  .then(
    (result) => parentPort.postMessage({ html: result.value, images }, images.map((i) => i.data.buffer)),
    () => parentPort.postMessage({ error: "unreadable" }),
  );
`;

const isXml = (name: string) => /\.(xml|rels)$/i.test(name);

/**
 * Checks the document's ZIP directory against the limits without unpacking anything (each entry
 * counts as the larger of its two sizes, as in archive.ts). Throws for a file that isn't a ZIP
 * (an old binary .doc, say) or isn't an Office package; mammoth refuses a package without a Word
 * document in it.
 */
export function checkDocx(name: string, data: Uint8Array) {
  let entries = 0;
  let bytes = 0;
  let xml = 0;
  let document = false;
  try {
    unzipSync(data, {
      filter: (entry) => {
        const size = Math.max(entry.size, entry.originalSize);
        entries++;
        bytes += size;
        if (isXml(entry.name)) xml += size;
        if (entry.name === "[Content_Types].xml") document = true;
        return false;
      },
    });
  } catch {
    throw new ImportError(`“${name}” can't be read as a Word document`, "badDocx", { name });
  }
  if (!document) throw new ImportError(`“${name}” can't be read as a Word document`, "badDocx", { name });
  if (entries > DOCX_LIMITS.entries || bytes > DOCX_LIMITS.unpackedBytes || xml > DOCX_LIMITS.xmlBytes) {
    throw new ImportError(`“${name}” is too large to import as one page`, "docxTooComplex", { name });
  }
}

/** Runs mammoth on the document in a worker; its HTML and pictures. */
export async function docxToHtml(name: string, data: Uint8Array): Promise<{ html: string; images: DocxImage[] }> {
  checkDocx(name, data);
  const unreadable = () => new ImportError(`“${name}” can't be read as a Word document`, "badDocx", { name });
  const tooComplex = () => new ImportError(`“${name}” is too large to import as one page`, "docxTooComplex", { name });
  const result = await new Promise<{ html?: string; images?: DocxImage[]; error?: string }>((resolve, reject) => {
    const worker = new Worker(WORKER, {
      eval: true,
      workerData: { data, styleMap: STYLE_MAP, token: IMAGE_TOKEN },
      resourceLimits: { maxOldGenerationSizeMb: DOCX_LIMITS.heapMb },
      stdout: true,
      stderr: true,
    });
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      void worker.terminate();
    };
    const timer = setTimeout(() => settle(() => reject(tooComplex())), DOCX_LIMITS.timeoutMs);
    worker.on("message", (message) => settle(() => resolve(message)));
    worker.on("error", (error: Error & { code?: string }) =>
      settle(() => reject(error.code === "ERR_WORKER_OUT_OF_MEMORY" ? tooComplex() : unreadable())),
    );
    worker.on("exit", () => settle(() => reject(unreadable())));
  });
  if (result.error || typeof result.html !== "string") throw unreadable();
  if (Buffer.byteLength(result.html) > DOCX_LIMITS.htmlBytes) throw tooComplex();
  return { html: result.html, images: result.images ?? [] };
}

/** The links mammoth adds from each footnote back to where it is referenced: nowhere to go on a page. */
const BACK_LINK = /\s*<a href="#(?:footnote|endnote)-ref-[^"]*">↑<\/a>/g;
/** A footnote's or endnote's note, in the list mammoth writes at the end of the document. */
const NOTE_ITEM = /<li id="((?:footnote|endnote)-[^"]*)">([\s\S]*?)<\/li>/g;
/** Where the text refers to a note: its number, linking to the note. */
const NOTE_REFERENCE = /<sup><a href="#((?:footnote|endnote)-[^"]*)" id="(?:footnote|endnote)-ref-[^"]*">[^<]*<\/a><\/sup>/g;

/**
 * Word's footnotes and endnotes as the page's footnotes: each reference becomes a footnote holding
 * its note (in the editor's own HTML for one, see lib/content-blocks), and the list of notes at the
 * end goes. A note's text is kept as text: its formatting and links don't fit in a footnote.
 */
function notesInPlace(html: string): string {
  const notes = new Map<string, string>();
  const listed = html.replace(NOTE_ITEM, (_, id: string, inner: string) => {
    // mammoth escapes the text, so without the tags what is left is still HTML text.
    const text = inner
      .replace(BACK_LINK, "")
      .replace(/<\/p>\s*<p>/g, " ")
      .replace(/<[^>]*>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    notes.set(id, text);
    return "";
  });
  return listed
    .replace(/<ol>\s*<\/ol>/g, "")
    .replace(NOTE_REFERENCE, (reference, id: string) => {
      const note = notes.get(id);
      return note ? `<span data-inline-content-type="footnote">${note}</span>` : reference;
    })
    .replace(BACK_LINK, "");
}

const count = (blocks: PageBlock[]): number => blocks.reduce((sum, b) => sum + 1 + count(b.children ?? []), 0);

/**
 * The blocks of mammoth's HTML, and the page's title when the document starts with a first-level
 * heading (or a Title paragraph): that heading then leaves the body.
 */
export async function docxBlocks(name: string, html: string): Promise<{ title: string | null; blocks: PageBlock[] }> {
  return htmlBlocks(name, notesInPlace(html), { unreadable: "badDocx", tooComplex: "docxTooComplex" });
}

/**
 * The blocks of a document converted to HTML (a Word document, a PDF's text, a note), checked as
 * a published page's are and against DOCX_LIMITS.blocks, and its title from a first-level heading
 * at the very top (see docxBlocks) unless `title` is false (the document has a title of its own).
 * `codes`: the errors for HTML that can't be read and for too many blocks.
 */
export async function htmlBlocks(
  name: string,
  html: string,
  codes: { unreadable: ImportErrorCode; tooComplex: ImportErrorCode },
  { title: takeTitle = true }: { title?: boolean } = {},
): Promise<{ title: string | null; blocks: PageBlock[] }> {
  let parsed: PageBlock[];
  try {
    parsed = (await serverEditor.tryParseHTMLToBlocks(html)) as PageBlock[];
  } catch {
    throw new ImportError(`“${name}” can't be read`, codes.unreadable, { name });
  }
  const blocks = sanitizeBlocks(parsed);
  if (count(blocks) > DOCX_LIMITS.blocks) {
    throw new ImportError(`“${name}” is too large to import as one page`, codes.tooComplex, { name });
  }
  const first = blocks[0];
  if (takeTitle && first?.type === "heading" && (first.props as { level?: number }).level === 1) {
    const title = plainText(first.content).replace(/\s+/g, " ").trim().slice(0, 200);
    if (title) return { title, blocks: [...(first.children ?? []), ...blocks.slice(1)] };
  }
  return { title: null, blocks };
}

/** The sources of the image blocks, in the order the page shows them. */
export function imageSources(blocks: PageBlock[]): string[] {
  return blocks.flatMap((block) => [
    ...(block.type === "image" ? [String((block.props as { url?: unknown }).url ?? "")] : []),
    ...imageSources(block.children ?? []),
  ]);
}

/**
 * Points the image blocks at their uploads (`urls` by token) and drops those whose picture has no
 * upload: one linked from outside the document, of a type pages don't show, or that couldn't be
 * stored. Leafdesk never loads a picture from elsewhere, so no other source is kept.
 */
export function placeImages(blocks: PageBlock[], urls: Map<string, string>): PageBlock[] {
  return blocks.flatMap((block): PageBlock[] => {
    const children = block.children?.length ? placeImages(block.children, urls) : block.children;
    if (block.type !== "image") return [{ ...block, children } as PageBlock];
    const url = urls.get(String((block.props as { url?: unknown }).url ?? ""));
    // A picture's block has no children of its own in a converted document; keep any it has.
    if (!url) return children ?? [];
    return [{ ...block, props: { ...block.props, url }, children } as PageBlock];
  });
}

/** Whether pages can show a picture of this type (raster images, see lib/files). */
export const isPageImage = (contentType: string) => isImageFile(contentType.toLowerCase());

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
  "image/x-emf": "emf",
  "image/x-wmf": "wmf",
  "image/tiff": "tiff",
  "image/svg+xml": "svg",
};

/** A file name for the `index`th picture (from 1): mammoth doesn't give the picture's own. */
export function imageName(index: number, contentType: string): string {
  const ext = EXTENSIONS[contentType.toLowerCase()];
  return ext ? `image-${index}.${ext}` : `image-${index}`;
}

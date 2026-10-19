/**
 * A Word document (.docx) as HTML for the file viewer (components/file-viewer), read the way the
 * DOCX import reads it (server/import/docx-convert): mammoth in a worker with a bounded heap and a
 * time limit, its HTML through the editor's own reader, so only what the page schema knows
 * survives, then written back out as published pages write a body. No scripts, styles, frames or
 * unknown elements come through, links keep only http(s) and mailto targets, and the document's
 * own pictures (raster ones, within PICTURE_LIMITS) come along as data: URIs, so showing it loads
 * nothing from anywhere.
 *
 * A stored file's bytes never change, so a preview is kept in memory for a while (by file id;
 * access is checked before every use), and only a few documents are read at once.
 */
import { type DocxImage } from "@/server/import/docx-convert";
import { isImageFile } from "@/lib/files";
import { ImportError } from "@/lib/import/result";

const MB = 1024 * 1024;

export const DOCX_PREVIEW_LIMITS = {
  /** Larger documents aren't read (as search's limit, file-text.ts). */
  bytes: 25 * MB,
  /** One picture shown in the preview. */
  pictureBytes: 3 * MB,
  /** All pictures of one preview together; the rest are left out. */
  picturesBytes: 12 * MB,
  /** Documents read at the same time; more wait their turn, up to `queue`. */
  concurrent: 2,
  queue: 8,
  /** Previews kept in memory. */
  cached: 12,
};

export type DocxPreview = { html: string; title: string | null; picturesLeftOut: boolean };
export type DocxPreviewError = "tooLarge" | "unreadable" | "busy" | "missing";

export class DocxPreviewFailure extends Error {
  constructor(readonly code: DocxPreviewError) {
    super(`DOCX preview failed (${code})`);
    this.name = "DocxPreviewFailure";
  }
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The pictures to show, as data: URIs by their token, and whether any were left out: only types
 * pages show (raster images, never SVG), each and all together within the limits.
 */
export function pictureSources(images: DocxImage[], limits = DOCX_PREVIEW_LIMITS): { urls: Map<string, string>; leftOut: boolean } {
  const urls = new Map<string, string>();
  let total = 0;
  let leftOut = false;
  for (const image of images) {
    const type = image.contentType.toLowerCase();
    const size = image.data.byteLength;
    if (!isImageFile(type) || size > limits.pictureBytes || total + size > limits.picturesBytes) {
      leftOut = true;
      continue;
    }
    total += size;
    urls.set(image.token, `data:${type};base64,${Buffer.from(image.data.buffer, image.data.byteOffset, size).toString("base64")}`);
  }
  return { urls, leftOut };
}

/** Converts a document's bytes (see the top of this module). Throws DocxPreviewFailure. */
export async function docxPreviewHtml(name: string, bytes: Uint8Array): Promise<DocxPreview> {
  const [{ docxToHtml, docxBlocks, placeImages }, { serverEditor }] = await Promise.all([
    import("@/server/import/docx-convert"),
    import("@/server/blocknote"),
  ]);
  try {
    const { html: converted, images } = await docxToHtml(name, bytes);
    const { title, blocks } = await docxBlocks(name, converted);
    const { urls, leftOut } = pictureSources(images);
    // Pictures go in after the blocks were cleaned (which keeps only same-origin and web sources).
    const placed = placeImages(blocks, urls);
    const body = await serverEditor.blocksToHTMLLossy(placed);
    return { html: (title ? `<h1>${escapeHtml(title)}</h1>` : "") + body, title, picturesLeftOut: leftOut };
  } catch (error) {
    if (error instanceof ImportError) throw new DocxPreviewFailure(error.code === "docxTooComplex" ? "tooLarge" : "unreadable");
    throw error;
  }
}

const cache = new Map<string, DocxPreview>();
let running = 0;
const waiting: (() => void)[] = [];

/** Runs `task` when one of the DOCX_PREVIEW_LIMITS.concurrent places is free; "busy" when too many wait. */
async function inTurn<T>(task: () => Promise<T>): Promise<T> {
  if (running >= DOCX_PREVIEW_LIMITS.concurrent) {
    if (waiting.length >= DOCX_PREVIEW_LIMITS.queue) throw new DocxPreviewFailure("busy");
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  running++;
  try {
    return await task();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

/**
 * The preview of a stored Word document the caller has already checked access to. Throws
 * DocxPreviewFailure: too large, unreadable, the server busy, or the bytes missing from storage.
 */
export async function docxPreview(found: {
  id: string;
  name: string;
  size: number;
  storageKey: string;
  storageId: string | null;
  storageObjectId: string | null;
}): Promise<DocxPreview> {
  const kept = cache.get(found.id);
  if (kept) {
    // Most recently used last.
    cache.delete(found.id);
    cache.set(found.id, kept);
    return kept;
  }
  if (found.size > DOCX_PREVIEW_LIMITS.bytes) throw new DocxPreviewFailure("tooLarge");
  const preview = await inTurn(async () => {
    const { readStored } = await import("@/server/files");
    const bytes = await readStored(found);
    if (!bytes) throw new DocxPreviewFailure("missing");
    return docxPreviewHtml(found.name, bytes);
  });
  cache.set(found.id, preview);
  while (cache.size > DOCX_PREVIEW_LIMITS.cached) cache.delete(cache.keys().next().value as string);
  return preview;
}

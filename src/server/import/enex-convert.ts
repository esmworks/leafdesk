import { createHash } from "node:crypto";
import { enmlToHtml, MEDIA_TOKEN, type EnexNote, type EnexResource } from "@/lib/import/enex";
import { ImportError, type WarningList } from "@/lib/import/result";
import type { PageBlock } from "@/server/blocknote";
import { htmlBlocks, imageName, isPageImage } from "./docx-convert";

/**
 * A note of an Evernote export as page blocks (lib/import/enex writes its ENML as HTML, the
 * editor's HTML reader makes the blocks, checked as a Word document's are), and its attachments
 * as files to upload. Until they are uploaded, the blocks that show attachments are images whose
 * source is MEDIA_TOKEN and the attachment's hash; placeMedia points them at the uploads.
 */

/**
 * The blocks of a note's content, or null (with a warning) when it can't be read: malformed ENML,
 * or more blocks than one page takes. Encrypted text and pictures linked from outside the note are
 * reported. `path` names the note in the warnings; `encrypted` is the line standing for encrypted text.
 */
export async function noteBlocks(path: string, note: EnexNote, encrypted: string, warnings: WarningList): Promise<PageBlock[] | null> {
  let html: string;
  try {
    const converted = enmlToHtml(note.content, { encrypted });
    html = converted.html;
    if (converted.report.encrypted) warnings.add({ code: "encryptedText", page: path });
    for (const src of converted.report.external) {
      warnings.add({ code: "fileNotStored", path: `${path}/${src.slice(src.lastIndexOf("/") + 1) || src}`, reason: "external" });
    }
  } catch {
    warnings.add({ code: "skipped", path, reason: "badNote" });
    return null;
  }
  if (!html) return [];
  try {
    return (await htmlBlocks(path, html, { unreadable: "badEnex", tooComplex: "docxTooComplex" }, { title: false })).blocks;
  } catch (error) {
    if (!(error instanceof ImportError)) throw error;
    warnings.add({ code: "skipped", path, reason: error.code === "docxTooComplex" ? "tooLarge" : "badNote" });
    return null;
  }
}

/** The attachment a block stands for (its hash), as the HTML reader made it: an image with a token for its source. */
const mediaHash = (block: PageBlock) => {
  if (block.type !== "image") return null;
  const url = String((block.props as { url?: unknown }).url ?? "");
  return url.startsWith(MEDIA_TOKEN) ? url.slice(MEDIA_TOKEN.length) : null;
};

/** The hashes of the attachments the blocks show, in order. */
export function mediaHashes(blocks: PageBlock[]): string[] {
  return blocks.flatMap((block) => {
    const hash = mediaHash(block);
    return [...(hash ? [hash] : []), ...mediaHashes(block.children ?? [])];
  });
}

/** An uploaded attachment: shown as an image when pages can show it as one, else as a file. */
export type Placed = { type: "image" | "file"; url: string; name: string };

export const placedBlock = (placed: Placed): PageBlock =>
  ({ type: placed.type, props: { url: placed.url, name: placed.name }, children: [] }) as unknown as PageBlock;

/** Points the attachments' blocks at their uploads, and drops those that have none (never uploaded, or not in the note). */
export function placeMedia(blocks: PageBlock[], placed: Map<string, Placed>): PageBlock[] {
  return blocks.flatMap((block): PageBlock[] => {
    const children = block.children?.length ? placeMedia(block.children, placed) : block.children;
    const hash = mediaHash(block);
    if (hash === null) return [{ ...block, children } as PageBlock];
    const upload = placed.get(hash);
    if (!upload) return children ?? [];
    if (upload.type === "file") return [placedBlock(upload), ...(children ?? [])];
    return [{ ...block, props: { ...block.props, url: upload.url, name: upload.name }, children } as PageBlock];
  });
}

const EXTENSIONS: Record<string, string> = {
  "application/pdf": "pdf",
  "application/zip": "zip",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/wav": "wav",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "text/plain": "txt",
};

/** An attachment's file name: its own, else one by its place among the note's attachments and its type. No slashes. */
export function resourceName(resource: EnexResource, index: number): string {
  const own = resource.fileName?.replace(/[/\\]/g, "_").trim();
  if (own) return own.slice(0, 200);
  if (isPageImage(resource.mime)) return imageName(index, resource.mime);
  const ext = EXTENSIONS[resource.mime];
  return ext ? `attachment-${index}.${ext}` : `attachment-${index}`;
}

/**
 * A note's attachments by the MD5 hash of their bytes (how its content points at them), with their
 * bytes, file names and types. Empty ones are passed over, and one that is there twice counts once.
 */
export function resourceFiles(note: EnexNote): Map<string, { name: string; mime: string; data: Uint8Array }> {
  const files = new Map<string, { name: string; mime: string; data: Uint8Array }>();
  note.resources.forEach((resource, i) => {
    const data = new Uint8Array(Buffer.from(resource.data.replace(/\s+/g, ""), "base64"));
    if (!data.byteLength) return;
    const hash = createHash("md5").update(data).digest("hex");
    if (!files.has(hash)) files.set(hash, { name: resourceName(resource, i + 1), mime: resource.mime, data });
  });
  return files;
}

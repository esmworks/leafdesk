/**
 * The text of PDFs and Word documents attached to pages, for semantic search: each file block of a
 * page that shows such a document adds its text to the page's index (semantic-text.chunkPage), so
 * the AI chat can answer from inside the document and cite the block showing it.
 *
 * A document is read once: its text is kept in `file_text` (a stored file's bytes never change),
 * and the same bytes uploaded again as another file are found by their hash and not read again.
 * Only the start of a long document is read (FILE_TEXT_LIMITS), and the row says so. A document
 * with no text to give (a scan, a damaged or password-protected file) adds nothing, silently.
 *
 * Access: a page indexes only files its readers may read through it, the ones uploaded to it and
 * the ones its body shows with an authorized reference (see files.ts); a file whose URL someone
 * merely wrote into the page stays out. Search checks the reader's access to the page when it runs,
 * as for the rest of the page's text.
 */
import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { file, fileReference, fileText } from "@/db/schema";
import { blocksToPlainText, type BlockLike } from "@/lib/blocks";
import { fileIdOf } from "@/lib/files";
import type { FileSource } from "@/server/semantic-text";

const MB = 1024 * 1024;

export const FILE_TEXT_LIMITS = {
  /** Larger files aren't read (as get_file's PDF limit). */
  bytes: 25 * MB,
  /** Pages of a PDF read. */
  pages: 50,
  /** Characters of text kept per document. */
  chars: 200_000,
  /** Documents indexed per page, in the order the page shows them. */
  filesPerPage: 20,
};

/** Raise it when what is read out of a document changes (limits included): rows of an older version are read again. */
export const EXTRACTOR_VERSION = 1;

export type DocumentKind = "pdf" | "docx";

const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** Which kind of document a stored file is, by the type the server recorded for it; null for anything else. */
export function documentKind(contentType: string, name: string): DocumentKind | null {
  const type = contentType.split(";")[0].trim().toLowerCase();
  if (type === "application/pdf") return "pdf";
  if (type === DOCX_TYPE) return "docx";
  // Some browsers send a Word document as a generic ZIP or bytes; its name says what it is.
  if ((type === "application/octet-stream" || type === "application/zip") && /\.docx$/i.test(name.trim())) return "docx";
  return null;
}

export type ExtractedText = { text: string; pages: number | null; partial: boolean };

/**
 * Joins the pages (or one part) of a document into one text of at most `chars` characters, spaces
 * collapsed and at most one blank line in a row; `partial` when text was left out, including pages
 * past those given (`totalPages`).
 */
export function joinText(parts: string[], { chars = FILE_TEXT_LIMITS.chars, totalPages }: { chars?: number; totalPages?: number } = {}) {
  let text = parts
    .join("\n\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  let partial = totalPages !== undefined && totalPages > parts.length;
  if (text.length > chars) {
    const cut = text.lastIndexOf(" ", chars);
    text = text.slice(0, cut > chars / 2 ? cut : chars).trimEnd();
    partial = true;
  }
  return { text, partial };
}

/** The text of a PDF's first pages; throws when the PDF can't be read. Stops early once there's text enough. */
async function pdfText(bytes: Uint8Array): Promise<ExtractedText> {
  // A missing module is a server problem: it throws outside the caller's catch-all too.
  const { getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  try {
    const pages: string[] = [];
    let size = 0;
    for (let n = 1; n <= Math.min(pdf.numPages, FILE_TEXT_LIMITS.pages) && size <= FILE_TEXT_LIMITS.chars; n++) {
      const content = await (await pdf.getPage(n)).getTextContent();
      const text = content.items.map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : "")).join("");
      pages.push(text);
      size += text.length;
    }
    return { ...joinText(pages, { totalPages: pdf.numPages }), pages: pdf.numPages };
  } finally {
    await pdf.loadingTask.destroy();
  }
}

/** The text of a Word document, read as the DOCX import reads it (mammoth in a bounded worker); throws when it can't be read. */
async function docxText(name: string, bytes: Uint8Array): Promise<ExtractedText> {
  const { docxBlocks, docxToHtml } = await import("@/server/import/docx-convert");
  const { html } = await docxToHtml(name, bytes);
  const { title, blocks } = await docxBlocks(name, html);
  return { ...joinText([title ?? "", blocksToPlainText(blocks as BlockLike[])].filter(Boolean)), pages: null };
}

/** A document's text, or null when it can't be read at all. */
export async function extractText(kind: DocumentKind, name: string, bytes: Uint8Array): Promise<ExtractedText | null> {
  try {
    return kind === "pdf" ? await pdfText(bytes) : await docxText(name, bytes);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------- cache

export type FileTextRow = typeof fileText.$inferSelect;
export type StoredDocument = { id: string; name: string; contentType: string; size: number; storageKey: string };

/** Where the cache reads and writes, and how a document is read (replaced in tests). */
export type FileTextStore = {
  byFile(fileId: string): Promise<FileTextRow | null>;
  /** A row of the current EXTRACTOR_VERSION for these bytes, under any file. */
  byHash(contentHash: string): Promise<FileTextRow | null>;
  save(row: Omit<FileTextRow, "extractedAt">): Promise<void>;
  /** The file's bytes; null when the storage has nothing under its key. */
  read(found: StoredDocument): Promise<Uint8Array | null>;
  extract(kind: DocumentKind, name: string, bytes: Uint8Array): Promise<ExtractedText | null>;
};

const dbStore: FileTextStore = {
  async byFile(fileId) {
    const [row] = await db.select().from(fileText).where(eq(fileText.fileId, fileId)).limit(1);
    return row ?? null;
  },
  async byHash(contentHash) {
    const [row] = await db
      .select()
      .from(fileText)
      .where(and(eq(fileText.contentHash, contentHash), eq(fileText.extractorVersion, EXTRACTOR_VERSION)))
      .limit(1);
    return row ?? null;
  },
  async save(row) {
    const values = { ...row, extractedAt: new Date() };
    // Deleted meanwhile: nothing to keep.
    await db
      .insert(fileText)
      .values(values)
      .onConflictDoUpdate({ target: fileText.fileId, set: values })
      .catch((error: { code?: string }) => {
        if (error.code !== "23503") throw error;
      });
  },
  async read(found) {
    const { readStored } = await import("@/server/files");
    return readStored(found as Parameters<typeof readStored>[0]);
  },
  extract: extractText,
};

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/**
 * The text of a stored PDF or Word document, read once and kept (see the top of this module); null
 * when it isn't such a document, is too large, has no text or can't be read.
 */
export async function documentText(found: StoredDocument, store: FileTextStore = dbStore): Promise<{ text: string; partial: boolean } | null> {
  const kind = documentKind(found.contentType, found.name);
  if (!kind || found.size > FILE_TEXT_LIMITS.bytes) return null;
  const result = (row: Pick<FileTextRow, "text" | "partial">) => (row.text ? { text: row.text, partial: row.partial } : null);

  const known = await store.byFile(found.id);
  if (known?.extractorVersion === EXTRACTOR_VERSION) return result(known);
  // Not there (moved, or a storage hiccup): nothing is kept, so it's tried again next time.
  const bytes = await store.read(found);
  if (!bytes) return null;
  const contentHash = sha256(bytes);
  const same = await store.byHash(contentHash);
  if (same) {
    await store.save({ ...same, fileId: found.id });
    return result(same);
  }
  const extracted = await store.extract(kind, found.name, bytes);
  const row = {
    fileId: found.id,
    contentHash,
    extractorVersion: EXTRACTOR_VERSION,
    text: extracted?.text ?? "",
    pages: extracted?.pages ?? null,
    partial: extracted?.partial ?? false,
    failed: !extracted,
  };
  await store.save(row);
  return result(row);
}

// ------------------------------------------------------------------------------ page files

type BlockWithId = BlockLike & { id?: string; children?: BlockWithId[] };

/** The file blocks of a body that show an uploaded file, in document order: their id, file id and name. */
export function fileBlocks(blocks: BlockWithId[]): { blockId: string; fileId: string; name: string }[] {
  const out: { blockId: string; fileId: string; name: string }[] = [];
  const walk = (list: BlockWithId[]) => {
    for (const block of list) {
      const fileId = block.type === "file" ? fileIdOf(block.props?.url) : null;
      if (fileId && block.id) out.push({ blockId: block.id, fileId, name: typeof block.props?.name === "string" ? block.props.name : "" });
      if (block.children?.length) walk(block.children);
    }
  };
  walk(blocks);
  return out;
}

/**
 * The text of the documents a page's body shows that its readers may read through it (uploaded to
 * the page, or shown with an authorized reference), each with the first block showing it.
 */
export async function pageDocuments(page: { id: string; workspaceId: string }, blocks: BlockWithId[], store?: FileTextStore): Promise<FileSource[]> {
  const shown = fileBlocks(blocks);
  if (!shown.length) return [];
  const ids = [...new Set(shown.map((b) => b.fileId))];
  const [rows, refs] = await Promise.all([
    db
      .select()
      .from(file)
      .where(and(eq(file.workspaceId, page.workspaceId), inArray(file.id, ids))),
    db
      .select({ fileId: fileReference.fileId })
      .from(fileReference)
      .where(and(eq(fileReference.pageId, page.id), eq(fileReference.authorized, true), inArray(fileReference.fileId, ids))),
  ]);
  const authorized = new Set(refs.map((r) => r.fileId));
  const readable = new Map(rows.filter((f) => f.pageId === page.id || authorized.has(f.id)).map((f) => [f.id, f]));

  const out: FileSource[] = [];
  const done = new Set<string>();
  for (const block of shown) {
    const found = readable.get(block.fileId);
    if (!found || done.has(found.id) || !documentKind(found.contentType, found.name)) continue;
    done.add(found.id);
    if (done.size > FILE_TEXT_LIMITS.filesPerPage) break;
    // A file that can't be fetched now leaves the rest of the page indexed.
    const text = await documentText(found, store).catch((error) => {
      console.error("[semantic] reading an attached document failed", error);
      return null;
    });
    if (text) out.push({ blockId: block.blockId, name: block.name.trim() || found.name, text: text.text });
  }
  return out;
}

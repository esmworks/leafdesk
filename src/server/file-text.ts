/**
 * The text of PDFs, Word documents and Excel workbooks attached to pages, for search. Full-text search finds a page
 * by the words of the documents its body shows (file_text.search_vector, see pages.fullTextSearch).
 * For semantic search, each file block of a page that shows such a document adds its text to the
 * page's index (semantic-text.chunkPage), so the AI chat can answer from inside the document and
 * cite the block showing it.
 *
 * Documents are read in the background after they are uploaded, and those uploaded earlier by a
 * sweep its searches start (queueDocument, sweepDocuments); semantic indexing reads the ones it
 * needs too.
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
import { and, desc, eq, exists, getTableColumns, ilike, inArray, isNull, lte, or, sql } from "drizzle-orm";
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

export type DocumentKind = "pdf" | "docx" | "xlsx";

const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Which kind of document a stored file is, by the type the server recorded for it; null for anything else. */
export function documentKind(contentType: string, name: string): DocumentKind | null {
  const type = contentType.split(";")[0].trim().toLowerCase();
  if (type === "application/pdf") return "pdf";
  if (type === DOCX_TYPE) return "docx";
  if (type === XLSX_TYPE) return "xlsx";
  // Some browsers send an Office document as a generic ZIP or bytes; its name says what it is.
  if (type === "application/octet-stream" || type === "application/zip") {
    if (/\.docx$/i.test(name.trim())) return "docx";
    if (/\.xlsx$/i.test(name.trim())) return "xlsx";
  }
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

/**
 * The text of an Excel workbook: each worksheet's name on a line of its own, then its rows, their
 * cells between bars (an empty cell keeps its place, so columns stay apart). Reads each sheet as
 * far as the CSV import would and stops once there's text enough; throws when it can't be read.
 */
export async function workbookText(bytes: Uint8Array, { chars = FILE_TEXT_LIMITS.chars }: { chars?: number } = {}): Promise<ExtractedText> {
  const [{ readWorkbook }, { CSV_MAX_COLUMNS, CSV_MAX_ROWS }] = await Promise.all([import("@/lib/import/xlsx"), import("@/lib/import/csv")]);
  const book = readWorkbook(bytes);
  const parts: string[] = [];
  let size = 0;
  let partial = false;
  for (const [index, sheet] of book.sheets.entries()) {
    if (size > chars) {
      partial = true;
      break;
    }
    const cells = book.cells(index, { rows: CSV_MAX_ROWS + 1, columns: CSV_MAX_COLUMNS });
    partial ||= cells.partial;
    const lines = cells.rows.map((row) => {
      const used = row.cells.slice(0, row.cells.findLastIndex((cell) => cell.trim() !== "") + 1);
      return used.map((cell) => cell.replace(/\s+/g, " ").trim()).join(" | ");
    });
    const text = [sheet.name, ...lines].join("\n");
    parts.push(text);
    size += text.length;
  }
  const joined = joinText(parts, { chars });
  return { text: joined.text, partial: joined.partial || partial, pages: null };
}

/** A document's text, or null when it can't be read at all. */
export async function extractText(kind: DocumentKind, name: string, bytes: Uint8Array): Promise<ExtractedText | null> {
  try {
    return kind === "pdf" ? await pdfText(bytes) : kind === "docx" ? await docxText(name, bytes) : await workbookText(bytes);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------- cache

/** The columns of file_text but its search vector (large, and only full-text search reads it). */
const { searchVector: _searchVector, ...fileTextColumns } = getTableColumns(fileText);

export type FileTextRow = Omit<typeof fileText.$inferSelect, "searchVector">;
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
    const [row] = await db.select(fileTextColumns).from(fileText).where(eq(fileText.fileId, fileId)).limit(1);
    return row ?? null;
  },
  async byHash(contentHash) {
    const [row] = await db
      .select(fileTextColumns)
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
 * The text of a stored PDF, Word document or Excel workbook, read once and kept (see the top of this module); null
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

// ------------------------------------------------------------------------- background reading

/** How often a workspace's documents are checked for ones not read yet (per process). */
export const SWEEP_INTERVAL_MS = 10 * 60_000;
/** Documents one sweep queues at most; the next sweep goes on from there. */
const SWEEP_BATCH = 200;

type ReadQueue = {
  waiting: { found: StoredDocument; store?: FileTextStore }[];
  /** Waiting or being read. */
  queued: Set<string>;
  running: boolean;
  sweptAt: Map<string, number>;
  /** Where each workspace's sweep goes on: the last document it queued (newest first). */
  cursor: Map<string, { createdAt: Date; id: string }>;
  idle: (() => void)[];
};

const QUEUE_KEY = "__leafdeskFileText";
const readQueue = ((globalThis as Record<string, unknown>)[QUEUE_KEY] ??= {
  waiting: [],
  queued: new Set(),
  running: false,
  sweptAt: new Map(),
  cursor: new Map(),
  idle: [],
} satisfies ReadQueue) as ReadQueue;

/**
 * Reads a PDF, Word document or Excel workbook in the background (documentText), so full-text search finds its
 * words whether or not semantic search runs: called once a document is uploaded (files.storeFile)
 * and by sweepDocuments. Anything else, a document too large to read, or one already queued, is
 * left alone. One document at a time per process, since a PDF is parsed in the server's own
 * process; nothing waits for it.
 */
export function queueDocument(found: StoredDocument, store?: FileTextStore) {
  if (!documentKind(found.contentType, found.name) || found.size > FILE_TEXT_LIMITS.bytes) return;
  if (readQueue.queued.has(found.id)) return;
  readQueue.queued.add(found.id);
  readQueue.waiting.push({ found, store });
  void drainDocuments();
}

async function drainDocuments() {
  if (readQueue.running) return;
  readQueue.running = true;
  try {
    while (readQueue.waiting.length) {
      const { found, store } = readQueue.waiting.shift()!;
      await documentText(found, store).catch((error) => console.error("[file-text] reading a document failed", error));
      readQueue.queued.delete(found.id);
    }
  } finally {
    readQueue.running = false;
    for (const resolve of readQueue.idle.splice(0)) resolve();
  }
}

/** Settles when no document is waiting or being read. For scripts and tests. */
export function whenDocumentsRead(): Promise<void> {
  if (!readQueue.running && !readQueue.waiting.length) return Promise.resolve();
  return new Promise((resolve) => readQueue.idle.push(resolve));
}

/**
 * Queues the documents of a workspace that some page shows and that weren't read yet, or were read
 * by an older EXTRACTOR_VERSION: uploaded before full-text search read documents, or while the
 * server was down. Started by the workspace's searches, at most every SWEEP_INTERVAL_MS and not
 * while documents are still waiting; each sweep takes up to SWEEP_BATCH, newest first, and the
 * next goes on after them, so documents that can't be read (missing from the storage) don't hold
 * the others up. Returns how many it queued.
 */
export async function sweepDocuments(workspaceId: string, { force = false }: { force?: boolean } = {}): Promise<number> {
  const now = Date.now();
  if (!force && (readQueue.waiting.length || now - (readQueue.sweptAt.get(workspaceId) ?? 0) < SWEEP_INTERVAL_MS)) return 0;
  readQueue.sweptAt.set(workspaceId, now);
  const after = readQueue.cursor.get(workspaceId);
  const type = sql`lower(trim(split_part(${file.contentType}, ';', 1)))`;
  const rows = await db
    .select({ id: file.id, name: file.name, contentType: file.contentType, size: file.size, storageKey: file.storageKey, createdAt: file.createdAt })
    .from(file)
    .leftJoin(fileText, and(eq(fileText.fileId, file.id), eq(fileText.extractorVersion, EXTRACTOR_VERSION)))
    .where(
      and(
        eq(file.workspaceId, workspaceId),
        isNull(fileText.fileId),
        lte(file.size, FILE_TEXT_LIMITS.bytes),
        or(
          sql`${type} in ('application/pdf', ${DOCX_TYPE}, ${XLSX_TYPE})`,
          and(sql`${type} in ('application/octet-stream', 'application/zip')`, or(ilike(file.name, "%.docx"), ilike(file.name, "%.xlsx"))),
        ),
        exists(db.select({ one: sql`1` }).from(fileReference).where(eq(fileReference.fileId, file.id))),
        after ? sql`(${file.createdAt}, ${file.id}) < (${after.createdAt}, ${after.id})` : undefined,
      ),
    )
    .orderBy(desc(file.createdAt), desc(file.id))
    .limit(SWEEP_BATCH);
  // A short batch reached the oldest document: the next sweep starts from the newest again.
  if (rows.length < SWEEP_BATCH) readQueue.cursor.delete(workspaceId);
  else readQueue.cursor.set(workspaceId, rows[rows.length - 1]);
  for (const { createdAt: _createdAt, ...found } of rows) queueDocument(found);
  return rows.length;
}

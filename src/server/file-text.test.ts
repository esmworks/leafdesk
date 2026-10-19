import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toXlsx } from "@/lib/xlsx";
import { docx, paragraph } from "./import/docx-fixtures";
import {
  documentKind,
  documentText,
  EXTRACTOR_VERSION,
  extractText,
  FILE_TEXT_LIMITS,
  fileBlocks,
  joinText,
  pageDocuments,
  workbookText,
  type FileTextRow,
  type FileTextStore,
} from "./file-text";

// pageDocuments reads the page's files and references; each query answers from these lists.
const tables = vi.hoisted(() => ({ files: [] as Record<string, unknown>[], refs: [] as Record<string, unknown>[] }));
vi.mock("@/db", async () => {
  const schema = await import("@/db/schema");
  return {
    db: {
      select: () => ({
        from: (table: unknown) => ({
          where: async () => (table === schema.file ? tables.files : table === schema.fileReference ? tables.refs : []),
        }),
      }),
    },
  };
});

/** A PDF whose pages' text layers say `pages` (xref offsets computed, so pdf.js reads it cleanly). */
function pdf(pages: string[]): Uint8Array {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const kids: string[] = [];
  for (const text of pages) {
    const stream = text ? `BT /F1 12 Tf 72 720 Td (${text}) Tj ET` : "";
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    const contents = objects.length;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contents} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`);
    kids.push(`${objects.length} 0 R`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}

describe("which files are documents", () => {
  it("goes by the stored type, and by the name only for generic types", () => {
    expect(documentKind("application/pdf", "x.bin")).toBe("pdf");
    expect(documentKind("Application/PDF; charset=binary", "x")).toBe("pdf");
    expect(documentKind("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "x")).toBe("docx");
    expect(documentKind("application/octet-stream", "Notes.DOCX")).toBe("docx");
    expect(documentKind("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "x")).toBe("xlsx");
    expect(documentKind("application/zip", "Teklif.XLSX")).toBe("xlsx");
    expect(documentKind("application/vnd.ms-excel", "old.xls")).toBeNull();
    expect(documentKind("image/png", "fake.pdf")).toBeNull();
    expect(documentKind("text/plain", "a.docx")).toBeNull();
  });
});

describe("joining a document's text", () => {
  it("collapses spaces and blank lines, and says when pages were left out", () => {
    expect(joinText(["a  b \n\n\n\nc", " d "])).toEqual({ text: "a b\n\nc\n\nd", partial: false });
    expect(joinText(["one"], { totalPages: 3 })).toEqual({ text: "one", partial: true });
  });

  it("cuts at the character limit, at a space", () => {
    const { text, partial } = joinText(["word ".repeat(100)], { chars: 52 });
    expect(partial).toBe(true);
    expect(text).toBe(Array(10).fill("word").join(" "));
  });
});

describe("reading documents", () => {
  it("reads a PDF's pages", async () => {
    const out = await extractText("pdf", "a.pdf", pdf(["Revenue grew in the north", "Costs fell"]));
    expect(out).toEqual({ text: "Revenue grew in the north\n\nCosts fell", pages: 2, partial: false });
  });

  it("reads only the first pages of a long PDF and says so", async () => {
    const pages = Array.from({ length: FILE_TEXT_LIMITS.pages + 5 }, (_, i) => `Page ${i + 1}`);
    const out = await extractText("pdf", "long.pdf", pdf(pages));
    expect(out?.partial).toBe(true);
    expect(out?.pages).toBe(FILE_TEXT_LIMITS.pages + 5);
    expect(out?.text).toContain(`Page ${FILE_TEXT_LIMITS.pages}`);
    expect(out?.text).not.toContain(`Page ${FILE_TEXT_LIMITS.pages + 1}`);
  });

  it("gives no text for a scan, and null for what can't be read", async () => {
    expect(await extractText("pdf", "scan.pdf", pdf(["", ""]))).toEqual({ text: "", pages: 2, partial: false });
    expect(await extractText("pdf", "broken.pdf", new TextEncoder().encode("%PDF-1.4 nothing here"))).toBeNull();
    expect(await extractText("docx", "broken.docx", new TextEncoder().encode("not a zip"))).toBeNull();
    expect(await extractText("xlsx", "broken.xlsx", new TextEncoder().encode("not a zip"))).toBeNull();
  });

  it("reads a Word document as the import does", async () => {
    const data = docx({ body: [paragraph("Quarterly review"), paragraph("Revenue grew in the north.")].join("") });
    expect(await extractText("docx", "review.docx", data)).toEqual({
      text: "Quarterly review\nRevenue grew in the north.",
      pages: null,
      partial: false,
    });
  });
});

describe("reading workbooks", () => {
  it("reads each sheet's name and rows, cells between bars", async () => {
    const data = toXlsx([
      ["Ürün", "Adet", "Fiyat", "Not"],
      ["Kompresör  K-12", 2, 1500, null],
      ["Fan", null, 240.5, "acil"],
      [{ date: "2026-10-12" }, true, null, null],
    ], { name: "Teklif" });
    expect(await extractText("xlsx", "teklif.xlsx", data)).toEqual({
      text: "Teklif\nÜrün | Adet | Fiyat | Not\nKompresör K-12 | 2 | 1500\nFan | | 240.5 | acil\n2026-10-12 | TRUE",
      pages: null,
      partial: false,
    });
  });

  it("stops once there's text enough and says so", async () => {
    const rows = Array.from({ length: 50 }, (_, i) => [`Row ${i + 1}`, "word ".repeat(10)]);
    const out = await workbookText(toXlsx(rows), { chars: 200 });
    expect(out.partial).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(200);
    expect(out.text).toContain("Row 1 |");
    expect(out.text).not.toContain("Row 50");
  });
});

describe("the document text cache", () => {
  const FILE = { id: "file-1", name: "report.pdf", contentType: "application/pdf", size: 1000, storageKey: "ws/file-1" };
  const BYTES = new TextEncoder().encode("the bytes");
  const HASH = createHash("sha256").update(BYTES).digest("hex");

  const memoryStore = (rows: FileTextRow[] = [], extracted: Awaited<ReturnType<FileTextStore["extract"]>> = { text: "Revenue grew.", pages: 1, partial: false }) => {
    const store = {
      rows,
      read: vi.fn(async () => BYTES as Uint8Array | null),
      extract: vi.fn(async () => extracted),
      byFile: async (id: string) => rows.find((r) => r.fileId === id) ?? null,
      byHash: async (hash: string) => rows.find((r) => r.contentHash === hash && r.extractorVersion === EXTRACTOR_VERSION) ?? null,
      save: vi.fn(async (row: Omit<FileTextRow, "extractedAt">) => {
        const at = rows.findIndex((r) => r.fileId === row.fileId);
        const full = { ...row, extractedAt: new Date() };
        if (at >= 0) rows[at] = full;
        else rows.push(full);
      }),
    };
    return store;
  };

  it("reads a document once, then answers from what it kept without fetching the file", async () => {
    const store = memoryStore();
    expect(await documentText(FILE, store)).toEqual({ text: "Revenue grew.", partial: false });
    expect(store.rows).toMatchObject([{ fileId: "file-1", contentHash: HASH, extractorVersion: EXTRACTOR_VERSION, failed: false }]);
    expect(await documentText(FILE, store)).toEqual({ text: "Revenue grew.", partial: false });
    expect(store.read).toHaveBeenCalledTimes(1);
    expect(store.extract).toHaveBeenCalledTimes(1);
  });

  it("doesn't read the same bytes twice under another file", async () => {
    const store = memoryStore();
    await documentText(FILE, store);
    expect(await documentText({ ...FILE, id: "file-2" }, store)).toEqual({ text: "Revenue grew.", partial: false });
    expect(store.extract).toHaveBeenCalledTimes(1);
    expect(store.rows.map((r) => r.fileId)).toEqual(["file-1", "file-2"]);
  });

  it("reads again what an older extractor read", async () => {
    const old = { fileId: "file-1", contentHash: HASH, extractorVersion: EXTRACTOR_VERSION - 1, text: "old", pages: 1, partial: false, failed: false, extractedAt: new Date() };
    const store = memoryStore([old]);
    expect(await documentText(FILE, store)).toEqual({ text: "Revenue grew.", partial: false });
    expect(store.extract).toHaveBeenCalledTimes(1);
  });

  it("keeps that a document can't be read, without trying again", async () => {
    const store = memoryStore([], null);
    expect(await documentText(FILE, store)).toBeNull();
    expect(store.rows).toMatchObject([{ text: "", failed: true }]);
    expect(await documentText(FILE, store)).toBeNull();
    expect(store.extract).toHaveBeenCalledTimes(1);
  });

  it("keeps a scan's missing text, and that a long document was read in part", async () => {
    const scan = memoryStore([], { text: "", pages: 3, partial: false });
    expect(await documentText(FILE, scan)).toBeNull();
    expect(scan.rows).toMatchObject([{ text: "", failed: false, pages: 3 }]);
    const long = memoryStore([], { text: "Start.", pages: 80, partial: true });
    expect(await documentText(FILE, long)).toEqual({ text: "Start.", partial: true });
    expect(long.rows).toMatchObject([{ partial: true, pages: 80 }]);
  });

  it("keeps nothing when the file isn't in storage, and skips other files and large ones unread", async () => {
    const store = memoryStore();
    store.read.mockResolvedValueOnce(null);
    expect(await documentText(FILE, store)).toBeNull();
    expect(store.rows).toEqual([]);
    expect(await documentText({ ...FILE, contentType: "image/png" }, store)).toBeNull();
    expect(await documentText({ ...FILE, size: FILE_TEXT_LIMITS.bytes + 1 }, store)).toBeNull();
    expect(store.read).toHaveBeenCalledTimes(1);
  });
});

describe("a page's documents", () => {
  const ID = (n: number) => `${"F".repeat(23)}${n}`;
  const fileBlock = (id: string, fileId: string, name = "") => ({ id, type: "file", props: { url: `/api/files/${fileId}`, name }, children: [] });
  const row = (n: number, over: Record<string, unknown> = {}) => ({
    id: ID(n),
    workspaceId: "ws",
    pageId: "page",
    name: `doc${n}.pdf`,
    contentType: "application/pdf",
    size: 10,
    storageKey: `ws/${ID(n)}`,
    ...over,
  });
  const store = (): FileTextStore => ({
    byFile: async () => null,
    byHash: async () => null,
    save: async () => {},
    read: async (found) => new TextEncoder().encode(found.id),
    extract: async (_kind, name) => ({ text: `Text of ${name}`, pages: 1, partial: false }),
  });

  beforeEach(() => {
    tables.files = [];
    tables.refs = [];
  });

  it("finds file blocks, nested ones too", () => {
    const blocks = [
      { id: "p", type: "paragraph", props: {}, children: [fileBlock("f2", ID(2), "Two")] },
      fileBlock("f1", ID(1)),
      { id: "i", type: "image", props: { url: `/api/files/${ID(3)}` }, children: [] },
      { id: "x", type: "file", props: { url: "https://example.com/a.pdf" }, children: [] },
    ];
    expect(fileBlocks(blocks)).toEqual([
      { blockId: "f2", fileId: ID(2), name: "Two" },
      { blockId: "f1", fileId: ID(1), name: "" },
    ]);
  });

  it("indexes only documents the page's readers may read through it, each once", async () => {
    tables.files = [
      row(1), // uploaded here
      row(2, { pageId: "elsewhere" }), // shown with an authorized reference
      row(3, { pageId: "elsewhere" }), // URL written in, never authorized
      row(4, { contentType: "image/png", name: "pic.png" }),
    ];
    tables.refs = [{ fileId: ID(2) }];
    const blocks = [fileBlock("b1", ID(1), "Shown name.pdf"), fileBlock("b2", ID(2)), fileBlock("b3", ID(3)), fileBlock("b4", ID(4)), fileBlock("b5", ID(1))];
    expect(await pageDocuments({ id: "page", workspaceId: "ws" }, blocks, store())).toEqual([
      { blockId: "b1", name: "Shown name.pdf", text: "Text of doc1.pdf" },
      { blockId: "b2", name: "doc2.pdf", text: "Text of doc2.pdf" },
    ]);
  });

  it("indexes at most FILE_TEXT_LIMITS.filesPerPage documents", async () => {
    const n = FILE_TEXT_LIMITS.filesPerPage + 3;
    tables.files = Array.from({ length: n }, (_, i) => row(i % 10, { id: `${"G".repeat(22)}${String(i).padStart(2, "0")}` }));
    const blocks = tables.files.map((f, i) => fileBlock(`b${i}`, f.id as string));
    expect(await pageDocuments({ id: "page", workspaceId: "ws" }, blocks, store())).toHaveLength(FILE_TEXT_LIMITS.filesPerPage);
  });
});

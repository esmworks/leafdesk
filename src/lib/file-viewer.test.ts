import { describe, expect, it } from "vitest";
import {
  csvPreview,
  decodeBytes,
  dispositionName,
  extensionOf,
  looksLikeHeader,
  prettyJson,
  previewText,
  probeResult,
  viewerFormat,
  wholeUtf8Length,
} from "./file-viewer";
import { dispositionOf } from "./files";

const utf8 = (text: string) => new TextEncoder().encode(text);
const OCTET = "application/octet-stream";

describe("viewerFormat", () => {
  it("shows images, SVG included, and media by their stored type", () => {
    expect(viewerFormat("photo.png", "image/png")).toEqual({ kind: "image" });
    expect(viewerFormat("drawing.svg", "image/svg+xml")).toEqual({ kind: "image" });
    expect(viewerFormat("no-extension", "image/jpeg")).toEqual({ kind: "image" });
    expect(viewerFormat("clip.mp4", "video/mp4")).toEqual({ kind: "video" });
    expect(viewerFormat("clip", "video/webm")).toEqual({ kind: "video" });
    expect(viewerFormat("song.mp3", "audio/mpeg")).toEqual({ kind: "audio" });
  });

  it("goes by the name when the type is unknown (blocks keep none)", () => {
    expect(viewerFormat("photo.JPG", "")).toEqual({ kind: "image" });
    expect(viewerFormat("drawing.svg", OCTET)).toEqual({ kind: "image" });
    expect(viewerFormat("clip.mov", null)).toEqual({ kind: "video" });
    expect(viewerFormat("voice.m4a", undefined)).toEqual({ kind: "audio" });
    expect(viewerFormat("report.pdf", "")).toEqual({ kind: "pdf" });
    expect(viewerFormat("book.xlsx", OCTET)).toEqual({ kind: "spreadsheet" });
    expect(viewerFormat("letter.docx", "application/zip")).toEqual({ kind: "docx" });
  });

  it("shows a PDF in the PDF viewer only when it is stored as one", () => {
    expect(viewerFormat("report.pdf", "application/pdf")).toEqual({ kind: "pdf" });
    expect(viewerFormat("report.pdf", "text/html")).toEqual({ kind: "code", language: "html" });
    expect(viewerFormat("report.pdf", "application/x-msdownload")).toEqual({ kind: "other" });
    expect(viewerFormat("scan", "application/pdf")).toEqual({ kind: "pdf" });
  });

  it("reads text by its name first, whatever type a browser gave it", () => {
    // Browsers label TypeScript as an MPEG transport stream.
    expect(viewerFormat("server.ts", "video/mp2t")).toEqual({ kind: "code", language: "typescript" });
    expect(viewerFormat("App.tsx", OCTET)).toEqual({ kind: "code", language: "tsx" });
    expect(viewerFormat("main.py", "text/x-python")).toEqual({ kind: "code", language: "python" });
    expect(viewerFormat("Dockerfile", "")).toEqual({ kind: "code", language: "dockerfile" });
    expect(viewerFormat("Makefile", OCTET)).toEqual({ kind: "code", language: "makefile" });
    expect(viewerFormat("config.yml", "application/x-yaml")).toEqual({ kind: "code", language: "yaml" });
    expect(viewerFormat("data.json", "application/json")).toEqual({ kind: "json" });
    expect(viewerFormat("map.geojson", OCTET)).toEqual({ kind: "json" });
    expect(viewerFormat("README.md", "text/markdown")).toEqual({ kind: "markdown" });
    expect(viewerFormat("notes.markdown", OCTET)).toEqual({ kind: "markdown" });
    expect(viewerFormat("table.csv", "text/csv")).toEqual({ kind: "csv" });
    expect(viewerFormat("table.tsv", OCTET)).toEqual({ kind: "csv", tsv: true });
    expect(viewerFormat("server.log", OCTET)).toEqual({ kind: "text" });
    expect(viewerFormat("notes.txt", "text/plain")).toEqual({ kind: "text" });
    expect(viewerFormat(".gitignore", "")).toEqual({ kind: "text" });
  });

  it("reads HTML and XML files as code, never as a page", () => {
    expect(viewerFormat("index.html", "text/html")).toEqual({ kind: "code", language: "html" });
    expect(viewerFormat("page", "text/html")).toEqual({ kind: "code", language: "html" });
    expect(viewerFormat("feed.xml", "application/xml")).toEqual({ kind: "code", language: "xml" });
    expect(viewerFormat("feed", "application/rss+xml")).toEqual({ kind: "code", language: "xml" });
  });

  it("falls back to text, JSON, CSV or Markdown by the stored type", () => {
    expect(viewerFormat("export", "text/csv")).toEqual({ kind: "csv" });
    expect(viewerFormat("export", "text/tab-separated-values")).toEqual({ kind: "csv", tsv: true });
    expect(viewerFormat("answer", "application/ld+json")).toEqual({ kind: "json" });
    expect(viewerFormat("readme", "text/markdown")).toEqual({ kind: "markdown" });
    expect(viewerFormat("notes", "text/plain")).toEqual({ kind: "text" });
  });

  it("offers anything else as a download", () => {
    expect(viewerFormat("archive.zip", "application/zip")).toEqual({ kind: "other" });
    expect(viewerFormat("blob.bin", OCTET)).toEqual({ kind: "other" });
    expect(viewerFormat("photo.heic", "image/heic")).toEqual({ kind: "other" });
    expect(viewerFormat("slides.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation")).toEqual({ kind: "other" });
    expect(viewerFormat("", "")).toEqual({ kind: "other" });
  });
});

describe("extensionOf", () => {
  it("is the last dot's part, lowercased; a leading dot names the file", () => {
    expect(extensionOf("a.tar.GZ")).toBe("gz");
    expect(extensionOf("folder/file.Md")).toBe("md");
    expect(extensionOf("README")).toBe("");
    expect(extensionOf(".env")).toBe("env");
  });
});

describe("text truncation", () => {
  it("never ends inside a UTF-8 character", () => {
    const bytes = utf8("aç€😀");
    expect(wholeUtf8Length(bytes)).toBe(bytes.length);
    // "😀" is 4 bytes: cut after 1, 2 or 3 of them the character goes.
    for (const keep of [1, 2, 3]) expect(wholeUtf8Length(bytes.subarray(0, bytes.length - 4 + keep))).toBe(bytes.length - 4);
    // "€" is 3 bytes, after "a" (1) and "ç" (2).
    expect(wholeUtf8Length(bytes.subarray(0, 4))).toBe(3);
    expect(wholeUtf8Length(new Uint8Array())).toBe(0);
  });

  it("reads a cut UTF-8 file as UTF-8, not as Windows-1254", () => {
    const text = "şğü".repeat(10) + "\n" + "çöı".repeat(10);
    const bytes = utf8(text);
    // The limit lands in the middle of a two-byte letter.
    const preview = previewText(bytes, { limit: bytes.length - 3 });
    expect(preview.truncated).toBe(true);
    expect(preview.text).toBe("şğü".repeat(10));
  });

  it("says when the file is longer than what was read", () => {
    expect(previewText(utf8("short"), { total: 5 })).toEqual({ text: "short", truncated: false });
    expect(previewText(utf8("short"))).toEqual({ text: "short", truncated: false });
    // A range answer: the first bytes of a larger file.
    const first = previewText(utf8("line one\nline two\nline th"), { total: 10_000, limit: 100 });
    expect(first).toEqual({ text: "line one\nline two", truncated: true });
    // Cut at the limit itself.
    expect(previewText(utf8("x".repeat(50)), { limit: 20 })).toEqual({ text: "x".repeat(20), truncated: true });
  });

  it("keeps a cut line when the last line break is early", () => {
    expect(previewText(utf8("a\n" + "b".repeat(40)), { limit: 30 }).text).toBe("a\n" + "b".repeat(28));
  });

  it("decodes UTF-8 (BOM dropped), UTF-16 by its BOM and Windows-1254 otherwise", () => {
    expect(decodeBytes(utf8("﻿hello"))).toBe("hello");
    expect(decodeBytes(new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]))).toBe("hi");
    // "şğ" in Windows-1254.
    expect(decodeBytes(new Uint8Array([0xfe, 0xf0]))).toBe("şğ");
  });
});

describe("csvPreview", () => {
  it("finds a header over rows of other values", () => {
    expect(looksLikeHeader([["Name", "Amount"], ["Ann", "12"], ["Bob", "7"]])).toBe(true);
    expect(looksLikeHeader([["name", "city"], ["Ann", "Paris"]])).toBe(true);
    expect(looksLikeHeader([["Only a header"]])).toBe(true);
  });

  it("reads numbers, dates, blanks and repeats in the first row as data", () => {
    expect(looksLikeHeader([["Ann", "12"], ["Bob", "7"]])).toBe(false);
    expect(looksLikeHeader([["2024-01-02", "x"], ["2024-01-03", "y"]])).toBe(false);
    expect(looksLikeHeader([["Name", ""], ["Ann", "x"]])).toBe(false);
    expect(looksLikeHeader([["a", "A"], ["b", "c"]])).toBe(false);
    expect(looksLikeHeader([["₺1.250,00", "Rent"]])).toBe(false);
    // Every cell of the first row comes back below it: a list, not labels.
    expect(looksLikeHeader([["yes", "no"], ["no", "yes"], ["yes", "no"]])).toBe(false);
    expect(looksLikeHeader([])).toBe(false);
  });

  it("parses quoted fields and separators, and TSV by tabs", () => {
    const table = csvPreview('Name;Note\nAnn;"a; b"\nBob;"line\nbreak"\n');
    expect(table).toEqual({ header: ["Name", "Note"], rows: [["Ann", "a; b"], ["Bob", "line\nbreak"]], width: 2, partial: false });
    expect(csvPreview("a,b\tc\nd,e\tf", { tsv: true }).rows).toEqual([["d,e", "f"]]);
    expect(csvPreview("1,2\n3,4")).toEqual({ header: null, rows: [["1", "2"], ["3", "4"]], width: 2, partial: false });
  });

  it("shows at most the cap of rows and columns, and says so", () => {
    const lines = ["n,v", ...Array.from({ length: 30 }, (_, i) => `${i},${i * 2}`)].join("\n");
    const table = csvPreview(lines, { rows: 10 });
    expect(table.header).toEqual(["n", "v"]);
    expect(table.rows).toHaveLength(10);
    expect(table.rows[9]).toEqual(["9", "18"]);
    expect(table.partial).toBe(true);

    const wide = csvPreview(Array.from({ length: 8 }, (_, i) => `c${i}`).join(",") + "\n" + "1,2,3,4,5,6,7,8", { columns: 3 });
    expect(wide.header).toEqual(["c0", "c1", "c2"]);
    expect(wide.rows).toEqual([["1", "2", "3"]]);
    expect(wide.width).toBe(3);
    expect(wide.partial).toBe(true);
  });

  it("drops the last record of a cut file, which may be half a row", () => {
    const table = csvPreview("a,b\n1,2\n3,4\n5,", { truncated: true });
    expect(table.rows).toEqual([["1", "2"], ["3", "4"]]);
    expect(table.partial).toBe(true);
  });

  it("widens to the widest row", () => {
    expect(csvPreview("1\n2,3,4\n5,6").width).toBe(3);
    expect(csvPreview("")).toEqual({ header: null, rows: [], width: 0, partial: false });
  });
});

describe("prettyJson", () => {
  it("lays out whole JSON and leaves a cut or invalid one as it is", () => {
    expect(prettyJson('{"a":[1,2]}', false)).toBe('{\n  "a": [\n    1,\n    2\n  ]\n}');
    expect(prettyJson('{"a":[1,2', true)).toBe('{"a":[1,2');
    expect(prettyJson("{oops}", false)).toBe("{oops}");
  });
});

describe("probeResult", () => {
  const headers = (entries: Record<string, string>) => new Headers(entries);
  it("reads the size, type and name of a one-byte range answer", () => {
    const disposition = dispositionOf("text/csv", "Rapor şubat.csv");
    expect(probeResult(206, headers({ "content-range": "bytes 0-0/12345", "content-type": "text/csv", "content-disposition": disposition }))).toEqual({
      size: 12345,
      type: "text/csv",
      name: "Rapor şubat.csv",
    });
    // An empty file has no first byte.
    expect(probeResult(416, headers({ "content-range": "bytes */0", "content-type": "text/plain" }))).toEqual({ size: 0, type: "text/plain", name: null });
    // A server that sends the whole file.
    expect(probeResult(200, headers({ "content-length": "42", "content-type": "image/png; charset=binary" }))).toEqual({ size: 42, type: "image/png", name: null });
    expect(probeResult(404, headers({}))).toBeNull();
  });

  it("reads plain and encoded file names", () => {
    expect(dispositionName('attachment; filename="a b.txt"')).toBe("a b.txt");
    expect(dispositionName("inline; filename=plain.png")).toBe("plain.png");
    expect(dispositionName("attachment; filename*=UTF-8''%E2%82%AC.txt")).toBe("€.txt");
    expect(dispositionName(null)).toBeNull();
  });
});

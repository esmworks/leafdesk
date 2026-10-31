import { describe, expect, it } from "vitest";
import { imageType, mailFileKind } from "./mail-ai-files";

describe("mailFileKind", () => {
  it("reads documents, images, text, HTML and forwarded emails by their type", () => {
    expect(mailFileKind("application/pdf", "fatura.pdf")).toEqual({ kind: "document", document: "pdf" });
    expect(mailFileKind("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet; name=x", "x")).toEqual({ kind: "document", document: "xlsx" });
    expect(mailFileKind("IMAGE/JPEG", "foto")).toEqual({ kind: "image" });
    expect(mailFileKind("text/calendar; method=REQUEST", "invite.ics")).toEqual({ kind: "text" });
    expect(mailFileKind("application/xml", "efatura.xml")).toEqual({ kind: "text" });
    expect(mailFileKind("application/vnd.api+json", "a")).toEqual({ kind: "text" });
    expect(mailFileKind("text/html", "page.html")).toEqual({ kind: "html" });
    expect(mailFileKind("message/rfc822", "fwd.eml")).toEqual({ kind: "message" });
  });

  it("goes by the name only when the type says nothing, as mail programs send PDFs", () => {
    expect(mailFileKind("application/octet-stream", "Teklif.PDF")).toEqual({ kind: "document", document: "pdf" });
    expect(mailFileKind("application/octet-stream", "photo.jpeg")).toEqual({ kind: "image" });
    expect(mailFileKind("", "notes.txt")).toEqual({ kind: "text" });
    expect(mailFileKind("application/octet-stream", "fwd.eml")).toEqual({ kind: "message" });
    expect(mailFileKind("application/octet-stream", "setup.exe")).toBeNull();
  });

  it("reads a CSV file sent as an Excel type, as Windows mail programs send it", () => {
    expect(mailFileKind("application/vnd.ms-excel", "rapor.CSV")).toEqual({ kind: "text" });
    expect(mailFileKind("application/vnd.ms-excel", "old.xls")).toBeNull();
  });

  it("doesn't read a type it doesn't know, whatever the name says", () => {
    expect(mailFileKind("application/x-msdownload", "invoice.pdf")).toBeNull();
    expect(mailFileKind("application/msword", "old.doc")).toBeNull();
    expect(mailFileKind("image/svg+xml", "logo.svg")).toEqual({ kind: "text" });
    expect(mailFileKind("image/tiff", "scan.tif")).toBeNull();
  });
});

describe("imageType", () => {
  it("knows PNG, JPEG, GIF and WebP by their first bytes, nothing else", () => {
    expect(imageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe("image/png");
    expect(imageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(imageType(new TextEncoder().encode("GIF89a"))).toBe("image/gif");
    expect(imageType(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(imageType(new TextEncoder().encode("%PDF-1.7"))).toBeNull();
    expect(imageType(new Uint8Array([]))).toBeNull();
  });
});

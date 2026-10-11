import { describe, expect, it } from "vitest";
import { blockTypeFor, cleanFileName, contentTypeFor, dispositionOf, fileIdsIn, isFileId, isSafeInline, parseRange } from "./files";

const ID = "AbCdEfGhIjKlMnOpQrStUv_-";

describe("file ids", () => {
  it("accepts only 24 base64url characters", () => {
    expect(isFileId(ID)).toBe(true);
    expect(isFileId(ID.slice(1))).toBe(false);
    expect(isFileId(`${ID}x`)).toBe(false);
    expect(isFileId("../../etc/passwd")).toBe(false);
    expect(isFileId(null)).toBe(false);
  });

  it("finds ids in Markdown, relative and absolute, once each", () => {
    const md = `![a](/api/files/${ID})\n<img src="https://app.example/api/files/${ID}">\n[b](/api/files/${ID.replace("A", "Z")})`;
    expect(fileIdsIn(md)).toEqual([ID, ID.replace("A", "Z")]);
  });

  it("ignores longer tokens that only start like an id", () => {
    expect(fileIdsIn(`/api/files/${ID}X`)).toEqual([]);
  });
});

describe("cleanFileName", () => {
  it("keeps the last path segment without control characters", () => {
    expect(cleanFileName("C:\\Users\\me\\photo.png")).toBe("photo.png");
    expect(cleanFileName("../../evil\u0000.txt")).toBe("evil.txt");
    expect(cleanFileName("...hidden")).toBe("hidden");
    expect(cleanFileName("")).toBe("file");
    expect(cleanFileName(undefined)).toBe("file");
  });

  it("shortens long names but keeps the extension", () => {
    const name = cleanFileName(`${"a".repeat(300)}.pdf`);
    expect(name.length).toBe(200);
    expect(name.endsWith(".pdf")).toBe(true);
  });
});

describe("contentTypeFor", () => {
  it("uses a well-formed declared type without parameters", () => {
    expect(contentTypeFor("Image/PNG; charset=binary", "x")).toBe("image/png");
  });

  it("falls back to the extension, then to octet-stream", () => {
    expect(contentTypeFor("application/octet-stream", "clip.MP4")).toBe("video/mp4");
    expect(contentTypeFor("not a type", "doc.pdf")).toBe("application/pdf");
    expect(contentTypeFor(undefined, "blob")).toBe("application/octet-stream");
  });

  it("knows only its own extensions, none an object has by default", () => {
    for (const name of ["a.constructor", "a.__proto__", "a.toString", "a.hasOwnProperty"]) {
      expect(contentTypeFor(undefined, name), name).toBe("application/octet-stream");
    }
  });
});

describe("dispositionOf", () => {
  it("shows raster images, video, audio and PDF inline", () => {
    for (const type of ["image/png", "image/jpeg", "image/webp", "video/mp4", "audio/mpeg", "application/pdf"]) {
      expect(isSafeInline(type)).toBe(true);
      expect(dispositionOf(type, "a")).toMatch(/^inline;/);
    }
  });

  it("never shows SVG, HTML or unknown types inline", () => {
    for (const type of ["image/svg+xml", "text/html", "application/xhtml+xml", "text/xml", "text/plain", "application/octet-stream"]) {
      expect(isSafeInline(type)).toBe(false);
      expect(dispositionOf(type, "a")).toMatch(/^attachment;/);
    }
  });

  it("encodes the name for both old and new clients", () => {
    expect(dispositionOf("text/plain", 'rapor "ş" (1).txt')).toBe(
      `attachment; filename="rapor ___ (1).txt"; filename*=UTF-8''rapor%20%22%C5%9F%22%20%281%29.txt`,
    );
  });
});

describe("blockTypeFor", () => {
  it("picks the block by media type", () => {
    expect(blockTypeFor("image/svg+xml")).toBe("image");
    expect(blockTypeFor("video/webm")).toBe("video");
    expect(blockTypeFor("audio/ogg")).toBe("audio");
    expect(blockTypeFor("application/pdf")).toBe("file");
  });
});

describe("parseRange", () => {
  it("reads single ranges", () => {
    expect(parseRange("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=900-", 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange("bytes=-100", 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange("bytes=990-2000", 1000)).toEqual({ start: 990, end: 999 });
  });

  it("serves the whole file for no or several ranges", () => {
    expect(parseRange(null, 1000)).toBeNull();
    expect(parseRange("bytes=0-1,5-6", 1000)).toBeNull();
    expect(parseRange("items=0-1", 1000)).toBeNull();
  });

  it("refuses ranges past the end", () => {
    expect(parseRange("bytes=1000-", 1000)).toBe("unsatisfiable");
    expect(parseRange("bytes=5-2", 1000)).toBe("unsatisfiable");
    expect(parseRange("bytes=-0", 1000)).toBe("unsatisfiable");
  });
});

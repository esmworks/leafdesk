import { describe, expect, it } from "vitest";
import { coverFileId, coverImageUrl, coverText, parseCoverText, parsePageCover } from "./page-cover";

const FILE = "AbCdEfGhIjKlMnOpQrStUvWx";

describe("coverImageUrl", () => {
  it("keeps uploaded files as their relative path, however they are written", () => {
    expect(coverImageUrl(`/api/files/${FILE}`)).toBe(`/api/files/${FILE}`);
    expect(coverImageUrl(`https://leafdesk.example/api/files/${FILE}`)).toBe(`/api/files/${FILE}`);
    expect(coverImageUrl(FILE)).toBe(`/api/files/${FILE}`);
  });

  it("takes http(s) links and nothing else", () => {
    expect(coverImageUrl(" https://images.example/a.jpg ")).toBe("https://images.example/a.jpg");
    expect(coverImageUrl("javascript:alert(1)")).toBeNull();
    expect(coverImageUrl("data:image/png;base64,AAAA")).toBeNull();
    expect(coverImageUrl("/somewhere/else.png")).toBeNull();
    expect(coverImageUrl("//images.example/a.jpg")).toBeNull();
    expect(coverImageUrl(`https://images.example/${"a".repeat(2100)}`)).toBeNull();
    expect(coverImageUrl(42)).toBeNull();
  });
});

describe("parsePageCover", () => {
  it("reads gradients by name only", () => {
    expect(parsePageCover({ kind: "gradient", gradient: "forest" })).toEqual({ kind: "gradient", gradient: "forest" });
    expect(parsePageCover({ kind: "gradient", gradient: "toString" })).toBeNull();
    expect(parsePageCover({ kind: "gradient", gradient: "plaid" })).toBeNull();
  });

  it("reads images with their position, kept between 0 and 100", () => {
    expect(parsePageCover({ kind: "image", url: "https://images.example/a.jpg", y: 20 })).toEqual({
      kind: "image",
      url: "https://images.example/a.jpg",
      y: 20,
    });
    expect(parsePageCover({ kind: "image", url: `/api/files/${FILE}`, y: 140 })).toMatchObject({ y: 100 });
    expect(parsePageCover({ kind: "image", url: `/api/files/${FILE}`, y: -5 })).toMatchObject({ y: 0 });
    expect(parsePageCover({ kind: "image", url: `/api/files/${FILE}` })).toMatchObject({ y: 50 });
    expect(parsePageCover({ kind: "image", url: "ftp://images.example/a.jpg", y: 0 })).toBeNull();
  });

  it("reads anything else as no cover", () => {
    expect(parsePageCover(null)).toBeNull();
    expect(parsePageCover("forest")).toBeNull();
    expect(parsePageCover({ kind: "video", url: "https://x.example" })).toBeNull();
  });
});

describe("cover text", () => {
  it("round-trips gradients and images", () => {
    const gradient = parseCoverText("gradient:dusk");
    expect(gradient).toEqual({ kind: "gradient", gradient: "dusk" });
    expect(coverText(gradient!)).toBe("gradient:dusk");
    const image = parseCoverText(`https://leafdesk.example/api/files/${FILE}`, 30);
    expect(image).toEqual({ kind: "image", url: `/api/files/${FILE}`, y: 30 });
    expect(coverText(image!)).toBe(`/api/files/${FILE}`);
  });

  it("refuses unknown gradients and other text", () => {
    expect(parseCoverText("gradient:plaid")).toBeNull();
    expect(parseCoverText("a sunset")).toBeNull();
  });
});

describe("coverFileId", () => {
  it("is the uploaded file of an image cover, like the database trigger reads it", () => {
    expect(coverFileId({ kind: "image", url: `/api/files/${FILE}`, y: 50 })).toBe(FILE);
    expect(coverFileId({ kind: "image", url: "https://images.example/a.jpg", y: 50 })).toBeNull();
    expect(coverFileId({ kind: "gradient", gradient: "sky" })).toBeNull();
    expect(coverFileId(null)).toBeNull();
  });
});

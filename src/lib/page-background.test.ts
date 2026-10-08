import { describe, expect, it } from "vitest";
import {
  backgroundFileId,
  backgroundImageUrl,
  backgroundText,
  parseBackgroundText,
  parsePageBackground,
} from "./page-background";

const FILE = "AbCdEfGhIjKlMnOpQrStUvWx";

describe("backgroundImageUrl", () => {
  it("keeps uploaded files as their relative path, however they are written", () => {
    expect(backgroundImageUrl(`/api/files/${FILE}`)).toBe(`/api/files/${FILE}`);
    expect(backgroundImageUrl(`https://leafdesk.example/api/files/${FILE}`)).toBe(`/api/files/${FILE}`);
    expect(backgroundImageUrl(FILE)).toBe(`/api/files/${FILE}`);
  });

  it("takes http(s) links and nothing else", () => {
    expect(backgroundImageUrl(" https://images.example/a.jpg ")).toBe("https://images.example/a.jpg");
    expect(backgroundImageUrl("javascript:alert(1)")).toBeNull();
    expect(backgroundImageUrl("data:image/png;base64,AAAA")).toBeNull();
    expect(backgroundImageUrl("/somewhere/else.png")).toBeNull();
    expect(backgroundImageUrl("//images.example/a.jpg")).toBeNull();
    expect(backgroundImageUrl(`https://images.example/${"a".repeat(2100)}`)).toBeNull();
    expect(backgroundImageUrl(42)).toBeNull();
  });
});

describe("parsePageBackground", () => {
  it("reads colors by name only", () => {
    expect(parsePageBackground({ kind: "color", color: "blue" })).toEqual({ kind: "color", color: "blue" });
    expect(parsePageBackground({ kind: "color", color: "toString" })).toBeNull();
    // Yellow and brown tints are left out of the palette.
    expect(parsePageBackground({ kind: "color", color: "yellow" })).toBeNull();
  });

  it("reads images, dropping anything else they carry", () => {
    expect(parsePageBackground({ kind: "image", url: "https://images.example/a.jpg", y: 20 })).toEqual({
      kind: "image",
      url: "https://images.example/a.jpg",
    });
    expect(parsePageBackground({ kind: "image", url: "ftp://images.example/a.jpg" })).toBeNull();
  });

  it("reads anything else as no background", () => {
    expect(parsePageBackground(null)).toBeNull();
    expect(parsePageBackground("blue")).toBeNull();
    expect(parsePageBackground({ kind: "gradient", gradient: "forest" })).toBeNull();
  });
});

describe("background text", () => {
  it("round-trips colors and images", () => {
    const color = parseBackgroundText("color:green");
    expect(color).toEqual({ kind: "color", color: "green" });
    expect(backgroundText(color!)).toBe("color:green");
    const image = parseBackgroundText(`https://leafdesk.example/api/files/${FILE}`);
    expect(image).toEqual({ kind: "image", url: `/api/files/${FILE}` });
    expect(backgroundText(image!)).toBe(`/api/files/${FILE}`);
  });

  it("refuses unknown colors and other text", () => {
    expect(parseBackgroundText("color:plaid")).toBeNull();
    expect(parseBackgroundText("gradient:forest")).toBeNull();
    expect(parseBackgroundText("a sunset")).toBeNull();
  });
});

describe("backgroundFileId", () => {
  it("is the uploaded file of an image background, like the database trigger reads it", () => {
    expect(backgroundFileId({ kind: "image", url: `/api/files/${FILE}` })).toBe(FILE);
    expect(backgroundFileId({ kind: "image", url: "https://images.example/a.jpg" })).toBeNull();
    expect(backgroundFileId({ kind: "color", color: "gray" })).toBeNull();
    expect(backgroundFileId(null)).toBeNull();
  });
});

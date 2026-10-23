import { describe, expect, it } from "vitest";
import { imageType, letterheadLines, parseLetterhead, sameLetterheadName, tint } from "./letterheads";

describe("parseLetterhead", () => {
  it("tidies what an owner wrote", () => {
    const parsed = parseLetterhead({ name: "  Offers  ", header: "\n 3E  Soğutma \r\nİstanbul\n\n", footer: "", logoPlace: "right", accent: "#0B5EA8", pageNumbers: false });
    expect(parsed).toEqual({
      ok: true,
      fields: { name: "Offers", header: "3E Soğutma\nİstanbul", footer: "", logoPlace: "right", accent: "#0b5ea8", pageNumbers: false },
    });
  });

  it("fills in what is left out", () => {
    expect(parseLetterhead({ name: "Letters" })).toEqual({
      ok: true,
      fields: { name: "Letters", header: "", footer: "", logoPlace: "left", accent: "", pageNumbers: true },
    });
  });

  it("names the field that is wrong", () => {
    expect(parseLetterhead({ name: " " })).toEqual({ ok: false, problem: "name" });
    expect(parseLetterhead({ name: "x".repeat(61) })).toEqual({ ok: false, problem: "name" });
    expect(parseLetterhead({ name: "A", header: "1\n2\n3\n4\n5\n6\n7" })).toEqual({ ok: false, problem: "header" });
    expect(parseLetterhead({ name: "A", footer: "x".repeat(141) })).toEqual({ ok: false, problem: "footer" });
    expect(parseLetterhead({ name: "A", logoPlace: "top" })).toEqual({ ok: false, problem: "logoPlace" });
    expect(parseLetterhead({ name: "A", accent: "red" })).toEqual({ ok: false, problem: "accent" });
    expect(parseLetterhead({ name: "A", accent: "url(x)" })).toEqual({ ok: false, problem: "accent" });
  });

  it("keeps empty lines in between, which space out the lines", () => {
    expect(letterheadLines("a\n\nb", 6)).toBe("a\n\nb");
  });
});

describe("helpers", () => {
  it("matches names whatever their case and spacing", () => {
    expect(sameLetterheadName("Teklif  Antedi", " teklif antedi")).toBe(true);
    expect(sameLetterheadName("Teklif", "Fatura")).toBe(false);
  });

  it("tints a color toward white", () => {
    expect(tint("#000000", 0.5)).toBe("#808080");
    expect(tint("#0b5ea8", 0)).toBe("#0b5ea8");
    expect(tint("#0b5ea8", 1)).toBe("#ffffff");
  });

  it("tells PNG and JPEG by their first bytes, and nothing else", () => {
    expect(imageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe("image/png");
    expect(imageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(imageType(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
  });
});

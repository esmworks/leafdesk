import { describe, expect, it } from "vitest";
import { previewExcerpt, previewValueText } from "./page-preview";

describe("previewExcerpt", () => {
  it("keeps the first lines, without empty ones or extra spaces", () => {
    expect(previewExcerpt("Intro  text\n\n\n  Second   line \n")).toBe("Intro text\nSecond line");
    expect(previewExcerpt("")).toBe("");
  });

  it("cuts long text at a word, with an ellipsis", () => {
    const text = "word ".repeat(100);
    const cut = previewExcerpt(text, 50);
    expect(cut.length).toBeLessThanOrEqual(51);
    expect(cut.endsWith("word…")).toBe(true);
    expect(previewExcerpt("x".repeat(80), 50)).toBe(`${"x".repeat(50)}…`);
  });
});

describe("previewValueText", () => {
  it("reads values as MCP shows them", () => {
    expect(previewValueText("In progress")).toBe("In progress");
    expect(previewValueText(42)).toBe("42");
    expect(previewValueText(["Red", "Blue"])).toBe("Red, Blue");
    expect(previewValueText([{ id: "r1", title: "Acme" }, { id: "u1", name: "Ada" }])).toBe("Acme, Ada");
    expect(previewValueText({ address: "Istiklal Cd. 1", lat: 41, lng: 29 })).toBe("Istiklal Cd. 1");
    expect(previewValueText([{ text: "Call", checked: true }, { text: "Mail", checked: false }])).toBe("☑ Call, ☐ Mail");
    expect(previewValueText([{ name: "a.pdf", url: "/files/1" }])).toBe("a.pdf");
  });

  it("shows ticked checkboxes, and nothing for empty or unticked values", () => {
    expect(previewValueText(true)).toBe("✓");
    for (const empty of [false, null, undefined, "", "  ", [], {}, Number.NaN]) expect(previewValueText(empty)).toBe("");
  });

  it("cuts long values", () => {
    const long = previewValueText("a".repeat(200));
    expect(long.length).toBe(80);
    expect(long.endsWith("…")).toBe(true);
  });
});

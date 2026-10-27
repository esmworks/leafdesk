import { describe, expect, it } from "vitest";
import { ENGLISH_STARTER_LABELS, STARTER_LABELS, starterTheme } from "./pdf-theme-starter";
import { fillPlaceholders, hasPlaceholder, parsePdfTheme, type ThemeElement } from "./pdf-themes";

const values = {
  title: "Cold room offer",
  date: "27.10.2026",
  locale: "en",
  workspace: "Acme",
  properties: [
    { name: "Customer", value: "Akdeniz Gıda" },
    { name: "Quote  no", value: "Q-42" },
  ],
};

describe("parsePdfTheme", () => {
  it("passes the starter quote, in every language's words", () => {
    expect(parsePdfTheme(starterTheme(ENGLISH_STARTER_LABELS)).ok).toBe(true);
    expect(STARTER_LABELS.every((key) => typeof ENGLISH_STARTER_LABELS[key] === "string")).toBe(true);
  });

  it("passes an empty theme and says where the problems are", () => {
    expect(parsePdfTheme({})).toEqual({ ok: true, theme: {} });
    const bad = parsePdfTheme({ colors: { accent: "blue" }, content: [{ type: "text" }, { type: "wobble" }] });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.problems.some((p) => p.startsWith("colors.accent:"))).toBe(true);
    expect(bad.problems.some((p) => p.startsWith("content.0.text:"))).toBe(true);
    expect(bad.problems.some((p) => p.startsWith("content.1"))).toBe(true);
  });

  it("refuses fields it doesn't know, two bodies and a body in the footer", () => {
    expect(parsePdfTheme({ font: "Comic Sans" }).ok).toBe(false);
    expect(parsePdfTheme({ content: [{ type: "body" }, { type: "box", items: [{ type: "body" }] }] })).toEqual({
      ok: false,
      problems: ['content: at most one "body" element'],
    });
    expect(parsePdfTheme({ footer: [{ type: "body" }] }).ok).toBe(false);
  });

  it("refuses boxes nested deeper than four", () => {
    let element: ThemeElement = { type: "text", text: "deep" };
    for (let i = 0; i < 5; i++) element = { type: "box", items: [element] };
    expect(parsePdfTheme({ content: [element] }).ok).toBe(false);
  });

  it("takes no address or image of its own", () => {
    expect(parsePdfTheme({ content: [{ type: "logo", url: "https://example.com/logo.png" }] }).ok).toBe(false);
    expect(parsePdfTheme({ content: [{ type: "image", src: "https://example.com/a.png" }] }).ok).toBe(false);
  });
});

describe("fillPlaceholders", () => {
  it("fills the title, date, workspace and a row's values by name, case and spacing aside", () => {
    expect(fillPlaceholders("{{title}} · {{ date }} · {{workspace}}", values)).toBe("Cold room offer · 27.10.2026 · Acme");
    expect(fillPlaceholders("{{property:customer}} / {{property: Quote no }}", values)).toBe("Akdeniz Gıda / Q-42");
  });

  it("leaves unknown placeholders, missing values and page numbers outside a page empty", () => {
    expect(fillPlaceholders("[{{property:Missing}}][{{nonsense}}][{{page}}]", values)).toBe("[][][]");
    expect(fillPlaceholders("{{page}} / {{pages}}", { ...values, page: 2, pages: 3 })).toBe("2 / 3");
  });

  it("tells text with placeholders from text without", () => {
    expect(hasPlaceholder("Hello {{title}}")).toBe(true);
    expect(hasPlaceholder("Hello {title}")).toBe(false);
    expect(hasPlaceholder("Hello {{title}}")).toBe(true);
  });
});

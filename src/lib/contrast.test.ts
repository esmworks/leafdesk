import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The high-contrast colors of globals.css, over the theme's own: text, lines and accent must clear
// the WCAG ratios on every background of the theme, hovered and selected rows included.
const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

/** The `--name: #hex;` declarations from `start` up to `end`. */
function tokens(start: number, end: string): Record<string, string> {
  expect(start).toBeGreaterThanOrEqual(0);
  const block = css.slice(start, css.indexOf(end, start));
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6});/gi)].map((m) => [m[1], m[2].toLowerCase()]));
}

const light = tokens(css.indexOf("\n:root {\n"), "\n}\n");
const dark = tokens(css.indexOf("@variant dark {\n    --bg:"), "\n  }\n");
const hcLight = tokens(css.indexOf("/* hc:light */"), "}");
const hcDark = tokens(css.indexOf("/* hc:dark */"), "}");

function luminance(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

function ratio(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe.each([
  ["light", { ...light, ...hcLight }],
  ["dark", { ...light, ...dark, ...hcDark }],
])("high contrast, %s theme", (theme, c) => {
  const surfaces = ["bg", "bg-subtle", "bg-hover", "bg-active"];

  it("has every color it is checked with", () => {
    for (const name of [...surfaces, "fg", "fg-muted", "fg-faint", "border", "accent", "accent-fg", "danger"]) {
      expect(c[name], name).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("keeps text at 7:1 on the page and 4.5:1 on every surface", () => {
    for (const surface of surfaces) {
      expect(ratio(c.fg, c[surface])).toBeGreaterThanOrEqual(7);
      expect(ratio(c["fg-faint"], c[surface])).toBeGreaterThanOrEqual(4.5);
      expect(ratio(c["fg-muted"], c[surface])).toBeGreaterThanOrEqual(surface === "bg" || surface === "bg-subtle" ? 7 : 4.5);
    }
  });

  it("keeps lines at 3:1 and the accent and danger colors readable", () => {
    expect(ratio(c.border, c.bg)).toBeGreaterThanOrEqual(3);
    expect(ratio(c.border, c["bg-subtle"])).toBeGreaterThanOrEqual(3);
    expect(ratio(c.accent, c.bg)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(c["accent-fg"], c.accent)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(c.danger, c.bg)).toBeGreaterThanOrEqual(4.5);
  });

  it("is stronger than the standard colors", () => {
    const standard = theme === "light" ? light : { ...light, ...dark };
    expect(ratio(c["fg-muted"], c.bg)).toBeGreaterThan(ratio(standard["fg-muted"], standard.bg));
    expect(ratio(c["fg-faint"], c.bg)).toBeGreaterThan(ratio(standard["fg-faint"], standard.bg));
    expect(ratio(c.border, c.bg)).toBeGreaterThan(ratio(standard.border, standard.bg));
  });
});

// The backgrounds color rules give rows, cards and values (`--opt-mark`): the theme's text stays
// on them, so it must read as well as on a selected row.
describe.each([
  ["light", css.slice(css.indexOf(".opt-gray, .tint-gray {"), css.indexOf(":root:not(:has([data-print-view]))", css.indexOf(".opt-gray, .tint-gray {"))), light, hcLight],
  ["dark", css.slice(css.indexOf("    .opt-gray, .tint-gray {")), { ...light, ...dark }, hcDark],
])("color rule backgrounds, %s theme", (_theme, block, c, hc) => {
  const marks = [...block.slice(0, block.indexOf("\n\n")).matchAll(/\.tint-(\w+) \{[^}]*--opt-mark:\s*(#[0-9a-f]{6});/gi)].map((m) => [m[1], m[2]] as const);

  it("has one for every option color", () => {
    expect(marks.map(([name]) => name)).toEqual(["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"]);
  });

  it("keeps text readable on each", () => {
    for (const [name, mark] of marks) {
      expect(ratio(c.fg, mark), name).toBeGreaterThanOrEqual(7);
      expect(ratio(c["fg-muted"], mark), name).toBeGreaterThanOrEqual(Math.min(4.5, ratio(c["fg-muted"], c["bg-active"])));
      expect(ratio({ ...c, ...hc }["fg-muted"], mark), name).toBeGreaterThanOrEqual(7);
    }
  });
});

// Built-in icons in a color (lib/icon-value): graphics, so 3:1 on every surface of the theme, and
// 4.5:1 in high contrast.
const ICON_COLORS = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"];
describe.each([
  ["light", light, { ...light, ...hcLight }],
  ["dark", { ...light, ...dark }, { ...light, ...dark, ...hcDark }],
])("icon colors, %s theme", (_theme, standard, high) => {
  const surfaces = ["bg", "bg-subtle", "bg-hover", "bg-active"];

  it("has every color, readable on every surface", () => {
    for (const color of ICON_COLORS) {
      for (const surface of surfaces) {
        expect(ratio(standard[`icon-${color}`], standard[surface]), `${color} on ${surface}`).toBeGreaterThanOrEqual(3);
        expect(ratio(high[`icon-${color}`], high[surface]), `${color} on ${surface}, high contrast`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

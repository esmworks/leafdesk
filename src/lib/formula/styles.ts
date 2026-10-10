import { fail, type FormulaStyle, type StyledPart } from "./types";

/**
 * Styles style() puts on a value: bold, italic, underlined, struck through and inline code, a text
 * color, and a background color. The colors are the ones select options use, as text ("red") or as
 * a background ("red_background").
 */
export const TEXT_STYLES = ["b", "i", "u", "s", "c"] as const;
/** The same names as lib/properties SELECT_COLORS (a test keeps them equal). */
export const STYLE_COLORS = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"] as const;
export type StyleColor = (typeof STYLE_COLORS)[number];

const BACKGROUND = "_background";
const NAMES = new Set<string>([...TEXT_STYLES, ...STYLE_COLORS, ...STYLE_COLORS.map((c) => `${c}${BACKGROUND}`)]);

/** Every style name, for messages and the editor's reference. */
export const STYLE_NAMES: readonly string[] = [...NAMES];

/** A style name in its stored spelling (lowercase); null when there is no such style. */
export function styleName(raw: string): string | null {
  const name = raw.trim().toLowerCase();
  return NAMES.has(name) ? name : null;
}

export function requireStyle(raw: string): string {
  const name = styleName(raw);
  if (!name) {
    fail("invalidStyle", `Unknown style "${raw}". Use b, i, u, s, c, a color or a color with "_background"`, {
      style: raw,
      colors: STYLE_COLORS.join(", "),
    });
  }
  return name;
}

const isBackground = (name: string) => name.endsWith(BACKGROUND);
const isColor = (name: string) => !(TEXT_STYLES as readonly string[]).includes(name);

/**
 * Styles with more added: each is kept once, and a value has one text color and one background,
 * so a later color replaces an earlier one of the same kind.
 */
export function addStyles(styles: readonly string[], added: readonly string[]): string[] {
  let out = [...styles];
  for (const name of added) {
    if (isColor(name)) out = out.filter((s) => !isColor(s) || isBackground(s) !== isBackground(name));
    out = out.filter((s) => s !== name);
    out.push(name);
  }
  return out;
}

export const sameStyles = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((s) => b.includes(s));

/** Styled parts with neighbours of the same styles joined and empty ones dropped. */
export function mergeParts(parts: readonly StyledPart[]): StyledPart[] {
  const out: StyledPart[] = [];
  for (const part of parts) {
    if (!part.text) continue;
    const last = out[out.length - 1];
    if (last && sameStyles(last.styles, part.styles)) last.text += part.text;
    else out.push({ text: part.text, styles: [...part.styles] });
  }
  return out;
}

/** What a display needs to style one value (see FormulaStyle): the text color, background and the rest. */
export function styleClasses(styles: readonly string[]) {
  const text = styles.find((s) => isColor(s) && !isBackground(s));
  const background = styles.find(isBackground)?.slice(0, -BACKGROUND.length);
  return {
    bold: styles.includes("b"),
    italic: styles.includes("i"),
    underline: styles.includes("u"),
    strike: styles.includes("s"),
    code: styles.includes("c"),
    color: text as StyleColor | undefined,
    background: background as StyleColor | undefined,
  };
}

/** A stored style as read back (rows come from the network): null when it isn't one. */
export function asFormulaStyle(value: unknown): FormulaStyle | null {
  if (typeof value !== "object" || value === null) return null;
  const styles = (value as { styles?: unknown }).styles;
  if (Array.isArray(styles)) return { styles: styles.filter((s): s is string => typeof s === "string" && NAMES.has(s)) };
  const parts = (value as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return null;
  return {
    parts: parts.flatMap((p) =>
      typeof p?.text === "string" && Array.isArray(p.styles)
        ? [{ text: p.text, styles: p.styles.filter((s: unknown): s is string => typeof s === "string" && NAMES.has(s)) }]
        : [],
    ),
  };
}

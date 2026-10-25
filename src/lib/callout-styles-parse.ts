import { BLOCK_COLORS, type BlockColor } from "./block-colors";
import {
  CALLOUT_BORDERS,
  calloutKey,
  calloutTitle,
  MAX_CALLOUT_NAME,
  MAX_CALLOUT_STYLES,
  MAX_CALLOUT_TITLE,
  RESERVED_CALLOUT_KEYS,
  type CalloutBorder,
  type CalloutStyle,
  type CalloutStyleProblem,
} from "./callout-styles";
import { parseIcon } from "./icon";

// Checking callout styles, apart from lib/callout-styles: parseIcon brings the built-in icons' names,
// which the editor and every workspace route (through the callout styles' context) don't need.

/**
 * The styles an owner saves, checked: `index` is the first style with a problem (-1 for the list).
 * Names and titles are trimmed; an icon must be one emoji or built-in icon (or nothing).
 */
export function parseCalloutStyles(
  value: unknown,
): { ok: true; styles: CalloutStyle[] } | { ok: false; problem: CalloutStyleProblem; index: number } {
  if (!Array.isArray(value)) return { ok: false, problem: "tooMany", index: -1 };
  if (value.length > MAX_CALLOUT_STYLES) return { ok: false, problem: "tooMany", index: -1 };
  const styles: CalloutStyle[] = [];
  const keys = new Set<string>();
  for (const [index, raw] of value.entries()) {
    const fail = (problem: CalloutStyleProblem) => ({ ok: false as const, problem, index });
    if (!raw || typeof raw !== "object") return fail("key");
    const item = raw as Record<string, unknown>;
    const key = calloutKey(item.key);
    if (!key || item.key !== key) return fail("key");
    if (RESERVED_CALLOUT_KEYS.has(key)) return fail("reservedKey");
    if (keys.has(key)) return fail("duplicateKey");
    const name = typeof item.name === "string" ? item.name.replace(/\s+/g, " ").trim() : "";
    if (!name || [...name].length > MAX_CALLOUT_NAME) return fail("name");
    const icon = item.icon === "" || item.icon === undefined ? "" : parseIcon(item.icon);
    if (icon === null) return fail("icon");
    if (!(BLOCK_COLORS as readonly unknown[]).includes(item.color)) return fail("color");
    if (!(CALLOUT_BORDERS as readonly unknown[]).includes(item.border)) return fail("border");
    if (item.title !== undefined && typeof item.title !== "string") return fail("title");
    if (typeof item.title === "string" && [...item.title.trim()].length > MAX_CALLOUT_TITLE) return fail("title");
    keys.add(key);
    styles.push({ key, name, icon, color: item.color as BlockColor, border: item.border as CalloutBorder, title: calloutTitle(item.title) });
  }
  return { ok: true, styles };
}

/** The workspace's styles as stored, leaving out anything that wouldn't pass parseCalloutStyles. */
export function storedCalloutStyles(value: unknown): CalloutStyle[] {
  if (!Array.isArray(value)) return [];
  const out: CalloutStyle[] = [];
  for (const item of value.slice(0, MAX_CALLOUT_STYLES)) {
    const parsed = parseCalloutStyles([item]);
    if (parsed.ok && !out.some((style) => style.key === parsed.styles[0].key)) out.push(parsed.styles[0]);
  }
  return out;
}

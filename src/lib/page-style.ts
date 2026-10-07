import * as Y from "yjs";
import { COLLAB_META } from "./collab-constants";

/**
 * How a page reads: its typeface, a smaller body text, and whether it uses the window's whole width.
 * Kept in the page's shared doc (the meta map, next to the title), so a change shows live for
 * everyone, works offline, and travels with copies and templates. Defaults are stored as absent keys.
 */
export type PageFont = "default" | "serif" | "mono";
export type PageStyle = { font: PageFont; smallText: boolean; fullWidth: boolean };

export const PAGE_FONTS: readonly PageFont[] = ["default", "serif", "mono"];
export const DEFAULT_PAGE_STYLE: PageStyle = { font: "default", smallText: false, fullWidth: false };

const FONT = "font";
const SMALL_TEXT = "smallText";
const FULL_WIDTH = "fullWidth";

const isFont = (value: unknown): value is PageFont => PAGE_FONTS.includes(value as PageFont);

/**
 * The page's style. Anyone who may edit can write any value into the meta map, so anything but the
 * known values reads as the default.
 */
export function readPageStyle(doc: Y.Doc): PageStyle {
  const meta = doc.getMap(COLLAB_META);
  const font = meta.get(FONT);
  return {
    font: isFont(font) ? font : "default",
    smallText: meta.get(SMALL_TEXT) === true,
    fullWidth: meta.get(FULL_WIDTH) === true,
  };
}

/** Changes some of the page's style in one edit; values equal to the default remove their key. */
export function writePageStyle(doc: Y.Doc, change: Partial<PageStyle>, origin?: unknown) {
  const meta = doc.getMap(COLLAB_META);
  doc.transact(() => {
    if (change.font !== undefined) {
      if (change.font === "default" || !isFont(change.font)) meta.delete(FONT);
      else if (meta.get(FONT) !== change.font) meta.set(FONT, change.font);
    }
    for (const [key, value] of [
      [SMALL_TEXT, change.smallText],
      [FULL_WIDTH, change.fullWidth],
    ] as const) {
      if (value === undefined) continue;
      if (value) {
        if (meta.get(key) !== true) meta.set(key, true);
      } else if (meta.has(key)) meta.delete(key);
    }
  }, origin);
}

/** Calls `onChange` whenever the style may have changed; returns the unsubscribe function. */
export function observePageStyle(doc: Y.Doc, onChange: () => void) {
  const meta = doc.getMap(COLLAB_META);
  meta.observe(onChange);
  return () => meta.unobserve(onChange);
}

/** The style as one string, a stable snapshot for `useSyncExternalStore`. */
export function pageStyleKey(style: PageStyle): string {
  return `${style.font}|${style.smallText ? 1 : 0}|${style.fullWidth ? 1 : 0}`;
}

export function parsePageStyleKey(key: string): PageStyle {
  const [font, small, full] = key.split("|");
  return { font: isFont(font) ? font : "default", smallText: small === "1", fullWidth: full === "1" };
}

/**
 * The classes (globals.css) that give a page's content column its typeface and text size. Width is
 * left to the caller: its column already has a layout of its own.
 */
export function pageTextClasses(style: PageStyle): string {
  return [style.font !== "default" && `page-font-${style.font}`, style.smallText && "page-small-text"]
    .filter(Boolean)
    .join(" ");
}

/** The style of a stored Yjs state (`page.ydoc`); the defaults when there is none or it can't be read. */
export function pageStyleFromYdoc(state: Uint8Array | null | undefined): PageStyle {
  if (!state?.length) return DEFAULT_PAGE_STYLE;
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, state);
    return readPageStyle(doc);
  } catch {
    return DEFAULT_PAGE_STYLE;
  } finally {
    doc.destroy();
  }
}

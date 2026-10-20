/**
 * The row panel: a database row opened beside its view instead of as its own page (see
 * components/database/row-panel.tsx). The open row is in the address (`?row=<id>`), so a link
 * opens the view with the row beside it and the browser's Back closes it.
 */

/** The search param that holds the open row. */
export const ROW_PARAM = "row";

/** How narrow and wide the panel may be dragged, in pixels; it never leaves the view less than `minView`. */
export const ROW_PANEL_WIDTH = { min: 400, default: 600, max: 1200, minView: 320 } as const;

/** Where this browser keeps the width the viewer gave the panel. */
export const ROW_PANEL_WIDTH_KEY = "leafdesk:row-panel-width";

const ROW_ID = /^[\w-]{1,128}$/;

/** The row the address opens, or null for none (or something that can't be a row id). */
export function rowFromSearch(search: string | URLSearchParams): string | null {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const value = params.get(ROW_PARAM);
  return value && ROW_ID.test(value) ? value : null;
}

/** `href` with the row param set to `rowId`, or without it for null; the rest of the address stays. */
export function withRow(href: string, rowId: string | null): string {
  const url = new URL(href, "http://x");
  if (rowId) url.searchParams.set(ROW_PARAM, rowId);
  else url.searchParams.delete(ROW_PARAM);
  // Relative in, relative out: only an absolute address keeps its origin.
  return /^[a-z][a-z\d+.-]*:/i.test(href) ? url.href : `${url.pathname}${url.search}${url.hash}`;
}

/**
 * `href` pointing at block `blockId` of the page in the panel (`#block-<id>`, which its editor
 * scrolls to), or with no block for null; a hash that isn't a block's stays.
 */
export function withBlock(href: string, blockId: string | null): string {
  const url = new URL(href, "http://x");
  if (blockId) url.hash = `block-${blockId}`;
  else if (url.hash.startsWith("#block-")) url.hash = "";
  return /^[a-z][a-z\d+.-]*:/i.test(href) ? url.href : `${url.pathname}${url.search}${url.hash}`;
}

/** The rows before and after `rowId` in a view's order (repeats, like a bar in two weeks, count once). */
export function neighbours(order: readonly string[], rowId: string): { previous: string | null; next: string | null } {
  const unique = [...new Set(order)];
  const at = unique.indexOf(rowId);
  if (at < 0) return { previous: null, next: null };
  return { previous: unique[at - 1] ?? null, next: unique[at + 1] ?? null };
}

/** The panel's width kept within its bounds, and so that `viewport` still leaves the view some room. */
export function clampPanelWidth(width: number, viewport: number): number {
  const max = Math.max(ROW_PANEL_WIDTH.min, Math.min(ROW_PANEL_WIDTH.max, viewport - ROW_PANEL_WIDTH.minView));
  const w = Number.isFinite(width) ? width : ROW_PANEL_WIDTH.default;
  return Math.round(Math.min(max, Math.max(ROW_PANEL_WIDTH.min, w)));
}

/** A saved width, or the default when there is none or it can't be read. */
export function parsePanelWidth(value: string | null): number {
  const w = Number(value);
  return value && Number.isFinite(w) && w > 0 ? w : ROW_PANEL_WIDTH.default;
}

type ClickLike = { button?: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean };

/** A click that opens a link in a new tab or window: with ⌘/Ctrl or Shift held, or the middle button. */
export function opensNewTab(e: ClickLike): boolean {
  return e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1;
}

type KeyLike = { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean };

/** The row a key moves the panel to: K the previous one, J the next (without modifiers). */
export function stepKey(e: KeyLike): -1 | 1 | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  const key = e.key.toLowerCase();
  return key === "k" ? -1 : key === "j" ? 1 : null;
}

/** Where a row is, as far as the panel goes: its parent and whether it's in the trash; "none" when it can't be seen. */
export const rowPanelStamp = (row: { parentId: string | null; archived: boolean } | null) =>
  row ? `${row.parentId ?? ""}|${row.archived ? 1 : 0}` : "none";

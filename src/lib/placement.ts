/**
 * Where a panel opened from something on the screen goes (a menu, a card, a cell's editor): the
 * pure part of `components/use-placement.ts`, in window coordinates.
 */

/** A box on the screen: an element's rectangle, or a point (a right click) with no size. */
export type ScreenBox = { top: number; bottom: number; left: number; right: number };

export type PlacementOptions = {
  /** Lines the panel up with the anchor's start edge, or with its end edge. */
  align?: "start" | "end";
  /** Whether the line runs right to left, where the start edge is the right one. */
  rtl?: boolean;
  /** Overlays the anchor (a cell's editor) instead of opening next to it. */
  cover?: boolean;
  /** Between the anchor and the panel. */
  gap?: number;
  /** Kept free along the window's edges. */
  margin?: number;
};

export function pointBox(x: number, y: number): ScreenBox {
  return { top: y, bottom: y, left: x, right: x };
}

/**
 * Below the anchor, or above it when it fits only there; from the anchor's start or end edge; and
 * moved inside the window when it would reach past an edge.
 */
export function placePanel(
  anchor: ScreenBox,
  panel: { width: number; height: number },
  view: { width: number; height: number },
  { align = "start", rtl = false, cover = false, gap = cover ? 0 : 4, margin = 8 }: PlacementOptions = {},
): { top: number; left: number } {
  let top = cover ? anchor.top : anchor.bottom + gap;
  if (top + panel.height > view.height - margin && anchor.top - panel.height - gap > margin) {
    top = (cover ? anchor.bottom : anchor.top - gap) - panel.height;
  }
  top = Math.max(margin, Math.min(top, view.height - panel.height - margin));
  // "start" lines the panel up with the anchor's start edge: its right edge when right to left.
  const atEnd = (align === "end") !== rtl;
  let left = atEnd ? anchor.right - panel.width : anchor.left;
  left = Math.max(margin, Math.min(left, view.width - panel.width - margin));
  return { top, left };
}

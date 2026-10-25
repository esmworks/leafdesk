"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useLayoutEffect, useState } from "react";

/** Below this many body rows a table shows them all: nothing to gain, and the browser's find still sees every row. */
export const WINDOW_FROM = 120;
/** Rows kept above and below the visible ones, so a quick scroll doesn't show blank space. */
const OVERSCAN = 12;

/** Rows rendered before the scrolling element is known: enough to fill a screen, few enough to be quick. */
const FIRST_ROWS = 60;

/**
 * The element that scrolls a table's rows up and down: the nearest ancestor of the table's own box
 * (which only scrolls sideways, though it computes as `overflow-y: auto` too) that may scroll
 * vertically, preferring one that has more to show than fits. Outside a table (a list view's
 * lines), the nearest such ancestor of `start`.
 */
function scrollParent(start: HTMLElement | null): HTMLElement | null {
  let first: HTMLElement | null = null;
  const table = start?.closest("table");
  for (let node = table ? table.parentElement?.parentElement : start?.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY !== "auto" && overflowY !== "scroll") continue;
    if (node.scrollHeight > node.clientHeight) return node;
    first ??= node;
  }
  return first;
}

/**
 * Shows only the table body rows near the visible part of the page (plus OVERSCAN), with spacers
 * standing in for the rest, once there are WINDOW_FROM rows or more; a list view's lines likewise.
 * The page scrolls, not the table: rows are placed by where the body starts (`start`, the header's
 * bottom edge, or an empty element right above a list) inside the nearest scrolling ancestor. Row
 * heights are measured as they render (wrapped cells make rows taller), so `estimate` only has to
 * be close.
 */
export function useTableWindow({
  start,
  count,
  estimate,
  keyOf,
}: {
  start: HTMLElement | null;
  count: number;
  estimate: (index: number) => number;
  keyOf: (index: number) => string;
}) {
  // Undefined until looked for, null when nothing scrolls the table (then every row renders).
  const [scroller, setScroller] = useState<HTMLElement | null | undefined>(undefined);
  const [margin, setMargin] = useState(0);
  const long = count >= WINDOW_FROM;
  const windowed = long && !!scroller;

  // Looked for before the first paint, once the table is long enough to need it.
  useLayoutEffect(() => {
    if (long && start) setScroller(scrollParent(start));
  }, [start, long]);

  // Where the body starts within the scrolling content; what's above the table (a page's text,
  // the view bar) can change without the table rendering again, so scrolling checks it too.
  const measureMargin = useCallback(() => {
    if (!start || !scroller) return;
    const next = Math.round(start.getBoundingClientRect().bottom - scroller.getBoundingClientRect().top + scroller.scrollTop);
    setMargin((m) => (m === next ? m : next));
  }, [start, scroller]);
  useLayoutEffect(() => {
    if (count >= WINDOW_FROM) measureMargin();
  });
  useEffect(() => {
    if (!scroller || count < WINDOW_FROM) return;
    scroller.addEventListener("scroll", measureMargin, { passive: true });
    const observer = new ResizeObserver(measureMargin);
    observer.observe(scroller);
    return () => {
      scroller.removeEventListener("scroll", measureMargin);
      observer.disconnect();
    };
  }, [scroller, count, measureMargin]);

  // eslint-disable-next-line react-hooks/incompatible-library -- what it returns is read during this render only, never passed on
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scroller ?? null,
    estimateSize: estimate,
    getItemKey: keyOf,
    overscan: OVERSCAN,
    scrollMargin: margin,
    enabled: windowed,
  });

  if (!windowed) {
    return {
      windowed,
      indexes: Array.from({ length: long && scroller === undefined ? Math.min(count, FIRST_ROWS) : count }, (_, i) => i),
      padTop: 0,
      padBottom: 0,
      measure: undefined,
      reveal: () => false,
    };
  }
  const items = virtualizer.getVirtualItems();
  const first = items[0];
  const last = items[items.length - 1];
  return {
    windowed,
    indexes: items.map((item) => item.index),
    padTop: first ? first.start - margin : 0,
    padBottom: last ? virtualizer.getTotalSize() - last.end : virtualizer.getTotalSize() - margin,
    /** The ref every rendered body row gets (with `data-index`), so its height is measured. */
    measure: virtualizer.measureElement,
    /** Scrolls row `index` into view when it isn't rendered; false when it already is. */
    reveal: (index: number) => {
      if (items.some((item) => item.index === index)) return false;
      virtualizer.scrollToIndex(index, { align: "auto" });
      return true;
    },
  };
}

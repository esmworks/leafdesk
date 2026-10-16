"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useLayoutEffect, useState } from "react";

/** Below this many body rows a table shows them all: nothing to gain, and the browser's find still sees every row. */
export const WINDOW_FROM = 120;
/** Rows kept above and below the visible ones, so a quick scroll doesn't show blank space. */
const OVERSCAN = 12;

/** The element that scrolls `el` up and down: its nearest ancestor that scrolls vertically. */
function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let node = el?.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll") return node;
  }
  return null;
}

/**
 * Shows only the table body rows near the visible part of the page (plus OVERSCAN), with spacers
 * standing in for the rest, once there are WINDOW_FROM rows or more. The page scrolls, not the
 * table: rows are placed by where the body starts (`start`, the header's bottom edge) inside the
 * nearest scrolling ancestor. Row heights are measured as they render (wrapped cells make rows
 * taller), so `estimate` only has to be close.
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
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const [margin, setMargin] = useState(0);
  const windowed = count >= WINDOW_FROM && !!scroller;

  useEffect(() => {
    setScroller(scrollParent(start));
  }, [start]);

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
    getScrollElement: () => scroller,
    estimateSize: estimate,
    getItemKey: keyOf,
    overscan: OVERSCAN,
    scrollMargin: margin,
    enabled: windowed,
  });

  if (!windowed) {
    return {
      windowed,
      indexes: Array.from({ length: count }, (_, i) => i),
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

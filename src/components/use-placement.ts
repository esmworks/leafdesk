"use client";

import { useCallback, useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";
import { isRtl } from "@/components/direction";
import { placePanel, type PlacementOptions, type ScreenBox } from "@/lib/placement";

// Unplaced panels are transparent rather than visibility:hidden so children can take focus in
// their mount effects.
const HIDDEN: CSSProperties = { top: 0, left: 0, opacity: 0, pointerEvents: "none" };

/**
 * The style that places a `position: fixed` panel next to `anchor` (an element, or a box on the
 * screen such as a right click's point) while `open`: see `lib/placement.ts` `placePanel`. It
 * follows scrolling, the window's size and the panel's own size. `rtl` defaults to the anchor's
 * direction (the page's for a box); `cover` also gives the panel at least the anchor's width.
 */
export function usePlacement(
  panel: RefObject<HTMLElement | null>,
  anchor: Element | ScreenBox | null,
  open: boolean,
  { align, rtl, cover, gap, margin }: PlacementOptions = {},
): CSSProperties {
  const [style, setStyle] = useState<CSSProperties>(HIDDEN);

  const place = useCallback(() => {
    const element = panel.current;
    if (!anchor || !element) return;
    const box = anchor instanceof Element ? anchor.getBoundingClientRect() : anchor;
    const p = element.getBoundingClientRect();
    const at = placePanel(box, p, { width: window.innerWidth, height: window.innerHeight }, {
      align,
      rtl: rtl ?? isRtl(anchor instanceof Element ? anchor : null),
      cover,
      gap,
      margin,
    });
    // Inside something moved with a transform (a sliding sidebar) "fixed" counts from it instead
    // of the window: where the panel's current top and left put it tells how far off that is.
    const top = Math.round(at.top - (p.top - (parseFloat(element.style.top) || 0)));
    const left = Math.round(at.left - (p.left - (parseFloat(element.style.left) || 0)));
    const minWidth = cover ? box.right - box.left : undefined;
    setStyle((now) => (now.top === top && now.left === left && now.minWidth === minWidth && now.opacity === undefined ? now : { top, left, minWidth }));
  }, [panel, anchor, align, rtl, cover, gap, margin]);

  useLayoutEffect(() => {
    if (!open) {
      setStyle(HIDDEN);
      return;
    }
    place();
    const observer = new ResizeObserver(place);
    if (panel.current) observer.observe(panel.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, place, panel]);

  return style;
}

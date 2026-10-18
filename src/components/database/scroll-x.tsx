"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type RefObject } from "react";
import { cn } from "@/components/ui";
import { scrollLeftForDrag, scrollLeftForTrackPoint, scrollRange, thumbGeometry } from "@/lib/scrollbar";

/**
 * Wide views (board, table) scroll sideways in a box as tall as their content, so the box's own
 * scrollbar can sit hundreds of cards below the window. The box hides its own bar and
 * StickyScrollbar, placed right after it, draws one that sticks to the bottom of the page's
 * scroll area until the box's bottom edge comes into view, then rests under it: always one bar,
 * and only while the content overflows.
 */
export const HIDE_SCROLLBAR = "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

const metricsOf = (box: HTMLElement) => ({
  scrollLeft: box.scrollLeft,
  scrollWidth: box.scrollWidth,
  clientWidth: box.clientWidth,
  rtl: getComputedStyle(box).direction === "rtl",
});

export function StickyScrollbar({ target }: { target: RefObject<HTMLElement | null> }) {
  const track = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [thumb, setThumb] = useState<{ size: number; offset: number } | null>(null);
  const drag = useRef<{ x: number; scrollLeft: number; pointer: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const update = useCallback(() => {
    const box = target.current;
    if (!box) return;
    const m = metricsOf(box);
    setOverflows(scrollRange(m) > 0);
    const width = track.current?.clientWidth ?? 0;
    const next = thumbGeometry(m, width);
    setThumb((prev) => (prev && next && prev.size === next.size && prev.offset === next.offset ? prev : next));
  }, [target]);

  useLayoutEffect(() => {
    const box = target.current;
    if (!box) return;
    update();
    box.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(box);
    if (box.firstElementChild) observer.observe(box.firstElementChild);
    if (track.current) observer.observe(track.current);
    return () => {
      box.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [target, update, overflows]);

  if (!overflows) return null;

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const box = target.current;
    const el = track.current;
    if (!box || !el || !thumb || e.button !== 0) return;
    e.preventDefault();
    const m = metricsOf(box);
    const onThumb = (e.target as HTMLElement).dataset.thumb !== undefined;
    // A press on the track brings the thumb under the pointer, then drags from there.
    if (!onThumb) {
      const x = e.clientX - el.getBoundingClientRect().left;
      box.scrollLeft = scrollLeftForTrackPoint(x, m, el.clientWidth, thumb.size);
    }
    drag.current = { x: e.clientX, scrollLeft: box.scrollLeft, pointer: e.pointerId };
    el.setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const box = target.current;
    const el = track.current;
    const d = drag.current;
    if (!box || !el || !d || !thumb || d.pointer !== e.pointerId) return;
    box.scrollLeft = scrollLeftForDrag(d.scrollLeft, e.clientX - d.x, metricsOf(box), el.clientWidth, thumb.size);
  };
  const onPointerEnd = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointer !== e.pointerId) return;
    drag.current = null;
    setDragging(false);
  };

  return (
    // The box itself stays scrollable by keyboard, wheel and touch; this is a pointer aid only.
    <div aria-hidden className="sticky bottom-0 z-30 bg-bg px-2" dir="ltr">
      <div
        ref={track}
        data-scrollbar-x
        className="group/bar relative h-3 cursor-default touch-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      >
        {thumb && (
          <div
            data-thumb
            className={cn(
              "absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-fg/25 transition-[height,background-color] group-hover/bar:h-2 group-hover/bar:bg-fg/45",
              dragging && "h-2 bg-fg/45",
            )}
            style={{ width: thumb.size, left: thumb.offset }}
          />
        )}
      </div>
    </div>
  );
}

/** Pressing on the empty floor of a board and dragging pans it sideways; cards and controls keep their own drags. */
const KEEPS_POINTER = '.board-card, [draggable="true"], button, a, input, textarea, select, label, [contenteditable], [role="button"], [role="menu"]';
const PAN_THRESHOLD = 4;

export function useDragPan(target: RefObject<HTMLElement | null>, enabled = true) {
  useEffect(() => {
    const box = target.current;
    if (!box || !enabled) return;
    let pan: { x: number; scrollLeft: number; pointer: number; moving: boolean } | null = null;

    const down = (e: globalThis.PointerEvent) => {
      if (e.pointerType !== "mouse" || e.button !== 0 || scrollRange(box) === 0) return;
      if ((e.target as Element).closest(KEEPS_POINTER)) return;
      pan = { x: e.clientX, scrollLeft: box.scrollLeft, pointer: e.pointerId, moving: false };
    };
    const move = (e: globalThis.PointerEvent) => {
      if (!pan || pan.pointer !== e.pointerId) return;
      const dx = e.clientX - pan.x;
      if (!pan.moving) {
        if (Math.abs(dx) < PAN_THRESHOLD) return;
        pan.moving = true;
        box.setPointerCapture(e.pointerId);
        window.getSelection()?.removeAllRanges();
        document.documentElement.dataset.panning = "";
      }
      box.scrollLeft = pan.scrollLeft - dx;
    };
    const up = (e: globalThis.PointerEvent) => {
      if (!pan || pan.pointer !== e.pointerId) return;
      if (pan.moving) {
        delete document.documentElement.dataset.panning;
        // The press ended a pan, not a click on whatever is under the pointer.
        window.addEventListener("click", swallow, true);
        setTimeout(() => window.removeEventListener("click", swallow, true));
      }
      pan = null;
    };
    const swallow = (e: MouseEvent) => {
      e.stopPropagation();
      window.removeEventListener("click", swallow, true);
    };

    box.addEventListener("pointerdown", down);
    box.addEventListener("pointermove", move);
    box.addEventListener("pointerup", up);
    box.addEventListener("pointercancel", up);
    return () => {
      box.removeEventListener("pointerdown", down);
      box.removeEventListener("pointermove", move);
      box.removeEventListener("pointerup", up);
      box.removeEventListener("pointercancel", up);
      delete document.documentElement.dataset.panning;
    };
  }, [target, enabled]);
}

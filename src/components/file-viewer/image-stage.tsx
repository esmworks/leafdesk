"use client";

import { useEffect, useImperativeHandle, useRef, useState, type ReactNode, type RefObject } from "react";
import { cn } from "@/components/ui";

/**
 * An image in the file viewer: fitted to the screen, zoomed with the viewer's buttons and keys, the
 * wheel with Ctrl (a trackpad's pinch), a double click or two fingers, and moved by dragging once
 * zoomed. At its fitted size a horizontal swipe goes to the previous or next file.
 *
 * SVG shows through <img> like any image: a picture, never a document, so its scripts don't run
 * and it loads nothing else. It gets a white ground, as most drawings expect one.
 */

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 8;
const SWIPE = 60;

export type ZoomControl = { zoomBy: (factor: number) => void; reset: () => void };

type View = { scale: number; x: number; y: number };
const FITTED: View = { scale: 1, x: 0, y: 0 };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function ImageStage({
  url,
  name,
  svg,
  control,
  onZoom,
  onSwipe,
  failed,
}: {
  url: string;
  name: string;
  svg: boolean;
  control: RefObject<ZoomControl | null>;
  onZoom: (scale: number) => void;
  /** Goes to the next (1) or previous (-1) file; without it, swiping does nothing. */
  onSwipe?: (step: 1 | -1) => void;
  failed: ReactNode;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>(FITTED);
  const [broken, setBroken] = useState(false);
  const [moving, setMoving] = useState(false);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ start: View; from: { x: number; y: number }; distance: number; swiping: boolean } | null>(null);

  useEffect(() => onZoom(view.scale), [view.scale, onZoom]);

  /** `view` zoomed by `factor` about `at` (stage coordinates from its center), kept within bounds. */
  const zoomed = (current: View, factor: number, at = { x: 0, y: 0 }): View => {
    const scale = clamp(current.scale * factor, MIN_ZOOM, MAX_ZOOM);
    if (scale === MIN_ZOOM) return FITTED;
    const ratio = scale / current.scale;
    return { scale, x: at.x - (at.x - current.x) * ratio, y: at.y - (at.y - current.y) * ratio };
  };

  useImperativeHandle(control, () => ({ zoomBy: (factor) => setView((v) => zoomed(v, factor)), reset: () => setView(FITTED) }), []);

  /** A point of the window in stage coordinates, from the stage's center. */
  const local = (clientX: number, clientY: number) => {
    const rect = stage.current?.getBoundingClientRect();
    return rect ? { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 } : { x: 0, y: 0 };
  };

  // React's wheel listener is passive; zooming needs to keep the page from zooming instead.
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        const at = local(event.clientX, event.clientY);
        setView((v) => zoomed(v, Math.exp(-event.deltaY * 0.01), at));
      } else {
        setView((v) => (v.scale > 1 ? { ...v, x: v.x - event.deltaX, y: v.y - event.deltaY } : v));
      }
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, []);

  const twoFingers = () => {
    const [a, b] = [...pointers.current.values()];
    return { distance: Math.hypot(a.x - b.x, a.y - b.y), center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  };

  const onPointerDown = (event: React.PointerEvent) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    stage.current?.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const from = pointers.current.size === 2 ? twoFingers().center : { x: event.clientX, y: event.clientY };
    gesture.current = {
      start: view,
      from,
      distance: pointers.current.size === 2 ? twoFingers().distance : 0,
      swiping: pointers.current.size === 1 && view.scale === 1,
    };
    setMoving(true);
  };

  const onPointerMove = (event: React.PointerEvent) => {
    if (!pointers.current.has(event.pointerId) || !gesture.current) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const { start, from, distance } = gesture.current;
    if (pointers.current.size === 2 && distance > 0) {
      const { distance: now, center } = twoFingers();
      const pinched = zoomed(start, now / distance, local(from.x, from.y));
      setView({ ...pinched, x: pinched.x + center.x - from.x, y: pinched.y + center.y - from.y });
    } else if (pointers.current.size === 1 && start.scale > 1) {
      setView({ ...start, x: start.x + event.clientX - from.x, y: start.y + event.clientY - from.y });
    }
  };

  const onPointerUp = (event: React.PointerEvent) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.delete(event.pointerId);
    const current = gesture.current;
    if (current?.swiping && pointers.current.size === 0 && onSwipe) {
      const dx = event.clientX - current.from.x;
      const dy = event.clientY - current.from.y;
      if (Math.abs(dx) > SWIPE && Math.abs(dx) > Math.abs(dy) * 1.5) onSwipe(dx < 0 ? 1 : -1);
    }
    if (pointers.current.size === 0) {
      gesture.current = null;
      setMoving(false);
    } else {
      // One finger of two lifted: the other goes on moving from here.
      const [rest] = [...pointers.current.values()];
      gesture.current = { start: view, from: rest, distance: 0, swiping: false };
    }
  };

  if (broken) return <>{failed}</>;
  return (
    <div
      ref={stage}
      className={cn("relative flex min-h-0 flex-1 touch-none items-center justify-center overflow-hidden select-none", view.scale > 1 ? "cursor-grab" : "cursor-zoom-in", moving && view.scale > 1 && "cursor-grabbing")}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={(event) => {
        const at = local(event.clientX, event.clientY);
        setView((v) => (v.scale > 1 ? FITTED : zoomed(v, 2.5, at)));
      }}
    >
      {/* A same-origin upload, served only to people who may see it: a plain img, no optimizer. */}
      <img
        src={url}
        alt={name}
        draggable={false}
        onError={() => setBroken(true)}
        className={cn(
          "max-h-full max-w-full object-contain",
          svg && "min-h-[min(16rem,100%)] min-w-[min(16rem,100%)] bg-white",
          !moving && "transition-transform duration-150 ease-out",
        )}
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
      />
    </div>
  );
}

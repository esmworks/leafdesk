"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { isRtl } from "@/components/direction";
import { cn } from "@/components/ui";

const HIDDEN: React.CSSProperties = { top: 0, left: 0, opacity: 0, pointerEvents: "none" };

/**
 * Popover rendered into document.body with fixed positioning, so it is not clipped by the
 * table's horizontal scroll container. Flips above the anchor when there is no room below.
 */
export function Floating({
  anchor,
  open,
  onClose,
  children,
  align = "start",
  cover = false,
  className,
}: {
  anchor: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  align?: "start" | "end";
  /** Overlay the anchor (cell editors) instead of opening below it. */
  cover?: boolean;
  className?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  // Unplaced panels are transparent rather than visibility:hidden so children can take focus
  // in their mount effects.
  const [style, setStyle] = useState<React.CSSProperties>(HIDDEN);
  const close = useRef(onClose);
  close.current = onClose;

  const place = useCallback(() => {
    if (!anchor || !panel.current) return;
    const a = anchor.getBoundingClientRect();
    const p = panel.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const gap = cover ? 0 : 4;
    let top = cover ? a.top : a.bottom + gap;
    if (top + p.height > vh - 8 && a.top - p.height - gap > 8) top = (cover ? a.bottom : a.top - gap) - p.height;
    top = Math.max(8, Math.min(top, vh - p.height - 8));
    // "start" lines the panel up with the anchor's start edge: its right edge when right to left.
    const atEnd = (align === "end") !== isRtl(anchor);
    let left = atEnd ? a.right - p.width : a.left;
    left = Math.max(8, Math.min(left, vw - p.width - 8));
    setStyle({ top, left, minWidth: cover ? a.width : undefined });
  }, [anchor, align, cover]);

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
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panel.current?.contains(t) || anchor?.contains(t)) return;
      close.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close.current();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, anchor]);

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={panel}
      data-floating=""
      style={style}
      className={cn(
        "fixed z-50 max-w-[calc(100vw-1rem)] rounded-lg border border-border bg-bg shadow-lg",
        !cover && "min-w-48 p-1",
        className,
      )}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}

/**
 * State helper: an anchor element (tracked via callback ref so the panel can position itself on
 * the first open) plus an open flag.
 */
export function useFloating<T extends HTMLElement = HTMLElement>(initialOpen = false) {
  const [el, ref] = useState<T | null>(null);
  const [open, setOpen] = useState(initialOpen);
  return { el, ref, open, setOpen, toggle: () => setOpen((v) => !v), close: () => setOpen(false) };
}

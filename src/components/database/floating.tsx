"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/components/ui";
import { usePlacement } from "@/components/use-placement";

/**
 * Popover rendered into document.body with fixed positioning, so it is not clipped by the
 * table's horizontal scroll container. Placed by `usePlacement`: above the anchor when there is no
 * room below.
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
  const style = usePlacement(panel, anchor, open, { align, cover });
  const close = useRef(onClose);
  close.current = onClose;

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

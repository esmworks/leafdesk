"use client";

import { useEffect, useRef, type ReactNode } from "react";

/** Phones: the settings items scroll sideways; this brings the open one into view. */
export function SettingsNavScroller({ className, children }: { className: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    const active = el?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!el || !active || el.scrollWidth <= el.clientWidth) return;
    // Measured on screen, so it centers the item whichever way the row runs (right to left,
    // scrollLeft counts down from 0).
    const box = el.getBoundingClientRect();
    const item = active.getBoundingClientRect();
    el.scrollLeft += item.left + item.width / 2 - (box.left + box.width / 2);
  });
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}

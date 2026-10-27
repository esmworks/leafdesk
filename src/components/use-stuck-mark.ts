"use client";

import { useEffect } from "react";

/**
 * Marks a sticky element `data-stuck` while it is held at its edge, so it paints a background only
 * then: at rest an opaque band would cut through a page's background pattern. The element must be
 * its parent's first child, so the two only part while it is stuck.
 */
export function useStuckMark(el: HTMLElement | null) {
  useEffect(() => {
    const parent = el?.parentElement;
    if (!el || !parent) return;
    const check = () => el.toggleAttribute("data-stuck", el.getBoundingClientRect().top - parent.getBoundingClientRect().top > 0.5);
    check();
    // Scroll events don't bubble; caught on the way down, they come from whatever scrolls the page.
    document.addEventListener("scroll", check, { capture: true, passive: true });
    window.addEventListener("resize", check);
    return () => {
      document.removeEventListener("scroll", check, { capture: true });
      window.removeEventListener("resize", check);
    };
  }, [el]);
}

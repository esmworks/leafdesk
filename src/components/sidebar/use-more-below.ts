"use client";

import { useEffect } from "react";

/**
 * Marks a scrolling box `data-more-below` while there is more of it to scroll down to, so its
 * bottom edge fades out only then (the sidebar's list, under its account row).
 */
export function useMoreBelow(el: HTMLElement | null) {
  useEffect(() => {
    if (!el) return;
    let frame = 0;
    const check = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => el.toggleAttribute("data-more-below", el.scrollHeight - el.scrollTop - el.clientHeight > 1));
    };
    check();
    el.addEventListener("scroll", check, { passive: true });
    // The box changes size with the window; what it holds, as sections fold and pages load.
    const resized = new ResizeObserver(check);
    resized.observe(el);
    const changed = new MutationObserver(check);
    changed.observe(el, { childList: true, subtree: true });
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener("scroll", check);
      resized.disconnect();
      changed.disconnect();
    };
  }, [el]);
}

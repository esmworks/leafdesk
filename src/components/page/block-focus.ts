"use client";

import { useEffect } from "react";

/**
 * Links to a passage of a page (`#block-<id>`, e.g. the AI chat's citations) scroll the page's
 * editor to that block and highlight it for a moment. On the page already, the link's owner sends
 * FOCUS_BLOCK_EVENT with the id instead of navigating.
 */
export const FOCUS_BLOCK_EVENT = "leafdesk:focus-block";
const HASH = /^#block-([\w-]{1,100})$/;
const FOCUS_CLASS = "block-focus";

/** Scrolls to the block once the editor shows it (it may still be loading), then highlights it. */
function focusBlock(id: string): () => void {
  let tries = 0;
  let clear: ReturnType<typeof setTimeout> | undefined;
  const timer = setInterval(() => {
    const el = document.querySelector<HTMLElement>(`.leafdesk-editor .bn-block-outer[data-id="${CSS.escape(id)}"]`);
    if (el) {
      clearInterval(timer);
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.classList.add(FOCUS_CLASS);
      clear = setTimeout(() => el.classList.remove(FOCUS_CLASS), 2_500);
    } else if (++tries > 40) clearInterval(timer);
  }, 150);
  return () => {
    clearInterval(timer);
    if (clear) clearTimeout(clear);
  };
}

/** Follows `#block-<id>` in the address and FOCUS_BLOCK_EVENT for the page's editor (when `enabled`). */
export function useBlockFocus(enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    let cancel: (() => void) | undefined;
    const go = (id: string) => {
      cancel?.();
      cancel = focusBlock(id);
    };
    const fromHash = () => {
      const match = HASH.exec(window.location.hash);
      if (match) go(match[1]);
    };
    const onEvent = (event: Event) => {
      const id = (event as CustomEvent<{ blockId?: string }>).detail?.blockId;
      if (id) go(id);
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    window.addEventListener(FOCUS_BLOCK_EVENT, onEvent);
    return () => {
      cancel?.();
      window.removeEventListener("hashchange", fromHash);
      window.removeEventListener(FOCUS_BLOCK_EVENT, onEvent);
    };
  }, [enabled]);
}

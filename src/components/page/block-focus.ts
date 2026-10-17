"use client";

import { useEffect } from "react";
import { blockIdOfHash } from "@/lib/mentions";

/**
 * Links to a passage of a page (`#block-<id>`: "Copy link to block", mentions of a block, the AI
 * chat's citations, search hits) scroll the page's editor to that block and highlight it for a
 * moment. On the page already, the link's owner sends FOCUS_BLOCK_EVENT with the id instead of
 * navigating (openBlockLink does both). Published pages and the print view have anchors of their
 * own (server/published-body.ts).
 */
export const FOCUS_BLOCK_EVENT = "leafdesk:focus-block";
/** How long to wait for the block to show: the document may still be coming from the server. */
const WAIT_MS = 15_000;
/** How long the highlight lasts (the leafdesk-block-focus animation in globals.css). */
const HIGHLIGHT_MS = 2_500;

/**
 * Scrolls to the block once the editor shows it, then highlights it. A block that isn't there by
 * then (deleted since the link was made) leaves the page as it opened.
 *
 * The highlight is a style rule for the block's id, not a class on its element: the editor redraws
 * any element of its own whose attributes change (and may redraw the block anyway), so a class
 * would be gone at once.
 */
function focusBlock(id: string): () => void {
  const selector = `.leafdesk-editor .bn-block-outer[data-id="${CSS.escape(id)}"]`;
  let style: HTMLStyleElement | undefined;
  let clear: ReturnType<typeof setTimeout> | undefined;
  const removeStyle = () => {
    style?.remove();
    style = undefined;
  };
  const show = () => {
    const el = document.querySelector<HTMLElement>(selector);
    if (!el) return false;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    style = document.createElement("style");
    style.textContent = `${selector} > .bn-block > .bn-block-content { border-radius: 4px; animation: leafdesk-block-focus ${HIGHLIGHT_MS}ms ease-out; }`;
    document.head.append(style);
    clear = setTimeout(removeStyle, HIGHLIGHT_MS);
    return true;
  };
  if (show()) {
    return () => {
      clearTimeout(clear);
      removeStyle();
    };
  }
  const observer = new MutationObserver(() => {
    if (show()) stop();
  });
  const giveUp = setTimeout(() => stop(), WAIT_MS);
  function stop() {
    observer.disconnect();
    clearTimeout(giveUp);
  }
  observer.observe(document.body, { childList: true, subtree: true });
  return () => {
    stop();
    if (clear) clearTimeout(clear);
    removeStyle();
  };
}

/** Follows `#block-<id>` in the address and FOCUS_BLOCK_EVENT for the page's editor. */
export function useBlockFocus() {
  useEffect(() => {
    let cancel: (() => void) | undefined;
    const go = (id: string) => {
      cancel?.();
      cancel = focusBlock(id);
    };
    const fromHash = () => {
      const id = blockIdOfHash(window.location.hash);
      if (id) go(id);
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
  }, []);
}

/**
 * Opens `href` with `push`, or, for a block of the page already open, puts its address in the
 * history and focuses the block there (the router changes no page, so no hashchange follows).
 */
export function openBlockLink(href: string, push: (href: string) => void) {
  const url = new URL(href, window.location.href);
  const blockId = blockIdOfHash(url.hash);
  if (blockId && url.origin === window.location.origin && url.pathname === window.location.pathname) {
    window.history.pushState(window.history.state, "", url.pathname + url.search + url.hash);
    window.dispatchEvent(new CustomEvent(FOCUS_BLOCK_EVENT, { detail: { blockId } }));
    return;
  }
  push(href);
}

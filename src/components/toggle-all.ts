"use client";

import { useEffect, useRef } from "react";
import { isMac, opensToggleAll } from "@/lib/shortcuts";

/**
 * Mod+Alt+T opens or closes everything on the page that folds: the editors' toggles (toggle list
 * items and toggle headings, nested ones too, in the page and in synced pages and blocks shown in
 * it) and the groups of grouped database views (inline databases, linked views, the database page
 * itself). If anything is closed, all of it opens; otherwise all of it closes.
 *
 * Toggles are opened and closed with their own buttons, so the editor remembers each one as if it
 * had been clicked (this browser only, as a click is). A grouped view takes part through
 * TOGGLE_ALL_EVENT (useToggleAllGroups); what it opens or closes stays in this browser too, the
 * view's saved collapsed groups are left as they are.
 */
export const TOGGLE_ALL_EVENT = "leafdesk:toggle-all";

/** What a grouped view tells the shortcut: whether any of its groups is closed, and how to set them all. */
export type ToggleAllPart = { anyClosed: boolean; setAll: (open: boolean) => void };
export type ToggleAllDetail = { parts: ToggleAllPart[] };

const TOGGLE = ".bn-editor .bn-toggle-wrapper";

/** Opens or closes every toggle and group on the page, as the shortcut does. */
export function toggleAll(root: ParentNode = document) {
  const detail: ToggleAllDetail = { parts: [] };
  window.dispatchEvent(new CustomEvent<ToggleAllDetail>(TOGGLE_ALL_EVENT, { detail }));
  const toggles = [...root.querySelectorAll<HTMLElement>(TOGGLE)];
  const closed = (toggle: HTMLElement) => toggle.getAttribute("data-show-children") !== "true";
  const open = toggles.some(closed) || detail.parts.some((part) => part.anyClosed);
  for (const toggle of toggles) {
    if (closed(toggle) !== open) continue;
    toggle.querySelector<HTMLButtonElement>(":scope > .bn-toggle-button")?.click();
  }
  for (const part of detail.parts) part.setAll(open);
}

// One listener however many pages are shown (a row's page beside its database, say).
let listeners = 0;
function onKey(event: KeyboardEvent) {
  if (!opensToggleAll(event, isMac())) return;
  event.preventDefault();
  toggleAll();
}

/** Binds Mod+Alt+T while a page or database is shown. */
export function useToggleAllShortcut() {
  useEffect(() => {
    if (listeners++ === 0) window.addEventListener("keydown", onKey);
    return () => {
      if (--listeners === 0) window.removeEventListener("keydown", onKey);
    };
  }, []);
}

/**
 * A grouped view's part in Mod+Alt+T: `keys` are its groups shown, `closed` those closed, and
 * `setClosed` closes exactly the keys given (an empty list opens them all).
 */
export function useToggleAllGroups(keys: readonly string[] | null, closed: ReadonlySet<string>, setClosed: (keys: string[]) => void) {
  const latest = useRef({ keys, closed, setClosed });
  useEffect(() => {
    latest.current = { keys, closed, setClosed };
  });
  useEffect(() => {
    const onToggleAll = (event: Event) => {
      const { keys, closed, setClosed } = latest.current;
      if (!keys?.length) return;
      (event as CustomEvent<ToggleAllDetail>).detail.parts.push({
        anyClosed: keys.some((key) => closed.has(key)),
        setAll: (open) => setClosed(open ? [] : [...keys]),
      });
    };
    window.addEventListener(TOGGLE_ALL_EVENT, onToggleAll);
    return () => window.removeEventListener(TOGGLE_ALL_EVENT, onToggleAll);
  }, []);
}

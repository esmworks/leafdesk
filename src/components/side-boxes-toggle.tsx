"use client";

import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useSyncExternalStore } from "react";
import { IconButton } from "@/components/ui";

/**
 * Whether the person hid the boxes beside a chat's column (the agent's page, the AI chat): one
 * choice for both, remembered in this browser. Shown on the server and until it is read; while the
 * browser keeps nothing (a private window), the choice lasts as long as the tab.
 */
const KEY = "leafdesk:side-boxes-hidden";
const listeners = new Set<() => void>();
let kept: boolean | null = null;

function read(): boolean {
  if (kept !== null) return kept;
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Another tab's choice.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY) return;
    kept = null;
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useSideBoxesHidden(): [boolean, (hidden: boolean) => void] {
  const hidden = useSyncExternalStore(subscribe, read, () => false);
  const set = useCallback((next: boolean) => {
    kept = next;
    try {
      localStorage.setItem(KEY, next ? "1" : "0");
    } catch {}
    for (const listener of listeners) listener();
  }, []);
  return [hidden, set];
}

/**
 * The bar's button that hides or shows the boxes. It shows only where they can (a page wide enough,
 * lib/side-layout.ts) and while there is one to show: the page's root is the `group/side` that
 * holds the boxes' column (`data-side-column`), which keeps its boxes while they are hidden.
 */
export function SideBoxesToggle({ hidden, onChange }: { hidden: boolean; onChange: (hidden: boolean) => void }) {
  const t = useTranslations("ai.chat.side");
  const label = hidden ? t("show") : t("hide");
  return (
    // The wrapper hides it: the button's own inline-flex would win over a `hidden` beside it.
    <span className="hidden @min-[64rem]/side:group-has-[[data-side-column]_section]/side:flex">
      <IconButton label={label} className="h-7 w-7" onClick={() => onChange(!hidden)}>
        {hidden ? <PanelRightOpen className="h-4 w-4 rtl:-scale-x-100" /> : <PanelRightClose className="h-4 w-4 rtl:-scale-x-100" />}
      </IconButton>
    </span>
  );
}

"use client";

import { Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { cn } from "@/components/ui";
import { matchSettings, settingAnchor, type SettingsSearchItem } from "@/lib/settings-search";

/** How long a setting a search jumped to stays highlighted (leafdesk-setting-focus in globals.css). */
const HIGHLIGHT_MS = 2_400;

/**
 * Scrolls to a setting (`id="setting-<id>"`, SettingsGroup and SettingsRow `anchor`) and
 * highlights it for a moment. False when the page doesn't show it.
 */
export function focusSetting(id: string): boolean {
  const el = document.getElementById(settingAnchor(id));
  if (!el) return false;
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ block: "center", behavior: still ? "auto" : "smooth" });
  // An attribute React doesn't manage, so a re-render leaves it; set again, it starts over.
  delete el.dataset.settingFocus;
  void el.offsetWidth;
  el.dataset.settingFocus = "";
  window.setTimeout(() => delete el.dataset.settingFocus, HIGHLIGHT_MS);
  return true;
}

/** Jumps to the setting `?setting=` names once the tab shows it. */
export function SettingsJump({ setting }: { setting?: string }) {
  useEffect(() => {
    if (!setting) return;
    // The tab is rendered on the server; one frame lets the router's own scroll go first.
    const frame = requestAnimationFrame(() => {
      if (!focusSetting(setting)) requestAnimationFrame(() => focusSetting(setting));
    });
    return () => cancelAnimationFrame(frame);
  }, [setting]);
  return null;
}

/**
 * The search box over Settings: finds settings on every tab the person has by their names, their
 * tab and other words (lib/settings-search.ts), and jumps to the one picked.
 */
export function SettingsSearch({ items }: { items: SettingsSearchItem[] }) {
  const t = useTranslations("settings.search");
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const listId = useId();
  const found = useMemo(() => matchSettings(items, query), [items, query]);
  const shown = open && query.trim() !== "";

  useEffect(() => {
    if (!shown) return;
    const close = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [shown]);

  function choose(item: SettingsSearchItem | undefined) {
    if (!item) return;
    setOpen(false);
    setQuery("");
    const target = new URL(item.href, window.location.href);
    const setting = target.searchParams.get("setting");
    const here = new URL(window.location.href);
    // On its tab already: no new page, only the jump (the address follows, for a reload or a copy).
    if (setting && here.pathname === target.pathname && here.searchParams.get("tab") === target.searchParams.get("tab") && focusSetting(setting)) {
      window.history.replaceState(window.history.state, "", item.href);
      return;
    }
    router.push(item.href);
  }

  return (
    <div ref={box} className="relative mt-2 max-md:mb-1">
      <Search className="pointer-events-none absolute start-2 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-icon" aria-hidden />
      <input
        type="search"
        role="combobox"
        aria-label={t("label")}
        aria-expanded={shown}
        aria-controls={listId}
        aria-activedescendant={shown && found[active] ? `${listId}-${active}` : undefined}
        placeholder={t("placeholder")}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (found.length) setActive((i) => (i + (event.key === "ArrowDown" ? 1 : found.length - 1)) % found.length);
          } else if (event.key === "Enter") {
            event.preventDefault();
            choose(found[active]);
          } else if (event.key === "Escape" && query) {
            event.preventDefault();
            setQuery("");
          }
        }}
        className="h-8 w-full rounded-md border border-border bg-bg ps-8 pe-2 text-sm outline-none placeholder:text-fg-faint focus:border-accent md:h-7"
      />
      {shown && (
        <div
          id={listId}
          role="listbox"
          aria-label={t("label")}
          className="absolute inset-x-0 top-full z-30 mt-1 max-h-80 overflow-y-auto rounded-lg border border-border bg-bg p-1 shadow-lg"
        >
          {found.length === 0 ? (
            <div className="px-2 py-1.5 text-sm text-fg-muted">{t("noResults")}</div>
          ) : (
            found.map((item, index) => (
              <div
                key={item.id}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === active}
                onPointerMove={() => setActive(index)}
                // Keeps the box focused until the click lands.
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => choose(item)}
                className={cn("cursor-pointer rounded-md px-2 py-1.5", index === active && "bg-bg-hover")}
              >
                <div className="truncate text-sm text-fg">{item.label}</div>
                {item.label !== item.tab && <div className="truncate text-xs text-fg-muted">{item.tab}</div>}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

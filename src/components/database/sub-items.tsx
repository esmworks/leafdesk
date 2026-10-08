"use client";

import { ChevronRight, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { cn } from "@/components/ui";
import {
  parentProperty,
  subItemsProperty,
  subItemCounts,
  subItemLines,
  subItemsDisplay,
  topRows,
  type SubItemLine,
} from "@/lib/sub-items";
import type { Property, Row, View } from "./types";

/** How far each level of sub-items is indented, in pixels. */
export const SUB_ITEM_INDENT = 20;

const storageKey = (viewId: string) => `leafdesk:sub-items-open:${viewId}`;

// Which rows are open, per view: read from the tab's storage once, then kept here, so a browser
// that refuses storage still keeps them while the page is open.
const opened = new Map<string, Set<string>>();
const listeners = new Set<() => void>();
const NONE = new Set<string>();

function openRows(viewId: string): Set<string> {
  let ids = opened.get(viewId);
  if (!ids) {
    try {
      const stored = JSON.parse(sessionStorage.getItem(storageKey(viewId)) ?? "[]");
      ids = new Set(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : []);
    } catch {
      ids = new Set();
    }
    opened.set(viewId, ids);
  }
  return ids;
}

function setOpenRows(viewId: string, ids: Set<string>) {
  opened.set(viewId, ids);
  try {
    sessionStorage.setItem(storageKey(viewId), JSON.stringify([...ids]));
  } catch {
    // Kept in memory only.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/**
 * Sub-items in a table, list or timeline view: which rows are open (each viewer's own, kept for the
 * browser tab so opening a row and coming back keeps them), and the view's rows as lines to show.
 * Without sub-items, or in a view showing them flat, every row is a line of its own.
 */
export function useSubItems(view: View, properties: Property[], allRows: Row[]) {
  const parent = parentProperty(properties);
  const display = subItemsDisplay(view.config, parent);
  // The server render shows every row closed; the stored ones open after hydration.
  const openIds = useSyncExternalStore(
    subscribe,
    () => openRows(view.id),
    () => NONE,
  );
  const isOpen = useCallback((id: string) => openIds.has(id), [openIds]);
  const toggle = useCallback(
    (id: string) => {
      const next = new Set(openIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setOpenRows(view.id, next);
    },
    [openIds, view.id],
  );
  const expand = useCallback(
    (id: string) => {
      if (!openIds.has(id)) setOpenRows(view.id, new Set([...openIds, id]));
    },
    [openIds, view.id],
  );
  const counts = useMemo(
    () => (parent && display === "parents" ? subItemCounts(allRows, parent.id) : null),
    [parent, display, allRows],
  );
  // `allOpen`: every sub-item shows, for views without the arrows to open them.
  const lines = useCallback(
    (rows: Row[], { allOpen = false }: { allOpen?: boolean } = {}): SubItemLine<Row>[] => {
      if (!parent || display === "flat") return rows.map((row) => ({ row, depth: 0, children: 0, open: false }));
      if (display === "parents") {
        return topRows(rows, allRows, parent.id).map((row) => ({ row, depth: 0, children: counts?.get(row.id) ?? 0, open: false }));
      }
      return subItemLines(rows, parent.id, allOpen ? () => true : isOpen);
    },
    [parent, display, allRows, counts, isOpen],
  );
  return { parent, children: subItemsProperty(properties), nested: display === "nested", parentsOnly: display === "parents", lines, toggle, expand };
}

/**
 * The open/close arrow before a row's title in a nested view; an empty space of the same width on
 * rows without sub-items, so titles line up.
 */
export function SubItemToggle({
  line,
  title,
  onToggle,
  className,
}: {
  line: SubItemLine<Row>;
  title: string;
  onToggle: () => void;
  className?: string;
}) {
  const t = useTranslations("database.subItems");
  if (!line.children) return <span aria-hidden className={cn("w-5 shrink-0", className)} />;
  return (
    <button
      type="button"
      aria-expanded={line.open}
      aria-label={t(line.open ? "hide" : "show", { title, count: line.children })}
      title={t(line.open ? "hide" : "show", { title, count: line.children })}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className={cn(
        "inline-flex w-5 shrink-0 items-center justify-center rounded text-fg-muted hover:bg-bg-hover hover:text-fg",
        className,
      )}
    >
      <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", line.open && "rotate-90")} />
    </button>
  );
}

/** A small "+" that adds a sub-item to the row, shown while hovering it. */
export function AddSubItemButton({ title, onAdd, className }: { title: string; onAdd: () => void; className?: string }) {
  const t = useTranslations("database.subItems");
  return (
    <button
      type="button"
      title={t("add", { title })}
      aria-label={t("add", { title })}
      onClick={(e) => {
        e.stopPropagation();
        onAdd();
      }}
      className={cn(
        "inline-flex h-6 w-6 items-center justify-center rounded-md border border-border bg-bg text-fg-muted shadow-sm hover:bg-bg-hover hover:text-fg",
        className,
      )}
    >
      <Plus className="h-3.5 w-3.5" />
    </button>
  );
}

/** "3 sub-items" after a title in views showing parents only. */
export function SubItemCount({ count }: { count: number }) {
  const t = useTranslations("database.subItems");
  if (!count) return null;
  return <span className="shrink-0 text-xs text-fg-faint tabular-nums">{t("count", { count })}</span>;
}

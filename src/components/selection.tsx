"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/components/ui";

/**
 * Which items of a list are selected (a table's rows, the chat's conversations). Items that leave
 * the list (filtered out, trashed, deleted elsewhere) leave the selection. `ids` follows the list's
 * order.
 */
export function useSelection(rows: { id: string }[]) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  // The row the last plain click toggled: shift-click selects from there.
  const anchor = useRef<string | null>(null);

  useEffect(() => {
    setSelected((s) => {
      if (!s.size) return s;
      const present = new Set(rows.map((r) => r.id));
      const kept = [...s].filter((id) => present.has(id));
      return kept.length === s.size ? s : new Set(kept);
    });
  }, [rows]);

  const ids = useMemo(() => rows.filter((r) => selected.has(r.id)).map((r) => r.id), [rows, selected]);

  const clear = useCallback(() => {
    setSelected(new Set());
    anchor.current = null;
  }, []);

  const toggle = (rowId: string, range: boolean) => {
    const from = anchor.current ? rows.findIndex((r) => r.id === anchor.current) : -1;
    const to = rows.findIndex((r) => r.id === rowId);
    if (range && from !== -1 && to !== -1) {
      const [start, end] = from < to ? [from, to] : [to, from];
      setSelected((s) => new Set([...s, ...rows.slice(start, end + 1).map((r) => r.id)]));
      return;
    }
    anchor.current = rowId;
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  };

  const toggleAll = () => {
    if (ids.length === rows.length) clear();
    else setSelected(new Set(rows.map((r) => r.id)));
  };

  // Escape clears the selection. Listening on window lets an open popover's own Escape handler
  // (on document) stop the event first, so Escape closes the popover before the selection.
  const active = ids.length > 0;
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) clear();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, clear]);

  return {
    ids,
    isSelected: (rowId: string) => selected.has(rowId),
    all: rows.length > 0 && ids.length === rows.length,
    some: ids.length > 0,
    toggle,
    toggleAll,
    clear,
  };
}

export type Selection = ReturnType<typeof useSelection>;

/** An item's (or, with `indeterminate`, the header's) selection checkbox; shift-click selects a range. */
export function SelectBox({
  checked,
  indeterminate,
  label,
  visible,
  onToggle,
}: {
  checked: boolean;
  indeterminate?: boolean;
  label: string;
  /** Always shown (something is selected); otherwise it appears on hover. */
  visible: boolean;
  onToggle: (range: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = Boolean(indeterminate);
  }, [indeterminate]);
  // The wrapper takes the clicks (a mouse click and Space on the focused box both arrive here with
  // their shift key), so the whole 24px square is the target. Hidden boxes stay focusable.
  return (
    <div
      className="flex h-6 w-6 cursor-pointer items-center justify-center"
      onMouseDown={(e) => e.shiftKey && e.preventDefault()}
      onClick={(e) => onToggle(e.shiftKey)}
    >
      <input
        ref={ref}
        type="checkbox"
        checked={checked}
        aria-label={label}
        onChange={() => {}}
        className={cn(
          "pointer-events-none h-3.5 w-3.5 accent-accent",
          !checked &&
            !visible &&
            "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100",
        )}
      />
    </div>
  );
}

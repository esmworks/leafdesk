"use client";

import { useCallback, useEffect, useState } from "react";
import { read } from "@/components/read";
import type { CalendarItem } from "@/lib/calendar-items";

/** How often the items are read again while the window is shown. */
const CALENDAR_MS = 60_000;

/**
 * The person's calendar items from `from` to `to` (YYYY-MM-DD, both included; server/calendar.ts),
 * read again every minute, as the window comes back and as `again` changes (the page shown). Null
 * until the first read; the last items stay while a new range is read.
 */
export function useCalendarItems(workspaceId: string, from: string, to: string, { offline = false, again }: { offline?: boolean; again?: unknown } = {}) {
  const [items, setItems] = useState<{ key: string; items: CalendarItem[] } | null>(null);
  const key = `${from}/${to}`;
  const load = useCallback(() => {
    if (document.visibilityState !== "visible") return;
    read("calendarItems", workspaceId, from, to)
      .then((result) => result && setItems({ key: `${from}/${to}`, items: result }))
      .catch(() => {});
  }, [workspaceId, from, to]);
  useEffect(() => {
    if (offline) return;
    load();
    const timer = setInterval(load, CALENDAR_MS);
    document.addEventListener("visibilitychange", load);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, [offline, load, again]);
  return { items: items?.items ?? null, current: items?.key === key };
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { read } from "@/components/read";
import type { InboxItem } from "@/server/notifications";

/**
 * The notifications to show as cards over the page (arrival-cards.tsx), newest first. `unread` is
 * the inbox's count once it came for this workspace (null before): what is unread then the inbox
 * has, so it is only noted; any change afterwards reads what came (lib/inbox-arrivals.ts), shows
 * those not noted yet and keeps the cards still unread (one read in another tab goes). Not just a
 * rise: one refresh can see some read and another come. A card taken off the screen stays unread
 * in the inbox.
 */
export function useArrivals(workspaceId: string, unread: number | null) {
  const [arrivals, setArrivals] = useState<InboxItem[]>([]);
  const last = useRef<{ workspaceId: string; unread: number } | null>(null);
  const noted = useRef(new Set<string>());
  // The first read of a workspace, which later ones wait for so they don't show what it notes.
  const first = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    if (unread === null) return;
    const before = last.current?.workspaceId === workspaceId ? last.current : null;
    last.current = { workspaceId, unread };
    const current = () => last.current?.workspaceId === workspaceId;
    if (!before) {
      noted.current.clear();
      setArrivals([]);
      first.current =
        unread === 0
          ? Promise.resolve()
          : read("arrivals", workspaceId)
              .then((items) => {
                for (const item of items) noted.current.add(item.id);
              })
              .catch(() => {});
      return;
    }
    if (unread === before.unread) return;
    void first.current
      .then(() => read("arrivals", workspaceId))
      .then((items) => {
        if (!current()) return;
        const fresh = items.filter((item) => !noted.current.has(item.id));
        for (const item of fresh) noted.current.add(item.id);
        const stillUnread = new Set(items.map((item) => item.id));
        setArrivals((list) => [...fresh, ...list.filter((item) => stillUnread.has(item.id))]);
      })
      .catch(() => {});
  }, [workspaceId, unread]);
  /** Takes one card off the screen, or all of them without an id. */
  const dismiss = useCallback((id?: string) => {
    setArrivals((list) => (id ? list.filter((item) => item.id !== id) : []));
  }, []);
  return [arrivals, dismiss] as const;
}

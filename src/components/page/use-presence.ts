"use client";

import { useEffect, useState } from "react";
import { PRESENCE_FIELD, sameViewers, viewersOf, type Presence } from "@/lib/presence";
import type { PageDoc } from "./use-page-doc";

/**
 * Tells the others that you have the page open, and returns who else has it open (each person
 * once, without you). Works for people who may only view: the collab server takes awareness from
 * read-only connections too, and names each one after the user it signed in as.
 */
export function usePagePresence(pageDoc: PageDoc | null, self: { id: string; name: string }): Presence[] {
  const [viewers, setViewers] = useState<Presence[]>([]);

  useEffect(() => {
    const awareness = pageDoc?.provider.awareness;
    if (!awareness) {
      setViewers([]);
      return;
    }
    awareness.setLocalStateField(PRESENCE_FIELD, { id: self.id, name: self.name } satisfies Presence);
    const read = () => {
      const next = viewersOf(awareness.getStates() as Map<number, Record<string, unknown>>, self.id, awareness.clientID);
      setViewers((current) => (sameViewers(current, next) ? current : next));
    };
    read();
    // Awareness can change while another component renders: the editor sets its cursor fields
    // when it's created, inside the collab editor's render. Setting state then makes React warn,
    // so read once the render is over; changes in the same tick share one read.
    let queued = false;
    let active = true;
    const onChange = () => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (active) read();
      });
    };
    awareness.on("change", onChange);
    return () => {
      active = false;
      awareness.off("change", onChange);
      // The provider outlives the page view for a few seconds (see acquireDoc); leave right away.
      // Clear the field rather than the whole state so the cursor fields stay intact.
      awareness.setLocalStateField(PRESENCE_FIELD, null);
    };
  }, [pageDoc, self.id, self.name]);

  return viewers;
}

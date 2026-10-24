"use client";

import { useEffect, useState } from "react";
import * as Y from "yjs";
import { suggestionOfThread, THREADS_MAP } from "@/lib/comments";

// Apart from suggesting.ts so the page view can count suggestions without loading the editor's code.

/** The suggested edits of the page that wait for an answer (their threads still open). */
export function usePendingSuggestions(doc: Y.Doc | undefined): string[] {
  const [ids, setIds] = useState<string[]>([]);
  useEffect(() => {
    if (!doc) return setIds([]);
    const threads = doc.getMap<Y.Map<unknown>>(THREADS_MAP);
    const read = () => {
      const open: string[] = [];
      for (const thread of threads.values()) {
        if (!(thread instanceof Y.Map) || thread.get("resolved")) continue;
        const id = suggestionOfThread(thread.get("metadata"));
        if (id) open.push(id);
      }
      setIds((prev) => (prev.length === open.length && prev.every((id, i) => id === open[i]) ? prev : open));
    };
    read();
    threads.observeDeep(read);
    return () => threads.unobserveDeep(read);
  }, [doc]);
  return ids;
}

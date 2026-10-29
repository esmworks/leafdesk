"use client";

import { useCallback, useEffect, useState } from "react";
import { SNIPPETS_EVENT, type SnippetSummary } from "@/lib/snippets";
import { read } from "@/components/read";

export type Library = { snippets: SnippetSummary[]; manages: { id: string; name: string } | null };

// One list per workspace for every editor on the screen (a page and the synced pages in it), read
// again when someone saves a snippet (SNIPPETS_EVENT) or after a minute.
const libraries = new Map<string, { at: number; promise: Promise<Library> }>();
const FRESH_MS = 60_000;

function loadLibrary(workspaceId: string, force = false): Promise<Library> {
  const cached = libraries.get(workspaceId);
  if (cached && !force && Date.now() - cached.at < FRESH_MS) return cached.promise;
  const promise = read("usableSnippets", workspaceId).then((res) => (res.ok ? res.data : { snippets: [], manages: null }));
  // A failed load (offline) is tried again next time.
  promise.catch(() => libraries.delete(workspaceId));
  libraries.set(workspaceId, { at: Date.now(), promise });
  return promise;
}

/** Tells every open editor (and settings) that snippets changed. */
export function announceSnippetsChanged() {
  libraries.clear();
  window.dispatchEvent(new Event(SNIPPETS_EVENT));
}

/** The snippets the person can insert in the workspace, kept fresh. */
export function useSnippetLibrary(workspaceId: string, enabled: boolean) {
  const [library, setLibrary] = useState<Library>({ snippets: [], manages: null });
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    const load = (force?: boolean) =>
      void loadLibrary(workspaceId, force)
        .then((next) => current && setLibrary(next))
        .catch(() => {});
    load();
    const onChange = () => load(true);
    window.addEventListener(SNIPPETS_EVENT, onChange);
    return () => {
      current = false;
      window.removeEventListener(SNIPPETS_EVENT, onChange);
    };
  }, [workspaceId, enabled]);
  // The menu reads the newest list when it opens, so a minute-old one is checked again then.
  const refresh = useCallback(() => loadLibrary(workspaceId).then((next) => (setLibrary(next), next)), [workspaceId]);
  return { library, refresh };
}

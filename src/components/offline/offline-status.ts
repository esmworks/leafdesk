"use client";

/** What is downloading for offline use in this tab (offline-download.ts), for menus and Settings. */
import { useSyncExternalStore } from "react";

let busy = new Set<string>();
const busyListeners = new Set<() => void>();
export function setBusy(pageId: string, on: boolean) {
  const next = new Set(busy);
  if (on) next.add(pageId);
  else next.delete(pageId);
  busy = next;
  busyListeners.forEach((l) => l());
}
const onBusy = (listener: () => void) => {
  busyListeners.add(listener);
  return () => void busyListeners.delete(listener);
};
const noneBusy = new Set<string>();

/** The pages being downloaded in this tab. */
export function useDownloading(): ReadonlySet<string> {
  return useSyncExternalStore(onBusy, () => busy, () => noneBusy);
}

/** Asks the browser to keep this site's storage (once, when someone first downloads a page). */
export async function askToPersist() {
  try {
    if (navigator.storage && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {}
}

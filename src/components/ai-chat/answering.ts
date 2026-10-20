"use client";

/**
 * The conversations an answer is being written for in this tab (the panel's or the full-page
 * chat's), so the sidebar's list can mark them while it is on its way.
 */
import { useSyncExternalStore } from "react";

let answering: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function change(next: ReadonlySet<string>) {
  answering = next;
  for (const listener of listeners) listener();
}

/** Marks `id` as being answered until the returned function is called. */
export function holdAnswering(id: string) {
  change(new Set([...answering, id]));
  return () => change(new Set([...answering].filter((other) => other !== id)));
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const none: ReadonlySet<string> = new Set();

export function useAnswering(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => answering, () => none);
}

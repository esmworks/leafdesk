"use client";

import { useSyncExternalStore } from "react";

/**
 * How many open comment threads each property value of a row has, as the row's comments loaded
 * them (comment-store.ts): the row's properties show it beside each value. Kept per page, outside
 * React, because the row's properties and its editor are apart in the tree.
 */

const counts = new Map<string, ReadonlyMap<string, number>>();
const listeners = new Set<() => void>();
const NONE: ReadonlyMap<string, number> = new Map();

/** The open threads on each property of `pageId`, by property id. */
export function setPropertyThreadCounts(pageId: string, next: ReadonlyMap<string, number>) {
  if (next.size) counts.set(pageId, next);
  else if (!counts.delete(pageId)) return;
  listeners.forEach((listener) => listener());
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** The open threads on property `propertyId` of `pageId`. */
export function usePropertyThreadCount(pageId: string, propertyId: string): number {
  return useSyncExternalStore(
    subscribe,
    () => (counts.get(pageId) ?? NONE).get(propertyId) ?? 0,
    () => 0,
  );
}

"use client";

/**
 * The conversations an answer is being written for in this tab (the panel's or the full-page
 * chat's), and those of them whose answer waits for the person's decision on a change, so the
 * sidebar's list can mark them while it is on its way.
 */
import { useSyncExternalStore } from "react";

const none: ReadonlySet<string> = new Set();

/** A set of conversation ids held by whoever marks them, read by the list. */
function heldSet() {
  let held: ReadonlySet<string> = none;
  const listeners = new Set<() => void>();
  const change = (next: ReadonlySet<string>) => {
    held = next;
    for (const listener of listeners) listener();
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  return {
    /** Marks `id` until the returned function is called. */
    hold(id: string) {
      change(new Set([...held, id]));
      return () => change(new Set([...held].filter((other) => other !== id)));
    },
    subscribe,
    get: () => held,
  };
}

const answering = heldSet();
const waiting = heldSet();

/** Marks `id` as being answered until the returned function is called. */
export const holdAnswering = answering.hold;
/** Marks `id`'s answer as waiting for the person's decision until the returned function is called. */
export const holdWaiting = waiting.hold;

const server = () => none;

export function useAnswering(): ReadonlySet<string> {
  return useSyncExternalStore(answering.subscribe, answering.get, server);
}

export function useWaiting(): ReadonlySet<string> {
  return useSyncExternalStore(waiting.subscribe, waiting.get, server);
}

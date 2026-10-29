"use client";

import { useEffect, useSyncExternalStore, type ComponentType, type ReactNode } from "react";

/** A component from `lazyPart`, with `preload()` to start loading its code early (as a pointer nears what opens it). */
export type LazyPart<P> = ComponentType<P> & { preload: () => Promise<void> };

type State<P> = { component?: ComponentType<P>; error?: unknown };

/**
 * A component whose code loads the first time it shows: dialogs, menus and panels opened now and
 * then. Client-only, like `next/dynamic` with `ssr: false`. Until the code is there it shows
 * `fallback` (nothing by default) instead of suspending: React holds back what a Suspense boundary
 * reveals until 300 ms after the last fallback shown anywhere, so a dialog behind `next/dynamic` or
 * `lazy()` opened the first time that late however fast its code came. A failed load throws from
 * render, to the nearest error boundary, as those do.
 */
export function lazyPart<P extends object>(load: () => Promise<ComponentType<P>>, fallback: ReactNode = null): LazyPart<P> {
  const empty: State<P> = {};
  let state = empty;
  let loading: Promise<void> | undefined;
  const listeners = new Set<() => void>();
  const preload = () =>
    (loading ??= load().then(
      (component) => settle({ component }),
      (error: unknown) => settle({ error }),
    ));
  const settle = (next: State<P>) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  };
  const current = () => state;
  // The server, and the browser while hydrating, render the fallback: the same on both sides.
  const none = () => empty;

  function Part(props: P) {
    const { component: Component, error } = useSyncExternalStore(subscribe, current, none);
    useEffect(() => {
      void preload();
    }, []);
    if (error !== undefined) throw error;
    return Component ? <Component {...props} /> : fallback;
  }
  return Object.assign(Part, { preload });
}

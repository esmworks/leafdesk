"use client";

import { createContext, useContext, useMemo, useSyncExternalStore, type MouseEvent } from "react";
import { opensNewTab } from "@/lib/row-panel";

/** Where a row was opened from: its view (`data-row-source`) and the element that opened it. */
export type RowOrigin = { source: Element | null; trigger: HTMLElement | null };

/**
 * The row open in the panel, as the address says. Read through a subscription rather than with the
 * host: a view's rows ask only whether they are the open one, so moving to another row redraws the
 * two rows it concerns, not the whole view.
 */
export type OpenRowStore = {
  get: () => string | null;
  subscribe: (onChange: () => void) => () => void;
};

export function createOpenRowStore(initial: string | null): OpenRowStore & { set: (rowId: string | null) => void } {
  let rowId = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => rowId,
    set: (next) => {
      if (next === rowId) return;
      rowId = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/** The row panel of the workspace's pages (row-panel.tsx), for the views on them. */
export type RowPanelHost = {
  /** The row open in the panel. */
  openRow: OpenRowStore;
  /** Rows can open in the panel here: not on phones, where they open as pages. */
  available: boolean;
  /**
   * Opens a row in the panel, in place of the one open there; any page opens there too (the AI
   * chat's sources). `blockId` scrolls the page to that block.
   */
  open: (rowId: string, origin: RowOrigin, blockId?: string | null) => void;
  /** A view's rows (or their order) changed: the panel's previous and next rows may have too. */
  rowsChanged: () => void;
};

export const RowPanelContext = createContext<RowPanelHost | null>(null);

/** The row panel around the page, or null outside the workspace's pages. */
export function useRowPanel() {
  return useContext(RowPanelContext);
}

type OpenEvent = {
  button?: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  currentTarget?: EventTarget | null;
};

/** How the rows of a view open (database-page.tsx sets it for its view). */
export type RowOpener = {
  href: (rowId: string) => string;
  /**
   * Opens a row as the view says: beside it in the panel, or as its page. A click with ⌘/Ctrl or
   * Shift, or with the middle button, opens the page in a new tab, as links do.
   */
  open: (rowId: string, event?: OpenEvent) => void;
  /** Opens the row as its page, whatever the view says. */
  openPage: (rowId: string) => void;
  /** Rows open in the panel (else as pages). */
  inPanel: boolean;
};

export const RowOpenerContext = createContext<RowOpener | null>(null);

/** Opens a row's page in a new tab, as a link with ⌘/Ctrl held does. */
export function openInNewTab(href: string) {
  window.open(href, "_blank", "noopener");
}

/**
 * The view's way of opening rows; outside a database page, rows open as pages. Views always sit in
 * one (database-page.tsx gives them its opener): the fallback doesn't read the router, which would
 * redraw every row of a view at each change of the address, a row opening beside it among them.
 */
export function useRowOpener(workspaceId: string): RowOpener {
  const opener = useContext(RowOpenerContext);
  const fallback = useMemo<RowOpener>(() => {
    const href = (rowId: string) => `/w/${workspaceId}/p/${rowId}`;
    const go = (rowId: string) => window.location.assign(href(rowId));
    return {
      href,
      open: (rowId, event) => (event && opensNewTab(event) ? openInNewTab(href(rowId)) : go(rowId)),
      openPage: go,
      inPanel: false,
    };
  }, [workspaceId]);
  return opener ?? fallback;
}

const noRow = () => null;
const noSubscription = () => () => {};

/** The row open in the panel beside the view, to mark in it; null while its rows open as pages. */
export function useOpenRow(opener: RowOpener): string | null {
  const store = useRowPanel()?.openRow;
  return useSyncExternalStore(
    store?.subscribe ?? noSubscription,
    opener.inPanel && store ? store.get : noRow,
    noRow,
  );
}

/** Whether `rowId` is the row open in the panel beside the view: changes only for that row. */
export function useIsOpenRow(opener: RowOpener, rowId: string): boolean {
  const store = useRowPanel()?.openRow;
  return useSyncExternalStore(
    store?.subscribe ?? noSubscription,
    () => opener.inPanel && store?.get() === rowId,
    () => false,
  );
}

/** Props of an element that opens a row on click: also with the middle button, into a new tab. */
export function openRowProps(opener: RowOpener, rowId: string, enabled = true) {
  return {
    "data-open-row": rowId,
    onAuxClick: (e: MouseEvent) => {
      if (enabled && e.button === 1) {
        e.preventDefault();
        openInNewTab(opener.href(rowId));
      }
    },
  };
}

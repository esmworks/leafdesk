"use client";

import { useRouter } from "next/navigation";
import { createContext, useContext, useMemo, type MouseEvent } from "react";
import { opensNewTab } from "@/lib/row-panel";

/** Where a row was opened from: its view (`data-row-source`) and the element that opened it. */
export type RowOrigin = { source: Element | null; trigger: HTMLElement | null };

/** The row panel of the workspace's pages (row-panel.tsx), for the views on them. */
export type RowPanelHost = {
  /** The row open in the panel, as the address says. */
  rowId: string | null;
  /** Rows can open in the panel here: not on phones, where they open as pages. */
  available: boolean;
  /** Opens a row in the panel, in place of the one open there. */
  open: (rowId: string, origin: RowOrigin) => void;
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
  /** The row open in the panel, to mark in the view. */
  current: string | null;
};

export const RowOpenerContext = createContext<RowOpener | null>(null);

/** Opens a row's page in a new tab, as a link with ⌘/Ctrl held does. */
export function openInNewTab(href: string) {
  window.open(href, "_blank", "noopener");
}

/** The view's way of opening rows; outside a database page, rows open as pages. */
export function useRowOpener(workspaceId: string): RowOpener {
  const opener = useContext(RowOpenerContext);
  const router = useRouter();
  const fallback = useMemo<RowOpener>(() => {
    const href = (rowId: string) => `/w/${workspaceId}/p/${rowId}`;
    return {
      href,
      open: (rowId, event) => (event && opensNewTab(event) ? openInNewTab(href(rowId)) : router.push(href(rowId))),
      openPage: (rowId) => router.push(href(rowId)),
      inPanel: false,
      current: null,
    };
  }, [workspaceId, router]);
  return opener ?? fallback;
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

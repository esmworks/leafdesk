"use client";

import type { HocuspocusProvider, onStatusParameters, WebSocketStatus } from "@hocuspocus/provider";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type * as Y from "yjs";
import { acquireDoc } from "@/components/collab/socket";
import { useOffline } from "@/components/offline/offline-context";
import { observeDocTitle, readDocTitle, writeDocTitle } from "@/lib/collab-title";
import { COLLAB_UNAUTHORIZED, syncState, type SyncState } from "@/lib/offline";
import { observePageStyle, pageStyleKey, parsePageStyleKey, readPageStyle, type PageStyle } from "@/lib/page-style";

export type PageDoc = { doc: Y.Doc; provider: HocuspocusProvider };

/**
 * `live`: connected and in sync. `syncing`: connected, sending edits (made offline, or a burst of
 * typing) the server hasn't confirmed yet. `connecting`: first connection. `reconnecting`: the
 * socket dropped after the page was shown and is coming back. `offline`: no connection (the socket
 * is waiting to retry, or no collab token could be fetched); edits are kept in this browser until
 * it returns. `noAccess`: the server turned the page down.
 */
export type ConnectionState = SyncState;

type DocState = {
  pageDoc: PageDoc | null;
  /** Sticky: once the server state has arrived the editor stays mounted through reconnects. */
  synced: boolean;
  /** In sync right now; drops whenever the socket does. */
  live: boolean;
  socket: `${WebSocketStatus}`;
  accessLost: boolean;
  tokenFailed: boolean;
  /** The offline copy had the page's body: it can be shown before (or without) the server. */
  localReady: boolean;
  /** Edits made here that the server hasn't confirmed. */
  dirty: boolean;
  unsynced: boolean;
};

/**
 * The server turned the page down: no access (any more), or the workspace wants two-step
 * verification first. Only the first also drops the offline copy (see collab/socket).
 */
const refusesPage = (reason: string | null) => reason !== null && reason !== COLLAB_UNAUTHORIZED;

/** A burst of typing is confirmed within this; only longer waits show "Syncing". */
const UNSYNCED_GRACE_MS = 1500;

/**
 * Opens the page's shared document; `synced` flips once there is content to show: the server's,
 * or the copy kept in this browser from an earlier visit (edits then merge when the server answers).
 */
export function usePageDoc(pageId: string) {
  const t = useTranslations("page.errors");
  const userId = useOffline()?.userId;
  const [state, setState] = useState<DocState>({
    pageDoc: null,
    synced: false,
    live: false,
    socket: "connecting",
    accessLost: false,
    tokenFailed: false,
    localReady: false,
    dirty: false,
    unsynced: false,
  });
  const [browserOffline, setBrowserOffline] = useState(false);

  useEffect(() => {
    const update = () => setBrowserOffline(!navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  useEffect(() => {
    const { shared, release } = acquireDoc(`page:${pageId}`, { offlineFor: userId });
    const { doc, provider, offline } = shared;
    const pageDoc: PageDoc = { doc, provider };
    const update = (change: (s: DocState) => Partial<DocState>) =>
      setState((s) => (s.pageDoc?.doc === doc ? { ...s, ...change(s) } : s));
    let unsyncedTimer: ReturnType<typeof setTimeout> | undefined;
    const readOffline = () => ({
      localReady: Boolean(offline?.loaded && offline.hadContent),
      dirty: offline?.dirty ?? false,
    });
    // A reused provider may already be synced and won't emit "synced" again.
    setState({
      pageDoc,
      synced: provider.isSynced,
      live: provider.isSynced,
      socket: provider.configuration.websocketProvider.status,
      accessLost: refusesPage(shared.denied),
      tokenFailed: shared.tokenFailed,
      ...readOffline(),
      unsynced: false,
    });
    const onSynced = () => update(() => ({ synced: true, live: true, tokenFailed: false }));
    const onStatus = ({ status }: onStatusParameters) =>
      update((s) => ({ socket: status, live: status === "connected" && s.live }));
    // A failed token fetch surfaces as an auth failure too; it is a connection problem, not lost access.
    const onAuthFailed = () =>
      update(() => (shared.tokenFailed || !refusesPage(shared.denied) ? { tokenFailed: true } : { accessLost: true }));
    const onUnsynced = ({ number }: { number: number }) => {
      clearTimeout(unsyncedTimer);
      if (number === 0) update(() => ({ unsynced: false }));
      else unsyncedTimer = setTimeout(() => update(() => ({ unsynced: true })), UNSYNCED_GRACE_MS);
    };
    provider.on("synced", onSynced);
    provider.on("status", onStatus);
    provider.on("authenticationFailed", onAuthFailed);
    provider.on("unsyncedChanges", onUnsynced);
    const stopOffline = offline?.on(() => update(readOffline));
    return () => {
      clearTimeout(unsyncedTimer);
      provider.off("synced", onSynced);
      provider.off("status", onStatus);
      provider.off("authenticationFailed", onAuthFailed);
      provider.off("unsyncedChanges", onUnsynced);
      stopOffline?.();
      release();
    };
  }, [pageId, userId]);

  const connection = syncState({
    accessLost: state.accessLost,
    socket: state.socket,
    tokenFailed: state.tokenFailed,
    browserOffline,
    serverSynced: state.live,
    ready: state.synced || state.localReady,
    unsynced: state.unsynced || (state.dirty && !state.live),
  });

  // Translated at render time so a language change also updates a message already shown.
  // Offline with a copy to work on, the header's status says enough.
  const error = state.accessLost
    ? t("accessLost")
    : state.tokenFailed && !state.localReady && !state.synced
      ? t("connectionFailed")
      : !state.synced && !state.localReady && connection === "offline"
        ? t("notAvailableOffline")
        : null;
  return {
    pageDoc: state.pageDoc,
    // An offline copy counts: the editor opens on it and merges with the server's state later.
    synced: !state.accessLost && (state.synced || state.localReady),
    connection,
    /** Edits made here are waiting for the server (shown with the offline state). */
    pendingEdits: state.dirty,
    error,
  };
}

/** Live title from the shared doc. */
export function useDocTitle(doc: Y.Doc | undefined, fallback: string) {
  return useSyncExternalStore(
    (onChange) => (doc ? observeDocTitle(doc, onChange) : () => {}),
    () => (doc && readDocTitle(doc)) ?? fallback,
    () => fallback,
  );
}

export function setDocTitle(doc: Y.Doc, title: string) {
  writeDocTitle(doc, title);
}

/**
 * Live page style from the shared doc. Pass the doc only once it has synced: an empty doc reads as
 * the defaults, and the page would jump from the server's value to them and back.
 */
export function usePageStyle(doc: Y.Doc | undefined, initial: PageStyle): PageStyle {
  const initialKey = pageStyleKey(initial);
  const key = useSyncExternalStore(
    (onChange) => (doc ? observePageStyle(doc, onChange) : () => {}),
    () => (doc ? pageStyleKey(readPageStyle(doc)) : initialKey),
    () => initialKey,
  );
  return useMemo(() => parsePageStyleKey(key), [key]);
}

const CURSOR_COLORS = ["#e5484d", "#f76b15", "#ffc53d", "#30a46c", "#12a594", "#0090ff", "#6e56cf", "#d6409f"];

export function userColor(userId: string) {
  let hash = 0;
  for (const ch of userId) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return CURSOR_COLORS[Math.abs(hash) % CURSOR_COLORS.length];
}

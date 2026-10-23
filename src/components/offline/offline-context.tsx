"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { getSocket, onSocketStatus, type SocketStatus } from "@/components/collab/socket";
import { REFRESH_MS, wantedPages } from "@/lib/offline";
import { holdDoc } from "./offline-doc";
import { onOfflineStateChange, readOfflineState, wipeOtherUsers } from "./offline-store";

type OfflineContextValue = {
  /** The signed-in user; offline copies are kept under their id. */
  userId: string;
  /** The server can't be reached (no network, or the connection dropped and hasn't come back). */
  offline: boolean;
};

const OfflineContext = createContext<OfflineContextValue | null>(null);

/** Null outside the signed-in app (published pages, print view): nothing is kept offline there. */
export function useOffline() {
  return useContext(OfflineContext);
}

/** Whether actions that need the server should be turned off right now. */
export function useIsOffline() {
  return useContext(OfflineContext)?.offline ?? false;
}

/**
 * Wraps the signed-in app: drops offline copies another user left in this browser, follows the
 * connection, sends edits that were made offline once it is back (see useBackgroundSync) and keeps
 * downloaded pages fresh (see useKeepDownloads).
 */
export function OfflineProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const offline = useServerUnreachable();
  useEffect(() => {
    void wipeOtherUsers(userId);
  }, [userId]);
  useBackgroundSync(userId, offline);
  useKeepDownloads(userId, offline);
  return <OfflineContext.Provider value={{ userId, offline }}>{children}</OfflineContext.Provider>;
}

/**
 * Offline once the browser says so or the websocket has dropped (and not until then: a page that
 * is still connecting for the first time isn't shown as offline). Back online when it reconnects.
 */
function useServerUnreachable() {
  const [browserOffline, setBrowserOffline] = useState(false);
  const [dropped, setDropped] = useState(false);
  useEffect(() => {
    const update = () => setBrowserOffline(!navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    const socket = getSocket();
    const onStatus = (status: SocketStatus) => {
      if (status === "connected") setDropped(false);
      else if (status === "disconnected") setDropped(true);
    };
    const stop = onSocketStatus(onStatus);
    if (socket.status === "connected") setDropped(false);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
      stop();
    };
  }, []);
  return browserOffline || dropped;
}

/** How long a page with unsent edits stays open in the background to send them. */
const SYNC_TIMEOUT_MS = 20_000;

/**
 * Pages edited offline and closed before the connection came back still hold their edits in this
 * browser. Whenever the app is online, open those documents one at a time in the background so
 * the edits reach the server (and other people) without the user opening each page again.
 */
function useBackgroundSync(userId: string, offline: boolean) {
  useEffect(() => {
    if (offline) return;
    let cancelled = false;
    const run = async () => {
      // Give the page on screen its connection first.
      await new Promise((r) => setTimeout(r, 1500));
      for (const pageId of readOfflineState(userId).dirty) {
        if (cancelled) return;
        await syncOne(userId, pageId);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [userId, offline]);
}

/** Refused (no access any more, or the session needs attention): left for later, or dropped. */
async function syncOne(userId: string, pageId: string) {
  await holdDoc(userId, pageId, (shared) => Boolean(shared.offline?.loaded && !shared.offline.dirty), SYNC_TIMEOUT_MS);
}

/**
 * Pages downloaded for offline use are fetched again while the app is online: a while after it
 * starts (after the page on screen and unsent edits), every REFRESH_MS, and right away when the
 * list changes (a page turned on in a menu, favorites changed, a copy removed in Settings).
 */
function useKeepDownloads(userId: string, offline: boolean) {
  useEffect(() => {
    if (offline) return;
    // The downloader loads only when there is something to download or clean up.
    const run = (background: boolean) => {
      if (wantedPages(readOfflineState(userId)).size === 0 && Object.keys(readOfflineState(userId).copies).length === 0) return;
      void import("./offline-download").then((m) => m.syncDownloads(userId, { background }));
    };
    const start = setTimeout(() => run(true), 4000);
    const every = setInterval(() => run(true), REFRESH_MS);
    const signature = () => {
      const state = readOfflineState(userId);
      return [...wantedPages(state).keys()].sort().join() + `|${state.kept.filter((p) => p.subpages).map((p) => p.id).join()}`;
    };
    let last = signature();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = onOfflineStateChange(() => {
      const now = signature();
      if (now === last) return;
      last = now;
      clearTimeout(timer);
      timer = setTimeout(() => run(false), 300);
    });
    return () => {
      clearTimeout(start);
      clearInterval(every);
      clearTimeout(timer);
      stop();
    };
  }, [userId, offline]);
}

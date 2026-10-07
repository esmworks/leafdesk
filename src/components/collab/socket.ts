"use client";

import { HocuspocusProvider, HocuspocusProviderWebsocket, type onStatusParameters } from "@hocuspocus/provider";
import { IndexeddbPersistence } from "y-indexeddb";
import * as Y from "yjs";
import { forgetOfflinePage, markDirty, readOfflineState } from "@/components/offline/offline-store";
import { BUILD_PARAM, CLIENT_BUILD } from "@/lib/build-id";
import { COLLAB_FRAGMENT } from "@/lib/collab-constants";
import { COLLAB_FORBIDDEN, COLLAB_STALE, pageStoreName } from "@/lib/offline";
import { markStale, noteServerBuild, onStale, whenFresh } from "./freshness";

let socket: HocuspocusProviderWebsocket | null = null;
// In memory only: collab tokens are never written to storage.
let cachedToken: { value: string; fetchedAt: number } | null = null;
const TOKEN_REUSE_MS = 30 * 60 * 1000; // server-side TTL is 60 minutes
const TOKEN_RETRY_MS = 5000;
/** How long a page waits for its offline copy before connecting without it. */
const OFFLINE_LOAD_TIMEOUT_MS = 1500;

export type SocketStatus = "connecting" | "connected" | "disconnected";
const statusListeners = new Set<(status: SocketStatus) => void>();

/** One websocket per tab; every page doc and signal channel is multiplexed over it. */
export function getSocket() {
  if (!socket) {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    // The server refuses a tab of another build (lib/build-id) before it sends any document.
    const query = CLIENT_BUILD ? `?${BUILD_PARAM}=${encodeURIComponent(CLIENT_BUILD)}` : "";
    const created = new HocuspocusProviderWebsocket({ url: `${protocol}://${window.location.host}/collab${query}` });
    created.on("status", ({ status }: onStatusParameters) => statusListeners.forEach((l) => l(status as SocketStatus)));
    // Reconnecting would only be refused again; the tab has to reload (components/collab/stale-client).
    onStale(() => created.disconnect());
    socket = created;
  }
  return socket;
}

/** Follows the websocket's status: whether the server is reachable right now. */
export function onSocketStatus(listener: (status: SocketStatus) => void) {
  statusListeners.add(listener);
  return () => void statusListeners.delete(listener);
}

async function getCollabToken(): Promise<string> {
  if (cachedToken && Date.now() - cachedToken.fetchedAt < TOKEN_REUSE_MS) return cachedToken.value;
  const res = await fetch("/api/collab-token", { cache: "no-store" });
  if (!res.ok) throw new Error("Could not obtain a collaboration token");
  const { token, build } = (await res.json()) as { token: string; build?: string | null };
  noteServerBuild(build);
  cachedToken = { value: token, fetchedAt: Date.now() };
  return token;
}

/** The page's copy in this browser (pages only, and only for a signed-in user). */
export type OfflineCopy = {
  /** Whatever was stored has been loaded into the doc (or there was nothing / no storage). */
  readonly loaded: boolean;
  /** The stored copy had a body: the page can be shown and edited before the server answers. */
  readonly hadContent: boolean;
  /** Edits made in this browser that the server hasn't confirmed yet. */
  readonly dirty: boolean;
  /** Pending changes the server hasn't acknowledged, as the provider counts them. */
  readonly unsynced: number;
  on(listener: () => void): () => void;
};

export type SharedDoc = {
  name: string;
  doc: Y.Doc;
  provider: HocuspocusProvider;
  onStateless: (listener: (payload: string) => void) => () => void;
  /** True while the last attempt to get a collab token failed (the provider then reports an auth failure). */
  readonly tokenFailed: boolean;
  /** Why the server last refused the document (see lib/offline COLLAB_*), if it did. */
  readonly denied: string | null;
  offline: OfflineCopy | null;
};

type Entry = SharedDoc & {
  refs: number;
  releaseTimer?: ReturnType<typeof setTimeout>;
  retryTimer?: ReturnType<typeof setTimeout>;
  persistence?: IndexeddbPersistence;
};

const entries = new Map<string, Entry>();

/**
 * Keep released providers alive briefly. Destroying a provider and re-attaching one for the
 * same document on a shared socket races on the server (the late close tears down the new
 * connection and later updates are silently dropped). React StrictMode and quick
 * back-and-forth navigation both do exactly that, so reuse instead of re-creating.
 */
const RELEASE_DELAY_MS = 3000;

/**
 * Acquires the shared provider for a document or signal channel. Call `release` when done.
 * `offlineFor`: the signed-in user, for a page doc that should keep a copy in this browser
 * (IndexedDB), so it opens and takes edits without a connection and sends them when it returns.
 */
export function acquireDoc(name: string, { offlineFor }: { offlineFor?: string } = {}): { shared: SharedDoc; release: () => void } {
  let entry = entries.get(name);
  if (entry) {
    clearTimeout(entry.releaseTimer);
    entry.releaseTimer = undefined;
  } else {
    const doc = new Y.Doc();
    const listeners = new Set<(payload: string) => void>();
    let tokenFailed = false;
    let denied: string | null = null;
    const provider = new HocuspocusProvider({
      websocketProvider: getSocket(),
      name,
      document: doc,
      token: async () => {
        clearTimeout(created.retryTimer);
        try {
          const token = await getCollabToken();
          tokenFailed = false;
          return token;
        } catch (error) {
          tokenFailed = true;
          // The provider only asks again after the socket reconnects, which may never happen on a
          // healthy socket. The server queues the sync messages until the token arrives.
          created.retryTimer = setTimeout(() => {
            if (provider.isAttached && !provider.isAuthenticated) void provider.sendToken();
          }, TOKEN_RETRY_MS);
          throw error;
        }
      },
      onStateless: ({ payload }) => listeners.forEach((l) => l(payload)),
      onAuthenticated: () => {
        denied = null;
      },
      onAuthenticationFailed: ({ reason }) => {
        denied = tokenFailed ? null : reason;
        if (reason === COLLAB_STALE) markStale();
      },
    });
    const created: Entry = {
      name,
      doc,
      provider,
      refs: 0,
      onStateless: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      get tokenFailed() {
        return tokenFailed;
      },
      get denied() {
        return denied;
      },
      offline: null,
    };
    entry = created;
    entries.set(name, entry);
    const pageId = /^page:([\w-]+)$/.exec(name)?.[1];
    if (offlineFor && pageId && typeof indexedDB !== "undefined") {
      created.offline = keepOfflineCopy(created, offlineFor, pageId);
    } else {
      // Providers sharing a socket are not attached automatically.
      provider.attach();
    }
  }
  const current = entry;
  current.refs++;
  let released = false;
  return {
    shared: current,
    release: () => {
      if (released) return;
      released = true;
      current.refs--;
      if (current.refs > 0) return;
      current.releaseTimer = setTimeout(() => {
        entries.delete(name);
        clearTimeout(current.retryTimer);
        current.provider.destroy();
        void current.persistence?.destroy();
        current.doc.destroy();
      }, RELEASE_DELAY_MS);
    },
  };
}

/**
 * Loads the page's stored copy into the doc before the provider connects, then keeps storing it.
 * Not in a tab of another build than the server's (lib/build-id): the copy may hold blocks a newer
 * tab of this browser wrote, which this bundle would delete as it renders them. Such a tab loads
 * nothing and never connects; it shows that it has to reload instead.
 * The order matters: attached first, the provider would send the whole stored copy to the server
 * as one new update, and the server refuses browser updates that touch comment threads (the copy
 * holds the threads it got from the server). Loaded first, the sync handshake sends only what the
 * server doesn't have: the edits made here.
 */
function keepOfflineCopy(entry: Entry, userId: string, pageId: string): OfflineCopy {
  const { doc, provider } = entry;
  const listeners = new Set<() => void>();
  // Later, not inside the change: an editor mounting during a React render can write to the doc
  // (it normalises what it loaded), and listeners set React state.
  let queued = false;
  const emit = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      listeners.forEach((l) => l());
    });
  };
  const state = {
    loaded: false,
    hadContent: false,
    dirty: readOfflineState(userId).dirty.includes(pageId),
    unsynced: 0,
  };
  let persistence: IndexeddbPersistence | undefined;
  let attached = false;
  const attach = () => {
    if (attached || !entries.has(entry.name)) return;
    attached = true;
    state.loaded = true;
    state.hadContent = doc.getXmlFragment(COLLAB_FRAGMENT).length > 0;
    provider.attach();
    emit();
  };
  void whenFresh(getCollabToken, OFFLINE_LOAD_TIMEOUT_MS).then((fresh) => {
    if (!fresh || entries.get(entry.name) !== entry) return;
    try {
      persistence = new IndexeddbPersistence(pageStoreName(userId, pageId), doc);
      entry.persistence = persistence;
    } catch {}
    if (persistence) {
      void persistence.whenSynced.then(attach);
      setTimeout(attach, OFFLINE_LOAD_TIMEOUT_MS);
    } else attach();
  });

  // Edits made here (not the server's, not the stored copy's) stay flagged until the server has
  // them, so they are sent even if the page isn't opened again (see useBackgroundSync).
  doc.on("update", (_update: Uint8Array, origin: unknown) => {
    if (origin === provider || origin === persistence || state.dirty) return;
    state.dirty = true;
    markDirty(userId, pageId, true);
    emit();
  });
  provider.on("unsyncedChanges", ({ number }: { number: number }) => {
    state.unsynced = number;
    if (number === 0 && provider.isSynced && state.dirty) {
      state.dirty = false;
      markDirty(userId, pageId, false);
    }
    emit();
  });
  provider.on("synced", emit);
  provider.on("authenticationFailed", () => {
    // Only when the page is gone or no longer shared: a stale copy must not stay readable here.
    // An expired session or a two-step prompt keeps it (and the edits in it) for later.
    if (entry.denied !== COLLAB_FORBIDDEN) return;
    state.dirty = false;
    const stored = persistence;
    persistence = undefined;
    entry.persistence = undefined;
    void Promise.resolve(stored?.destroy()).then(() => forgetOfflinePage(userId, pageId));
    emit();
  });

  return {
    get loaded() {
      return state.loaded;
    },
    get hadContent() {
      return state.hadContent;
    },
    get dirty() {
      return state.dirty;
    },
    get unsynced() {
      return state.unsynced;
    },
    on(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/** Closes every stored page copy (before sign-out wipes them; open databases would block that). */
export async function closeOfflineDocs() {
  await Promise.all(
    [...entries.values()].map(async (entry) => {
      const stored = entry.persistence;
      entry.persistence = undefined;
      await stored?.destroy();
    }),
  );
}

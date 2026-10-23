"use client";

/**
 * Downloads pages for offline use (lib/offline.ts says what is kept where) and keeps them fresh.
 * One run at a time per tab, and per browser through a Web Lock where there is one: the
 * background refresh skips a run while another tab does one.
 *
 * A download of one page: its Yjs document (synced into the page's IndexedDB copy through the
 * shared collab socket), its HTML (fetched by the service worker, which keeps it with the scripts
 * it loads), a database's rows or a row's values (the snapshots the database and row views read
 * offline), and the uploaded files it shows, each up to MAX_FILE_BYTES and MAX_PAGE_FILE_BYTES
 * together. Everything fails quietly: a page that couldn't be fetched is tried again next time.
 */
import { useSyncExternalStore } from "react";
import * as Y from "yjs";
import { loadDatabaseAction, loadRowAction } from "@/app/actions/databases";
import { getSidebarAction } from "@/app/actions/pages";
import { acquireDoc, isDocOpen, type SharedDoc } from "@/components/collab/socket";
import { rowSnapshotOf } from "@/components/database/row-snapshot";
import { COLLAB_FRAGMENT } from "@/lib/collab-constants";
import { fileIdsIn } from "@/lib/files";
import {
  COLLAB_FORBIDDEN,
  copiesDue,
  copiesToDrop,
  databaseSnapshotKey,
  descendantsOf,
  dropCopy,
  EMPTY_STATE,
  fileFits,
  filesOnlyIn,
  mayDropDocument,
  pageCacheName,
  pageStoreName,
  recordCopy,
  rowSnapshotKey,
  setChildren,
  wantedPages,
  META_CACHE,
  REFRESH_MS,
  type OfflinePage,
} from "@/lib/offline";
import {
  deleteDatabase,
  deleteSnapshot,
  dropCachedPage,
  forgetOfflinePage,
  readOfflineState,
  saveSnapshot,
  writeOfflineState,
} from "./offline-store";

/** How long one page's document may take to arrive. */
const DOC_TIMEOUT_MS = 20_000;
/** How long the service worker may take to fetch a page's HTML. */
const HTML_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------------------------
// What is downloading right now, for the menus and Settings > Offline.

let busy = new Set<string>();
const busyListeners = new Set<() => void>();
function setBusy(pageId: string, on: boolean) {
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

// ---------------------------------------------------------------------------------------------
// Documents.

/**
 * Opens a page's document with its offline copy, until `done` says it has what it waited for,
 * the server refuses it, or `ms` pass.
 */
export function holdDoc(
  userId: string,
  pageId: string,
  done: (shared: SharedDoc) => boolean,
  ms = DOC_TIMEOUT_MS,
): Promise<{ ok: boolean; denied: string | null; bytes: number; text: string }> {
  return new Promise((resolve) => {
    const { shared, release } = acquireDoc(`page:${pageId}`, { offlineFor: userId });
    const copy = shared.offline;
    let settled = false;
    let stop = () => {};
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
      shared.provider.off("authenticationFailed", refused);
      shared.provider.off("synced", check);
      const bytes = ok ? Y.encodeStateAsUpdate(shared.doc).byteLength : 0;
      const text = ok ? shared.doc.getXmlFragment(COLLAB_FRAGMENT).toString() : "";
      const denied = shared.denied;
      release();
      resolve({ ok, denied, bytes, text });
    };
    const refused = () => finish(false);
    const check = () => {
      if (done(shared)) finish(true);
    };
    const timer = setTimeout(() => finish(false), ms);
    if (!copy) return finish(false);
    stop = copy.on(check);
    shared.provider.on("synced", check);
    shared.provider.on("authenticationFailed", refused);
    check();
  });
}

/** The page's document is in this browser and matches the server's. */
const docSynced = (shared: SharedDoc) => Boolean(shared.offline?.loaded && shared.provider.isSynced);

// ---------------------------------------------------------------------------------------------
// One page.

type Outcome = "ok" | "gone" | "failed";

function pagePath(page: OfflinePage) {
  return `/w/${page.workspaceId}/p/${page.id}`;
}

/** Every downloaded page's path, for the service worker (it never drops those for newer pages). */
function keptPaths(userId: string) {
  return [...wantedPages(readOfflineState(userId)).values()].map(pagePath);
}

/**
 * Asks the service worker to fetch and keep pages' HTML (and to let go of pages no longer kept).
 * Resolves, by path, with the HTML's size, "gone", or null; empty without a service worker.
 */
function keepHtml(userId: string, fetchPaths: string[]): Promise<Record<string, number | "gone" | null>> {
  const worker = typeof navigator !== "undefined" ? navigator.serviceWorker?.controller : null;
  if (!worker) return Promise.resolve({});
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve({}), HTML_TIMEOUT_MS);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      resolve((event.data as Record<string, number | "gone" | null> | null) ?? {});
    };
    worker.postMessage({ type: "leafdesk-keep", owner: userId, kept: keptPaths(userId), fetch: fetchPaths }, [channel.port2]);
  });
}

/** Keeps the page's files in the per-user cache, as many as fit; returns their ids and bytes. */
async function keepFiles(userId: string, ids: string[]): Promise<{ files: string[]; bytes: number }> {
  if (typeof caches === "undefined") return { files: [], bytes: 0 };
  const cache = await caches.open(pageCacheName(userId));
  const files: string[] = [];
  let used = 0;
  for (const id of ids) {
    const path = `/api/files/${id}`;
    try {
      // The bytes behind an id never change: a file kept before needn't be fetched again.
      const kept = await cache.match(path);
      if (kept) {
        const size = (await kept.blob()).size;
        if (fileFits(size, used)) {
          files.push(id);
          used += size;
        }
        continue;
      }
      const controller = new AbortController();
      const response = await fetch(path, { credentials: "same-origin", signal: controller.signal });
      const declared = Number(response.headers.get("content-length") ?? NaN);
      if (!response.ok || (Number.isFinite(declared) && !fileFits(declared, used))) {
        controller.abort();
        continue;
      }
      const blob = await response.blob();
      if (!fileFits(blob.size, used)) continue;
      const headers = new Headers();
      for (const name of ["content-type", "content-disposition", "content-security-policy", "x-content-type-options", "x-frame-options"]) {
        const value = response.headers.get(name);
        if (value) headers.set(name, value);
      }
      await cache.put(path, new Response(blob, { headers }));
      files.push(id);
      used += blob.size;
    } catch {}
  }
  return { files, bytes: used };
}

async function downloadOne(userId: string, page: OfflinePage): Promise<Outcome> {
  let bytes = 0;
  let text = "";
  // The document: pages and rows have a body, databases don't.
  if (page.kind === "page") {
    const doc = await holdDoc(userId, page.id, docSynced);
    if (!doc.ok) return doc.denied === COLLAB_FORBIDDEN ? "gone" : "failed";
    bytes += doc.bytes;
    text += doc.text;
  }
  // The rows (or a row's values), read-only offline like the copies of databases opened before.
  try {
    if (page.kind === "database") {
      const res = await loadDatabaseAction(page.id, { covers: false });
      if (!res.ok) return "gone";
      await saveSnapshot(userId, databaseSnapshotKey(page.id, false), res.data);
      const json = JSON.stringify(res.data);
      bytes += json.length;
      text += json;
      // The rows become the database's sub-pages when it is kept with them.
      const rows = res.data.rows.map((r) => ({ id: r.id, workspaceId: page.workspaceId, title: r.title, icon: r.icon, kind: "page" as const, row: true }));
      writeOfflineState(userId, (s) => (s.kept.some((p) => p.id === page.id && p.subpages) ? setChildren(s, page.id, rows) : s));
    } else if (page.row) {
      const res = await loadRowAction(page.id);
      if (res.ok) {
        const snapshot = rowSnapshotOf(res.data);
        await saveSnapshot(userId, rowSnapshotKey(page.id), snapshot);
        const json = JSON.stringify(snapshot);
        bytes += json.length;
        text += json;
      }
    }
  } catch {
    return "failed";
  }
  const path = pagePath(page);
  const html = (await keepHtml(userId, [path]))[path];
  if (html === "gone") return "gone";
  if (typeof html === "number") bytes += html;
  const files = await keepFiles(userId, fileIdsIn(text));
  bytes += files.bytes;
  // Files the earlier copy had and no copy uses any more go.
  const before = readOfflineState(userId);
  const dropped = filesOnlyIn(before, page.id).filter((f) => !files.files.includes(f));
  writeOfflineState(userId, (s) =>
    wantedPages(s).has(page.id) ? recordCopy(s, page.id, { syncedAt: Date.now(), bytes, files: files.files }) : s,
  );
  if (dropped.length) await dropCachedPage(userId, null, dropped);
  return "ok";
}

/**
 * Lets go of a page's copy: its record, files no other copy uses, and its document and snapshots
 * unless it is still wanted, recently opened or holding unsent edits. The service worker drops its
 * HTML with the next list of kept pages.
 */
export async function removeCopy(userId: string, pageId: string) {
  const files = filesOnlyIn(readOfflineState(userId), pageId);
  writeOfflineState(userId, (s) => dropCopy(s, pageId));
  const state = readOfflineState(userId);
  await dropCachedPage(userId, null, files);
  if (!mayDropDocument(state, pageId)) return;
  if (!isDocOpen(`page:${pageId}`)) await deleteDatabase(pageStoreName(userId, pageId));
  await Promise.all([
    deleteSnapshot(userId, databaseSnapshotKey(pageId, false)),
    deleteSnapshot(userId, rowSnapshotKey(pageId)),
  ]);
}

/**
 * "Remove all offline copies": every page, document, snapshot and kept HTML of this user on this
 * device goes, unsent edits included. Keeping favorites offline stays as it was.
 */
export async function removeAllCopies(userId: string) {
  const keepFavorites = readOfflineState(userId).keepFavorites;
  writeOfflineState(userId, () => ({ ...EMPTY_STATE, keepFavorites }));
  try {
    const dbs = (await indexedDB.databases()).flatMap((d) => (d.name ? [d.name] : []));
    const prefix = pageStoreName(userId, "");
    await Promise.all(
      dbs.filter((n) => n.startsWith(prefix) && !isDocOpen(`page:${n.slice(prefix.length)}`)).map(deleteDatabase),
    );
  } catch {}
  await deleteDatabase(`leafdesk-${userId}-cache`);
  try {
    await Promise.all([caches.delete(pageCacheName(userId)), caches.delete(META_CACHE)]);
  } catch {}
}

// ---------------------------------------------------------------------------------------------
// Runs.

let running: Promise<void> | null = null;
let again = false;
let forced = new Set<string>();

/**
 * Brings the downloads in line with what is kept: finds kept pages' sub-pages, drops copies no
 * longer wanted, and downloads pages without a copy or with one older than REFRESH_MS (`force`:
 * these now, however fresh). A call during a run makes the run go round once more.
 */
export function syncDownloads(userId: string, { force = [], background = false }: { force?: string[]; background?: boolean } = {}) {
  for (const id of force) forced.add(id);
  if (running) {
    again = true;
    return running;
  }
  const run = async () => {
    do {
      again = false;
      await syncRound(userId);
    } while (again);
  };
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  running = (
    locks
      ? // A background run skips while another tab does one; one asked for waits its turn.
        locks.request("leafdesk-offline-downloads", { ifAvailable: background }, (lock) => (lock ? run() : undefined))
      : run()
  )
    .catch(() => {})
    .finally(() => {
      running = null;
    });
  return running;
}

async function syncRound(userId: string) {
  const now = Date.now();
  const force = forced;
  forced = new Set();
  // Sub-pages of kept pages, from the sidebar's tree; a database's rows come with its download.
  const state = readOfflineState(userId);
  const due = new Set(copiesDue(state, now, REFRESH_MS).map((p) => p.id));
  const trees = new Map<string, Parameters<typeof descendantsOf>[0] | null>();
  for (const root of state.kept) {
    if (!root.subpages || root.kind !== "page" || (!due.has(root.id) && !force.has(root.id) && root.children.length > 0)) continue;
    if (!trees.has(root.workspaceId)) {
      trees.set(root.workspaceId, await getSidebarAction(root.workspaceId).then((s) => s.tree, () => null));
    }
    const tree = trees.get(root.workspaceId);
    if (tree) writeOfflineState(userId, (s) => setChildren(s, root.id, descendantsOf(tree, root.id, root.workspaceId)));
  }
  for (const id of copiesToDrop(readOfflineState(userId))) await removeCopy(userId, id);
  // The service worker hears which pages stay even when nothing is fetched.
  await keepHtml(userId, []);
  const queue = [
    ...[...wantedPages(readOfflineState(userId)).values()].filter((p) => force.has(p.id)),
    ...copiesDue(readOfflineState(userId), now, REFRESH_MS).filter((p) => !force.has(p.id)),
  ];
  for (const page of queue) {
    // Removed meanwhile.
    if (!wantedPages(readOfflineState(userId)).has(page.id)) continue;
    setBusy(page.id, true);
    try {
      const outcome = await downloadOne(userId, page);
      if (outcome === "gone") await forgetOfflinePage(userId, page.id);
    } finally {
      setBusy(page.id, false);
    }
  }
  // A database kept with its rows found them just now: those come next, in another round.
  const tried = new Set(queue.map((p) => p.id));
  if (copiesDue(readOfflineState(userId), now, REFRESH_MS).some((p) => !tried.has(p.id))) again = true;
}

/** Asks the browser to keep this site's storage (once, when someone first downloads a page). */
export async function askToPersist() {
  try {
    if (navigator.storage && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {}
}

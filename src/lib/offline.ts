/**
 * Offline copies (issue #10): what the browser keeps so pages opened before stay readable and
 * editable without a connection. Everything is stored per signed-in user and wiped on sign-out,
 * when someone else signs in on the same browser, and (per page) when the server refuses the page.
 *
 * - IndexedDB `leafdesk-<userId>-page-<pageId>`: the page's Yjs document (y-indexeddb).
 * - IndexedDB `leafdesk-<userId>-cache`: last loaded sidebar trees and database rows (read-only).
 * - localStorage `leafdesk:offline:<userId>`: recently opened pages, pages with unsent edits, the
 *   pages downloaded for offline use and what was downloaded of each.
 * - Cache Storage `leafdesk-pages-<userId>`: the HTML of recently opened and downloaded pages
 *   (public/sw.js), and the small files downloaded pages show (`/api/files/<id>`).
 *
 * Recently opened pages come and go (the newest MAX_RECENT_PAGES keep their HTML). Downloaded pages
 * ("Available offline", the person's favorites unless they turn that off, and up to MAX_SUBPAGES
 * pages under a page downloaded with its sub-pages) stay until removed, and are downloaded again in
 * the background every REFRESH_MS while the app is open and online. All of it is per device.
 *
 * Pure helpers only; the browser side lives in components/offline.
 */

export const OFFLINE_DB_PREFIX = "leafdesk-";
export const PAGE_CACHE_PREFIX = "leafdesk-pages-";
export const META_CACHE = "leafdesk-meta";
export const OFFLINE_STATE_PREFIX = "leafdesk:offline:";

/** Meta tag the signed-in app renders, so the service worker files a page under its user. */
export const USER_MARKER = "leafdesk-user";

/** Reason the collab server gives when a page is gone or no longer shared with the user. */
export const COLLAB_FORBIDDEN = "forbidden";
/** The workspace wants two-step verification first; the page itself is still theirs. */
export const COLLAB_TWO_STEP = "two-step";
/** Members must sign in with the workspace's single sign-on first; the page is still theirs. */
export const COLLAB_SSO = "sso";
/** No valid collab token (e.g. the session expired). */
export const COLLAB_UNAUTHORIZED = "unauthorized";
/** The tab runs another build than the server: it must reload before it may load a page (lib/build-id). */
export const COLLAB_STALE = "stale-client";

/** At most this many recently opened pages keep a cached copy of their HTML. */
export const MAX_RECENT_PAGES = 50;
/** At most this many database (and row) snapshots are kept for offline reading, downloaded pages' aside. */
export const MAX_SNAPSHOTS = 30;
/** A page downloaded with its sub-pages takes at most this many of them along. */
export const MAX_SUBPAGES = 50;
/** At most this many favorites of a workspace are downloaded. */
export const MAX_FAVORITES = 100;
/** Files larger than this aren't downloaded with a page (they still open online). */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** All files of one page together stay under this. */
export const MAX_PAGE_FILE_BYTES = 50 * 1024 * 1024;
/** How often downloaded pages are fetched again while the app is open and online. */
export const REFRESH_MS = 15 * 60 * 1000;

/** Uploaded files, which downloaded pages keep; mirrored in public/sw.js (FILE_PATH). */
export const FILE_PATH = /^\/api\/files\/[\w-]+$/;

export const pageStoreName = (userId: string, pageId: string) => `${OFFLINE_DB_PREFIX}${userId}-page-${pageId}`;
export const snapshotStoreName = (userId: string) => `${OFFLINE_DB_PREFIX}${userId}-cache`;
export const pageCacheName = (userId: string) => `${PAGE_CACHE_PREFIX}${userId}`;
export const offlineStateKey = (userId: string) => `${OFFLINE_STATE_PREFIX}${userId}`;

/**
 * Whether an IndexedDB database, Cache Storage cache or localStorage key holds someone's offline
 * data (not the service worker's static files or its metadata, not other settings).
 */
export function isOfflineStore(name: string) {
  return (
    name.startsWith(PAGE_CACHE_PREFIX) ||
    name.startsWith(OFFLINE_STATE_PREFIX) ||
    /^leafdesk-.+-(?:page-.+|cache)$/.test(name)
  );
}

/**
 * Whether offline data belongs to someone other than `userId` (and must go): anything that isn't
 * named exactly after this user.
 */
export function belongsToSomeoneElse(name: string, userId: string) {
  if (!isOfflineStore(name)) return false;
  const own = [
    `${OFFLINE_DB_PREFIX}${userId}-page-`,
    snapshotStoreName(userId),
    pageCacheName(userId),
    offlineStateKey(userId),
  ];
  return !own.some((prefix) => name === prefix || (prefix.endsWith("-") && name.startsWith(prefix)));
}

/**
 * Signed-in pages whose HTML the service worker keeps: a workspace's home and its pages. Settings,
 * exports and everything else need the server anyway. Mirrored in public/sw.js (PAGE_PATH).
 */
export const PAGE_PATH = /^\/w\/[\w-]+(?:\/p\/[\w-]+)?\/?$/;

export function isCacheablePagePath(pathname: string) {
  return PAGE_PATH.test(pathname);
}

/** The user id in a page's `<meta name="leafdesk-user">`, if it has one. Mirrored in public/sw.js. */
export function readUserMarker(html: string): string | null {
  const match = /<meta\s+name="leafdesk-user"\s+content="([\w-]+)"/.exec(html);
  return match ? match[1] : null;
}

export type RecentPage = { id: string; workspaceId: string; title: string; icon: string | null; at: number };

/** A page as the downloads know it: enough to list it and to fetch it again. */
export type OfflinePage = {
  id: string;
  workspaceId: string;
  title: string;
  icon: string | null;
  kind: "page" | "database";
  /** A database row: its property values are downloaded too. */
  row: boolean;
};

/** A page downloaded for offline use, and why. */
export type KeptPage = OfflinePage & {
  /** Turned on with "Available offline". */
  manual: boolean;
  /** One of the person's favorites (while they keep favorites offline). */
  favorite: boolean;
  /** Downloaded with the pages under it (or a database's rows), up to MAX_SUBPAGES. */
  subpages: boolean;
  /** Those pages, as last found. */
  children: OfflinePage[];
  /** When it was first kept; the list's order. */
  at: number;
};

/** What was downloaded of one page (a kept page or one under it). */
export type PageCopy = {
  syncedAt: number;
  /** About how much it takes on this device: document, HTML, rows and files. */
  bytes: number;
  /** The uploaded files kept with it. */
  files: string[];
};

export type OfflineState = {
  /** Most recent first. */
  recent: RecentPage[];
  /** Pages with edits made here that the server hasn't confirmed yet. */
  dirty: string[];
  /** Pages downloaded for offline use on this device, oldest first. */
  kept: KeptPage[];
  /** By page id: what was downloaded of kept pages and the pages under them. */
  copies: Record<string, PageCopy>;
  /** Download the person's favorites too (per device, on unless turned off). */
  keepFavorites: boolean;
};

export const EMPTY_STATE: OfflineState = { recent: [], dirty: [], kept: [], copies: {}, keepFavorites: true };

export function parseOfflineState(raw: string | null): OfflineState {
  if (!raw) return EMPTY_STATE;
  try {
    const value = JSON.parse(raw) as Partial<OfflineState>;
    const copies: Record<string, PageCopy> = {};
    if (value.copies && typeof value.copies === "object") {
      for (const [id, copy] of Object.entries(value.copies)) if (isCopy(copy)) copies[id] = copy;
    }
    return {
      recent: Array.isArray(value.recent) ? value.recent.filter(isRecentPage) : [],
      dirty: Array.isArray(value.dirty) ? value.dirty.filter((id): id is string => typeof id === "string") : [],
      kept: Array.isArray(value.kept)
        ? value.kept.filter(isKeptPage).map((p) => ({ ...p, children: p.children.filter(isOfflinePage) }))
        : [],
      copies,
      keepFavorites: value.keepFavorites !== false,
    };
  } catch {
    return EMPTY_STATE;
  }
}

function isRecentPage(value: unknown): value is RecentPage {
  const v = value as RecentPage;
  return !!v && typeof v.id === "string" && typeof v.workspaceId === "string" && typeof v.title === "string" && typeof v.at === "number";
}

function isOfflinePage(value: unknown): value is OfflinePage {
  const v = value as OfflinePage;
  return (
    !!v &&
    typeof v.id === "string" &&
    typeof v.workspaceId === "string" &&
    typeof v.title === "string" &&
    (v.icon === null || typeof v.icon === "string") &&
    (v.kind === "page" || v.kind === "database") &&
    typeof v.row === "boolean"
  );
}

function isKeptPage(value: unknown): value is KeptPage {
  const v = value as KeptPage;
  return (
    isOfflinePage(v) &&
    typeof v.manual === "boolean" &&
    typeof v.favorite === "boolean" &&
    typeof v.subpages === "boolean" &&
    Array.isArray(v.children) &&
    typeof v.at === "number"
  );
}

function isCopy(value: unknown): value is PageCopy {
  const v = value as PageCopy;
  return !!v && typeof v.syncedAt === "number" && typeof v.bytes === "number" && Array.isArray(v.files) && v.files.every((f) => typeof f === "string");
}

/** Puts a page first in the recent list (once), keeping at most `max`. */
export function rememberRecent(list: RecentPage[], entry: RecentPage, max = MAX_RECENT_PAGES): RecentPage[] {
  return [entry, ...list.filter((p) => p.id !== entry.id)].slice(0, max);
}

/** The page is gone or no longer the person's: nothing of it stays, kept or not. */
export function forgetPage(state: OfflineState, pageId: string): OfflineState {
  const copies = { ...state.copies };
  delete copies[pageId];
  return {
    ...state,
    recent: state.recent.filter((p) => p.id !== pageId),
    dirty: state.dirty.filter((id) => id !== pageId),
    kept: state.kept
      .filter((p) => p.id !== pageId)
      .map((p) => (p.children.some((c) => c.id === pageId) ? { ...p, children: p.children.filter((c) => c.id !== pageId) } : p)),
    copies,
  };
}

export function setDirty(state: OfflineState, pageId: string, dirty: boolean): OfflineState {
  const has = state.dirty.includes(pageId);
  if (has === dirty) return state;
  return { ...state, dirty: dirty ? [...state.dirty, pageId] : state.dirty.filter((id) => id !== pageId) };
}

/**
 * Turns a reason to keep a page on or off. A page no reason keeps any more leaves the list (its
 * copy goes with the next clean-up, see copiesToDrop).
 */
export function keepPage(
  state: OfflineState,
  page: OfflinePage,
  change: { manual?: boolean; favorite?: boolean; subpages?: boolean },
  now = Date.now(),
): OfflineState {
  const current = state.kept.find((p) => p.id === page.id);
  const { id, workspaceId, title, icon, kind, row } = page;
  const next: KeptPage = {
    ...(current ?? { manual: false, favorite: false, subpages: false, children: [], at: now }),
    ...{ id, workspaceId, title, icon, kind, row },
    ...change,
  };
  if (!next.subpages) next.children = [];
  const kept = next.manual || next.favorite;
  if (!current && !kept) return state;
  const list = kept
    ? current
      ? state.kept.map((p) => (p.id === page.id ? next : p))
      : [...state.kept, next]
    : state.kept.filter((p) => p.id !== page.id);
  return { ...state, kept: list };
}

/** Records the pages found under a kept page (at most `max`). */
export function setChildren(state: OfflineState, pageId: string, children: OfflinePage[], max = MAX_SUBPAGES): OfflineState {
  const list = children.filter((c) => c.id !== pageId).slice(0, max);
  return { ...state, kept: state.kept.map((p) => (p.id === pageId && p.subpages ? { ...p, children: list } : p)) };
}

/**
 * Makes a workspace's favorites (as the sidebar last loaded them) the kept favorites of that
 * workspace: new ones are added, ones no longer starred lose that reason. Other workspaces' are
 * left alone. With favorites not kept offline, none are. Returns `state` itself when nothing changes.
 */
export function reconcileFavorites(
  state: OfflineState,
  workspaceId: string,
  favorites: Omit<OfflinePage, "workspaceId" | "row">[],
  max = MAX_FAVORITES,
): OfflineState {
  const wanted = state.keepFavorites ? favorites.slice(0, max) : [];
  let next = state;
  for (const p of state.kept) {
    if (p.workspaceId !== workspaceId || !p.favorite) continue;
    if (!wanted.some((f) => f.id === p.id)) next = keepPage(next, p, { favorite: false });
  }
  for (const f of wanted) {
    const current = next.kept.find((p) => p.id === f.id);
    if (current?.favorite && current.title === f.title && current.icon === f.icon) continue;
    next = keepPage(next, { ...f, workspaceId, row: current?.row ?? false }, { favorite: true });
  }
  return next;
}

/** Turns keeping favorites offline on or off; off, pages kept only as favorites leave the list. */
export function setKeepFavorites(state: OfflineState, on: boolean): OfflineState {
  if (state.keepFavorites === on) return state;
  let next: OfflineState = { ...state, keepFavorites: on };
  if (!on) for (const p of state.kept) if (p.favorite) next = keepPage(next, p, { favorite: false });
  return next;
}

/** Every page that should have a downloaded copy: the kept pages and the pages under them. */
export function wantedPages(state: OfflineState): Map<string, OfflinePage & { root: string }> {
  const wanted = new Map<string, OfflinePage & { root: string }>();
  for (const p of state.kept) {
    const { id, workspaceId, title, icon, kind, row } = p;
    wanted.set(id, { id, workspaceId, title, icon, kind, row, root: id });
  }
  for (const p of state.kept) {
    for (const c of p.children) if (!wanted.has(c.id)) wanted.set(c.id, { ...c, root: p.id });
  }
  return wanted;
}

/** Whether the page has (or should have) a downloaded copy, kept itself or under a kept page. */
export function isKeptOffline(state: OfflineState, pageId: string) {
  return state.kept.some((p) => p.id === pageId || p.children.some((c) => c.id === pageId));
}

/** Wanted pages without a copy, or whose copy is `every` old: the next ones to download. */
export function copiesDue(state: OfflineState, now: number, every = REFRESH_MS): OfflinePage[] {
  return [...wantedPages(state).values()].filter((p) => {
    const copy = state.copies[p.id];
    return !copy || now - copy.syncedAt >= every;
  });
}

/** Copies no kept page wants any more. */
export function copiesToDrop(state: OfflineState): string[] {
  const wanted = wantedPages(state);
  return Object.keys(state.copies).filter((id) => !wanted.has(id));
}

/**
 * Whether a page's own document may be deleted from this device once its copy goes: not while it
 * is still wanted, among the recently opened pages, or holding edits the server hasn't got.
 */
export function mayDropDocument(state: OfflineState, pageId: string) {
  return !wantedPages(state).has(pageId) && !state.recent.some((p) => p.id === pageId) && !state.dirty.includes(pageId);
}

/** Files of a copy that no other copy uses (and that can go with it). */
export function filesOnlyIn(state: OfflineState, pageId: string): string[] {
  const others = new Set(Object.entries(state.copies).flatMap(([id, c]) => (id === pageId ? [] : c.files)));
  return (state.copies[pageId]?.files ?? []).filter((f) => !others.has(f));
}

export function recordCopy(state: OfflineState, pageId: string, copy: PageCopy): OfflineState {
  return { ...state, copies: { ...state.copies, [pageId]: copy } };
}

export function dropCopy(state: OfflineState, pageId: string): OfflineState {
  if (!(pageId in state.copies)) return state;
  const copies = { ...state.copies };
  delete copies[pageId];
  return { ...state, copies };
}

/** Whether a file of `bytes` still fits beside the `used` bytes of a page's other files. */
export function fileFits(bytes: number, used: number, perFile = MAX_FILE_BYTES, total = MAX_PAGE_FILE_BYTES) {
  return Number.isFinite(bytes) && bytes >= 0 && bytes <= perFile && used + bytes <= total;
}

/**
 * The pages under a page in a sidebar tree, nearest first (breadth first), at most `max`.
 * Databases come along with their rows' snapshot; pages under them aren't in the tree.
 */
export function descendantsOf(
  tree: { id: string; parentId: string | null; title: string; icon: string | null; kind: "page" | "database" }[],
  rootId: string,
  workspaceId: string,
  max = MAX_SUBPAGES,
): OfflinePage[] {
  const byParent = new Map<string, typeof tree>();
  for (const node of tree) {
    if (!node.parentId) continue;
    const list = byParent.get(node.parentId) ?? [];
    list.push(node);
    byParent.set(node.parentId, list);
  }
  const found: OfflinePage[] = [];
  const seen = new Set([rootId]);
  const queue = [rootId];
  while (queue.length > 0 && found.length < max) {
    for (const node of byParent.get(queue.shift()!) ?? []) {
      if (seen.has(node.id) || found.length >= max) continue;
      seen.add(node.id);
      found.push({ id: node.id, workspaceId, title: node.title, icon: node.icon, kind: node.kind, row: false });
      queue.push(node.id);
    }
  }
  return found;
}

/** One kept page as Settings > Offline lists it: with the pages under it. */
export type KeptSummary = {
  page: KeptPage;
  /** Bytes of its copy and its sub-pages' copies. */
  bytes: number;
  /** When the oldest of those copies was made; null while one is still missing. */
  syncedAt: number | null;
  /** Some of them have edits the server hasn't got. */
  unsent: boolean;
};

export function keptSummaries(state: OfflineState): KeptSummary[] {
  return state.kept.map((page) => {
    const ids = [page.id, ...page.children.map((c) => c.id)];
    const copies = ids.map((id) => state.copies[id]);
    return {
      page,
      bytes: copies.reduce((sum, c) => sum + (c?.bytes ?? 0), 0),
      syncedAt: copies.every(Boolean) ? Math.min(...copies.map((c) => c!.syncedAt)) : null,
      unsent: ids.some((id) => state.dirty.includes(id)),
    };
  });
}

export const treeSnapshotKey = (workspaceId: string) => `tree:${workspaceId}`;
export const databaseSnapshotKey = (databaseId: string, covers: boolean) => `db:${databaseId}${covers ? ":covers" : ""}`;
export const rowSnapshotKey = (rowId: string) => `row:${rowId}`;

/** Snapshots downloaded pages need (their rows, a row's values) and the sidebar trees: never evicted. */
export function keptSnapshotKeys(state: OfflineState): Set<string> {
  const keys = new Set<string>();
  for (const p of wantedPages(state).values()) {
    if (p.kind === "database") keys.add(databaseSnapshotKey(p.id, false));
    if (p.row) keys.add(rowSnapshotKey(p.id));
  }
  return keys;
}

/**
 * Keeps the newest `max` snapshot keys; returns the ones to delete. Sidebar trees and the keys in
 * `keep` (downloaded pages') never go and don't count.
 */
export function snapshotsToEvict(
  entries: { key: string; savedAt: number }[],
  max = MAX_SNAPSHOTS,
  keep: Set<string> = new Set(),
): string[] {
  return entries
    .filter((e) => !keep.has(e.key) && !e.key.startsWith("tree:"))
    .sort((a, b) => b.savedAt - a.savedAt)
    .slice(max)
    .map((e) => e.key);
}

export type SyncState = "live" | "syncing" | "connecting" | "reconnecting" | "offline" | "noAccess" | "notSaved";

/**
 * What the page header shows about the page's connection.
 * `ready`: the editor has content (from the server, or the offline copy).
 * `unsynced`: edits made here are waiting for the server's confirmation (for a while, so typing
 * doesn't flicker it).
 * `saveFailed`: the server said its last save of the page failed (collab/service.ts), so edits it
 * has aren't stored yet.
 */
export function syncState(input: {
  accessLost: boolean;
  socket: "connecting" | "connected" | "disconnected";
  tokenFailed: boolean;
  browserOffline: boolean;
  serverSynced: boolean;
  ready: boolean;
  unsynced: boolean;
  saveFailed?: boolean;
}): SyncState {
  if (input.accessLost) return "noAccess";
  if (input.browserOffline || input.socket === "disconnected" || input.tokenFailed) return "offline";
  if (input.socket === "connecting") return input.ready ? "reconnecting" : "connecting";
  if (input.saveFailed) return "notSaved";
  if (!input.serverSynced) return input.ready ? "syncing" : "connecting";
  return input.unsynced ? "syncing" : "live";
}

/**
 * Offline copies (issue #10): what the browser keeps so pages opened before stay readable and
 * editable without a connection. Everything is stored per signed-in user and wiped on sign-out,
 * when someone else signs in on the same browser, and (per page) when the server refuses the page.
 *
 * - IndexedDB `leafdesk-<userId>-page-<pageId>`: the page's Yjs document (y-indexeddb).
 * - IndexedDB `leafdesk-<userId>-cache`: last loaded sidebar trees and database rows (read-only).
 * - localStorage `leafdesk:offline:<userId>`: recently opened pages and pages with unsent edits.
 * - Cache Storage `leafdesk-pages-<userId>`: the HTML of recently opened pages (public/sw.js).
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
/** At most this many database (and row) snapshots are kept for offline reading. */
export const MAX_SNAPSHOTS = 30;

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

export type OfflineState = {
  /** Most recent first. */
  recent: RecentPage[];
  /** Pages with edits made here that the server hasn't confirmed yet. */
  dirty: string[];
};

export const EMPTY_STATE: OfflineState = { recent: [], dirty: [] };

export function parseOfflineState(raw: string | null): OfflineState {
  if (!raw) return EMPTY_STATE;
  try {
    const value = JSON.parse(raw) as Partial<OfflineState>;
    return {
      recent: Array.isArray(value.recent) ? value.recent.filter(isRecentPage) : [],
      dirty: Array.isArray(value.dirty) ? value.dirty.filter((id): id is string => typeof id === "string") : [],
    };
  } catch {
    return EMPTY_STATE;
  }
}

function isRecentPage(value: unknown): value is RecentPage {
  const v = value as RecentPage;
  return !!v && typeof v.id === "string" && typeof v.workspaceId === "string" && typeof v.title === "string" && typeof v.at === "number";
}

/** Puts a page first in the recent list (once), keeping at most `max`. */
export function rememberRecent(list: RecentPage[], entry: RecentPage, max = MAX_RECENT_PAGES): RecentPage[] {
  return [entry, ...list.filter((p) => p.id !== entry.id)].slice(0, max);
}

export function forgetPage(state: OfflineState, pageId: string): OfflineState {
  return { recent: state.recent.filter((p) => p.id !== pageId), dirty: state.dirty.filter((id) => id !== pageId) };
}

export function setDirty(state: OfflineState, pageId: string, dirty: boolean): OfflineState {
  const has = state.dirty.includes(pageId);
  if (has === dirty) return state;
  return { ...state, dirty: dirty ? [...state.dirty, pageId] : state.dirty.filter((id) => id !== pageId) };
}

/** Keeps the newest `max` snapshot keys; returns the ones to delete. */
export function snapshotsToEvict(entries: { key: string; savedAt: number }[], max = MAX_SNAPSHOTS): string[] {
  return [...entries]
    .sort((a, b) => b.savedAt - a.savedAt)
    .slice(max)
    .map((e) => e.key);
}

export type SyncState = "live" | "syncing" | "connecting" | "reconnecting" | "offline" | "noAccess";

/**
 * What the page header shows about the page's connection.
 * `ready`: the editor has content (from the server, or the offline copy).
 * `unsynced`: edits made here are waiting for the server's confirmation (for a while, so typing
 * doesn't flicker it).
 */
export function syncState(input: {
  accessLost: boolean;
  socket: "connecting" | "connected" | "disconnected";
  tokenFailed: boolean;
  browserOffline: boolean;
  serverSynced: boolean;
  ready: boolean;
  unsynced: boolean;
}): SyncState {
  if (input.accessLost) return "noAccess";
  if (input.browserOffline || input.socket === "disconnected" || input.tokenFailed) return "offline";
  if (input.socket === "connecting") return input.ready ? "reconnecting" : "connecting";
  if (!input.serverSynced) return input.ready ? "syncing" : "connecting";
  return input.unsynced ? "syncing" : "live";
}

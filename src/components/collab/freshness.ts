import { CLIENT_BUILD, isForeignBuild, SEEN_BUILD_KEY } from "@/lib/build-id";

/**
 * Whether this tab still runs the server's build (see lib/build-id for why a foreign one must not
 * load a page). Five ways to find out it doesn't:
 * - the collab server refuses it (socket.ts: every reconnect after a redeploy goes through that);
 * - the collab token reply names another build (asked before a page's offline copy is loaded);
 * - the same reply asked as the tab comes back into view (watchServerBuild), for the screens with
 *   no page document: the Mail tab, the inbox, settings;
 * - the server answers a server action as one it doesn't have (watchServerActions: a new build has
 *   other action ids), which is how a tab on such a screen that keeps working learns of a release;
 * - another tab of this browser met a server with another build (localStorage), which is all there
 *   is to go on offline, when the cached HTML of an older build may be what opened.
 * Once stale, a tab stays stale until it reloads.
 */

let stale = false;
let confirmed = false;
const listeners = new Set<() => void>();

export function isStale() {
  return stale;
}

export function onStale(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function markStale() {
  if (stale) return;
  stale = true;
  listeners.forEach((l) => l());
}

/** The server's build, from the collab token reply. */
export function noteServerBuild(build: string | null | undefined) {
  if (!CLIENT_BUILD || !build) return;
  if (isForeignBuild(CLIENT_BUILD, build)) return markStale();
  confirmed = true;
  try {
    localStorage.setItem(SEEN_BUILD_KEY, CLIENT_BUILD);
  } catch {}
}

function storedBuild() {
  try {
    return localStorage.getItem(SEEN_BUILD_KEY);
  } catch {
    // Storage can be blocked outright (Safari private browsing, blocked site data).
    return null;
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === SEEN_BUILD_KEY && isForeignBuild(CLIENT_BUILD, event.newValue)) markStale();
  });
}

/**
 * Next's request header naming the server action called, and the header of its answer when the
 * server has no such action (next/dist/client/components/app-router-headers; freshness.test checks
 * they still match). Every action call goes out as a `fetch` carrying the first.
 */
export const ACTION_HEADER = "next-action";
export const ACTION_NOT_FOUND_HEADER = "x-nextjs-action-not-found";

/** The error a stale tab's server action fails with before it is sent. */
export const STALE_ACTION_MESSAGE = "This tab runs another build than the server and has to reload";

function callsAction(input: RequestInfo | URL, init?: RequestInit): boolean {
  const headers = init?.headers ?? (typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined);
  if (!headers) return false;
  try {
    return new Headers(headers).has(ACTION_HEADER);
  } catch {
    return false;
  }
}

/**
 * Wraps `fetch` to see every server action this tab calls. One the server answers as unknown
 * (a release gave the actions new ids) marks the tab stale: the caller gets Next's error as before,
 * and the person the "Leafdesk has been updated" screen instead of a failure out of nowhere. Once
 * stale, no further action is sent: the server would only refuse each one again, with an error in
 * its log every time. Other requests pass through untouched.
 */
export function watchServerActions(fetchImpl: typeof fetch): typeof fetch {
  return async (input, init) => {
    if (!callsAction(input, init)) return fetchImpl(input, init);
    if (stale) throw new Error(STALE_ACTION_MESSAGE);
    const res = await fetchImpl(input, init);
    if (res.headers.get(ACTION_NOT_FOUND_HEADER) === "1") markStale();
    return res;
  };
}

// Installed once as the module loads, for the tab's whole life: an effect's cleanup restoring an
// earlier `fetch` would undo whatever wrapped it in between. Never in development (no build).
if (typeof window !== "undefined" && CLIENT_BUILD && typeof window.fetch === "function") {
  window.fetch = watchServerActions(window.fetch);
}

/**
 * Resolves false when this tab must not load a page document. `askServer` should end up calling
 * noteServerBuild; without an answer within `waitMs` (offline, a slow network) the tab goes by what
 * other tabs of this browser last confirmed. Nothing known means fresh: never lock anyone out on
 * missing information.
 */
export async function whenFresh(askServer: () => Promise<unknown>, waitMs: number): Promise<boolean> {
  if (!stale && CLIENT_BUILD && !confirmed) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([askServer().catch(() => {}), new Promise((resolve) => (timer = setTimeout(resolve, waitMs)))]);
    clearTimeout(timer);
    if (!confirmed && isForeignBuild(CLIENT_BUILD, storedBuild())) markStale();
  }
  return !stale;
}

/** Least time between two checks of watchServerBuild. */
const CHECK_GAP_MS = 60_000;
/** How often a tab left in view checks anyway. */
const CHECK_EVERY_MS = 15 * 60_000;

async function askServerBuild() {
  const res = await fetch("/api/collab-token", { cache: "no-store" });
  if (res.ok) noteServerBuild(((await res.json()) as { build?: string | null }).build);
}

/**
 * Asks the server's build whenever this tab comes back into view (an installed app brought back
 * from the background, a window focused again) or back online, and now and then while it stays in
 * view. A tab on a page learns of a release from its websocket; the other screens never would,
 * and their server actions would fail as unknown to the new build. Returns the cleanup.
 */
export function watchServerBuild(askServer: () => Promise<unknown> = askServerBuild): () => void {
  if (!CLIENT_BUILD) return () => {};
  // The page has just loaded from the server: nothing to ask yet.
  let last = Date.now();
  const check = () => {
    if (stale || document.visibilityState !== "visible" || !navigator.onLine) return;
    if (Date.now() - last < CHECK_GAP_MS) return;
    last = Date.now();
    void askServer().catch(() => {});
  };
  const events = ["focus", "online", "pageshow"] as const;
  events.forEach((e) => window.addEventListener(e, check));
  document.addEventListener("visibilitychange", check);
  const timer = setInterval(check, CHECK_EVERY_MS);
  return () => {
    events.forEach((e) => window.removeEventListener(e, check));
    document.removeEventListener("visibilitychange", check);
    clearInterval(timer);
  };
}

import { CLIENT_BUILD, isForeignBuild, SEEN_BUILD_KEY } from "@/lib/build-id";

/**
 * Whether this tab still runs the server's build (see lib/build-id for why a foreign one must not
 * load a page). Four ways to find out it doesn't:
 * - the collab server refuses it (socket.ts: every reconnect after a redeploy goes through that);
 * - the collab token reply names another build (asked before a page's offline copy is loaded);
 * - the same reply asked as the tab comes back into view (watchServerBuild), for the screens with
 *   no page document: the Mail tab, the inbox, settings;
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

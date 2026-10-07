import { CLIENT_BUILD, isForeignBuild, SEEN_BUILD_KEY } from "@/lib/build-id";

/**
 * Whether this tab still runs the server's build (see lib/build-id for why a foreign one must not
 * load a page). Three ways to find out it doesn't:
 * - the collab server refuses it (socket.ts: every reconnect after a redeploy goes through that);
 * - the collab token reply names another build (asked before a page's offline copy is loaded);
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

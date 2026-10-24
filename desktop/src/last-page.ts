/**
 * The page the main window showed last, opened again when the app starts. Only a page of the
 * workspace (`/w/<workspace>/p/<page>`), and only on the server it was on: `server` is the
 * connected server's origin, or "local" for Leafdesk on this computer (whose port may change).
 * The path is all that is kept, so the window can't be sent anywhere else by it.
 */

export type LastPage = { server: string; path: string };

const PAGE_PATH = /^\/w\/[\w-]{1,100}\/p\/[\w-]{1,100}$/;

/** What to remember of `url`, which the window shows from `origin`; null for anything but a page there. */
export function pageToRemember(url: string, origin: string | undefined, server: string | undefined): LastPage | null {
  if (!origin || !server) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.origin !== origin || !PAGE_PATH.test(parsed.pathname)) return null;
  return { server, path: parsed.pathname };
}

/** Where the main window starts on `server`: the page last open there, else the server's home. */
export function startPath(saved: LastPage | undefined, server: string | undefined): string {
  return saved && server && saved.server === server && PAGE_PATH.test(saved.path) ? saved.path : "/";
}

/** The remembered page from the settings file, if it is one. */
export function readLastPage(value: unknown): LastPage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { server, path } = value as Partial<LastPage>;
  return typeof server === "string" && server && typeof path === "string" && PAGE_PATH.test(path) ? { server, path } : undefined;
}

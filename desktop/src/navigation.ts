/**
 * Where the window may go. Leafdesk's own pages stay in it, and so do other web pages it moves to
 * on its own (single sign-on): their cookies have to land in this app, not in the system's browser.
 * Signing in to a service for a connection or for storage is the exception: it happens in the
 * system's browser, where the person is likely signed in to the service already, and the server
 * hands the answer back to the app with a `leafdesk://` link (see `signInReturn`). Links Leafdesk
 * opens in a new tab go to the system's browser, unless they lead back into Leafdesk, which gets a
 * window of its own.
 */

export type NavigationDecision = "allow" | "external" | "deny";
export type NewWindowDecision = "window" | "external" | "deny";

const EXTERNAL_SCHEMES = new Set(["mailto:", "tel:"]);

/** The app's own links (electron-builder.yml registers the scheme). */
export const APP_SCHEME = "leafdesk";

/**
 * The server's addresses a service sends the browser back to after signing in, by the name the
 * server's hand-over page gives them (src/app/(auth)/back-to-app).
 */
const SIGN_IN_RETURNS = new Map([
  ["connections", "/api/connections/oauth/callback"],
  ["storage", "/api/storage/oauth/callback"],
]);
/** What a service's answer carries back (RFC 6749 4.1.2, RFC 9207). */
const ANSWER_PARAMS = ["state", "code", "iss", "error"];

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function isWeb(url: URL) {
  return url.protocol === "https:" || url.protocol === "http:";
}

/**
 * A navigation of the window itself; `localPages` is the file URL its own pages start with, `server`
 * the origin of the pages the window shows.
 */
export function decideNavigation(target: string, localPages: string, server?: string): NavigationDecision {
  const url = parse(target);
  if (!url) return "deny";
  if (isWeb(url)) return isServiceSignIn(url, server) ? "external" : "allow";
  if (url.protocol === "file:") return target.startsWith(localPages) ? "allow" : "deny";
  return EXTERNAL_SCHEMES.has(url.protocol) ? "external" : "deny";
}

/** A page asking for a new window (`window.open`, a link with `target="_blank"`). */
export function decideNewWindow(target: string, server: string | undefined): NewWindowDecision {
  const url = parse(target);
  if (!url) return "deny";
  if (isWeb(url)) return server && url.origin === server ? "window" : "external";
  return EXTERNAL_SCHEMES.has(url.protocol) ? "external" : "deny";
}

/**
 * Whether a new window of the server's shows one of its files (a PDF, an image, an export) rather
 * than a Leafdesk page: everything under `/api/`. Such a window keeps the system's title bar, since
 * the browser's own viewer neither leaves room for the window's buttons nor gives a strip to move
 * the window by.
 */
export function showsFile(target: string) {
  return parse(target)?.pathname.startsWith("/api/") ?? false;
}

/** Whether a page belongs to the connected server, for permissions it asks for. */
export function isServerPage(url: string | undefined, server: string | undefined) {
  if (!url || !server) return false;
  return parse(url)?.origin === server;
}

/** A service's sign-in page that sends the browser back to the server's address for a connection or storage. */
function isServiceSignIn(url: URL, server: string | undefined) {
  if (!server || url.origin === server) return false;
  const back = parse(url.searchParams.get("redirect_uri") ?? "");
  return back?.origin === server && [...SIGN_IN_RETURNS.values()].includes(back.pathname);
}

/**
 * Where a `leafdesk://sign-in/<flow>?…` link the server's hand-over page opened takes the window:
 * the server's own return address with the service's answer, which the server finishes under the
 * app's session (null: not such a link). Only the answer's parameters go along, and only to the
 * server the app is on.
 */
export function signInReturn(link: string, server: string | undefined): string | null {
  const url = parse(link);
  if (!url || url.protocol !== `${APP_SCHEME}:` || url.hostname !== "sign-in" || !server) return null;
  const path = SIGN_IN_RETURNS.get(url.pathname.slice(1));
  if (!path) return null;
  const back = new URL(path, server);
  for (const key of ANSWER_PARAMS) {
    const value = url.searchParams.get(key);
    if (value !== null) back.searchParams.set(key, value);
  }
  return back.href;
}

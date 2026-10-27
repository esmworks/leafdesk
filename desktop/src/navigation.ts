/**
 * Where the window may go. Leafdesk's own pages stay in it. A tab has no address bar, so other web
 * pages go to the system's browser, with one exception: signing in to Leafdesk at an identity
 * provider (single sign-on), whose cookies have to land in this app. Such a trip starts on one of
 * the server's sign-in pages and lasts until the tab is back on the server (main.ts); the strip
 * shows the host meanwhile (`awayHost`). Signing in to a service for a connection, for storage or
 * for a mailbox happens in the system's browser, where the person is likely signed in to the service already,
 * and the server hands the answer back to the app with a `leafdesk://` link (see `signInReturn`).
 * Links Leafdesk opens in a new tab go to the system's browser too, unless they lead back into
 * Leafdesk, which opens them in a tab of its own (as it does a `leafdesk://open` link, see
 * `openLinkTarget`).
 */

/** "sign-in": allowed, as part of signing in elsewhere (the tab is, or now is, on a sign-in trip). */
export type NavigationDecision = "allow" | "sign-in" | "external" | "deny";
/**
 * Where a tab is: `from`, the address it shows, and `signingIn`, whether it is on a sign-in trip
 * (one an earlier "sign-in" decision started, and that hasn't ended).
 */
export type NavigationContext = { from?: string; signingIn?: boolean };
export type NewWindowDecision = "tab" | "external" | "deny";

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
  ["mail", "/api/mail/oauth/callback"],
]);
/** What a service's answer carries back (RFC 6749 4.1.2, RFC 9207). */
const ANSWER_PARAMS = ["state", "code", "iss", "error"];
/**
 * The server's pages that send people to sign in at an identity provider (src/app/(auth) and the
 * workspace's single sign-on gate). None of them shows what people wrote, so no link on them is
 * someone else's.
 */
const SIGN_IN_PAGES = /^\/(?:sign-in|sign-up|(?:invite|join|sso-required)\/[^/]+)\/?$/;
/** Where identity providers answer on the server: its auth API (`/api/auth/callback/…`, `/api/auth/sso/…`). */
const AUTH_API = "/api/auth/";

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
 * A navigation of a tab's page itself (or a redirect on its way); `localPages` is the file URL the
 * app's own pages start with, `server` the origin of the pages the window shows.
 */
export function decideNavigation(target: string, localPages: string, server?: string, context: NavigationContext = {}): NavigationDecision {
  const url = parse(target);
  if (!url) return "deny";
  if (isWeb(url)) {
    if (server && url.origin === server) return "allow";
    if (isServiceSignIn(url, server)) return "external";
    return context.signingIn || startsSignIn(url, server, context.from) ? "sign-in" : "external";
  }
  if (url.protocol === "file:") return target.startsWith(localPages) ? "allow" : "deny";
  return EXTERNAL_SCHEMES.has(url.protocol) ? "external" : "deny";
}

/**
 * Whether a navigation away from the server starts signing in to Leafdesk at an identity provider:
 * it leaves one of the server's sign-in pages, and asks the provider to answer at the server's auth
 * API (an OAuth or OpenID Connect `redirect_uri`) or is a SAML request.
 */
function startsSignIn(url: URL, server: string | undefined, from: string | undefined) {
  const page = parse(from ?? "");
  if (!server || page?.origin !== server || !SIGN_IN_PAGES.test(page.pathname)) return false;
  const back = parse(url.searchParams.get("redirect_uri") ?? "");
  return (back?.origin === server && back.pathname.startsWith(AUTH_API)) || url.searchParams.has("SAMLRequest");
}

/**
 * The address a tab shows when it is away from the server (signing in elsewhere), as an address
 * bar would: the host, or the whole origin for plain HTTP. Null on the server and on the app's own pages.
 */
export function awayHost(url: string | undefined, server: string | undefined): string | null {
  const parsed = parse(url ?? "");
  if (!parsed || !isWeb(parsed) || parsed.origin === server) return null;
  return parsed.protocol === "https:" ? parsed.host : parsed.origin;
}

/** Whether a frame inside a page (an embed) may be redirected there: web pages only. */
export function allowsFrameRedirect(target: string) {
  const url = parse(target);
  return !!url && isWeb(url);
}

/** A page asking for a new window (`window.open`, a link with `target="_blank"`). */
export function decideNewWindow(target: string, server: string | undefined): NewWindowDecision {
  const url = parse(target);
  if (!url) return "deny";
  if (isWeb(url)) return server && url.origin === server ? "tab" : "external";
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

/** A service's sign-in page that sends the browser back to the server's address for a connection, storage or a mailbox. */
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

/**
 * Where a `leafdesk://open?url=<page>` link takes the app: the web app offers it to people who
 * open Leafdesk's links in the desktop app (src/components/desktop-link-banner.tsx). Only a page of
 * the server the app is on, by its exact origin, opens; anything else is turned down (null).
 */
export function openLinkTarget(link: string, server: string | undefined): string | null {
  const url = parse(link);
  if (!url || url.protocol !== `${APP_SCHEME}:` || url.hostname !== "open" || !server) return null;
  const target = parse(url.searchParams.get("url") ?? "");
  if (!target || !isWeb(target) || target.origin !== server || target.username || target.password) return null;
  return `${server}${target.pathname}${target.search}${target.hash}`;
}

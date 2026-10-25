/**
 * The Content-Security-Policy of every page (see proxy.ts), so that HTML which slipped past the
 * sanitizers (a published page's body, a bookmark, a diagram) can't run script on this origin,
 * where the session cookie lives, and no other site can frame the app.
 *
 * - Scripts: only those carrying this response's nonce, and what they load ('strict-dynamic').
 *   Next puts the nonce on its own scripts when it finds it in the request's policy, which needs
 *   the page to be rendered for the request: the root layout reads cookies, so every page is.
 *   React needs eval in development only.
 * - Styles stay inline-friendly: React style attributes, the editor's and KaTeX's inline styles.
 *   A nonce in style-src would turn 'unsafe-inline' off, so none is given there.
 * - Images and media may come from anywhere: bookmarks hotlink their preview image and icon (see
 *   components/page/web-card.tsx), and image, video and audio blocks can point at any address.
 * - Frames: this origin (the inline PDF viewer, an <object>) and any https site, which embed blocks
 *   may show (lib/web-blocks embedAny). A frame runs in the framed site's own origin, sandboxed,
 *   never in this one, so it can't reach the session cookie or the page around it.
 * - Connections: this origin, its websockets included (collaboration, and HMR in development),
 *   spelled out for browsers whose 'self' doesn't cover ws:/wss:.
 * - `analytics`: the pages of a workspace site with a Google Analytics ID (server/site-hosts.ts)
 *   may load Google's tag and send it what it measures: exactly its hosts, nothing else changes.
 */
export function contentSecurityPolicy({
  nonce,
  host,
  dev,
  analytics = false,
}: {
  nonce: string;
  host: string;
  dev: boolean;
  analytics?: boolean;
}): string {
  // The Host header is the visitor's to write: anything but a host name (and port) is left out
  // rather than let into the policy.
  const sockets = /^[a-z0-9.-]+(:\d+)?$|^\[[0-9a-f:.]+\](:\d+)?$/i.test(host) ? [`ws://${host}`, `wss://${host}`] : [];
  const directives: [string, ...string[]][] = [
    ["default-src", "'self'"],
    ["script-src", "'self'", `'nonce-${nonce}'`, "'strict-dynamic'", ...(dev ? ["'unsafe-eval'"] : []), ...(analytics ? ANALYTICS_SCRIPTS : [])],
    ["style-src", "'self'", "'unsafe-inline'"],
    ["img-src", "*", "data:", "blob:"],
    ["media-src", "*", "data:", "blob:"],
    ["font-src", "'self'", "data:"],
    ["connect-src", "'self'", ...sockets, ...(analytics ? ANALYTICS_CONNECTIONS : [])],
    ["frame-src", "'self'", "https:"],
    ["object-src", "'self'"],
    ["worker-src", "'self'", "blob:"],
    ["manifest-src", "'self'"],
    ["base-uri", "'self'"],
    ["form-action", "'self'"],
    ["frame-ancestors", "'self'"],
  ];
  return directives.map((d) => d.join(" ")).join("; ");
}

/** Where Google's tag (gtag.js) comes from; with 'strict-dynamic' the nonce is what lets it in. */
const ANALYTICS_SCRIPTS = ["https://www.googletagmanager.com"];
/** Where Google Analytics 4 sends its measurements (images may come from anywhere already). */
const ANALYTICS_CONNECTIONS = ["https://*.google-analytics.com", "https://*.analytics.google.com", "https://www.googletagmanager.com"];

/** The nonce of a policy contentSecurityPolicy wrote, for server components that add a script. */
export function policyNonce(policy: string | null): string | undefined {
  return policy ? /'nonce-([A-Za-z0-9+/=]+)'/.exec(policy)?.[1] : undefined;
}

/** A fresh nonce for one response: 128 random bits, base64. */
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

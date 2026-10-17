/**
 * Where the window may go. Leafdesk's own pages stay in it, and so do other web pages it moves to
 * on its own (single sign-on, a connection's sign-in page): their cookies have to land in this app,
 * not in the system's browser. Links Leafdesk opens in a new tab go to the system's browser,
 * unless they lead back into Leafdesk, which gets a window of its own.
 */

export type NavigationDecision = "allow" | "external" | "deny";
export type NewWindowDecision = "window" | "external" | "deny";

const EXTERNAL_SCHEMES = new Set(["mailto:", "tel:"]);

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

/** A navigation of the window itself; `localPages` is the file URL its own pages start with. */
export function decideNavigation(target: string, localPages: string): NavigationDecision {
  const url = parse(target);
  if (!url) return "deny";
  if (isWeb(url)) return "allow";
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

/** Whether a page belongs to the connected server, for permissions it asks for. */
export function isServerPage(url: string | undefined, server: string | undefined) {
  if (!url || !server) return false;
  return parse(url)?.origin === server;
}

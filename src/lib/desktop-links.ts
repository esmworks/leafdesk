/**
 * Opening Leafdesk's links in the desktop app (Settings > Preferences): a page opened in a browser
 * offers to go on to the app ("ask"), or tries it at once ("always"), through a
 * `leafdesk://open?url=<page>` link the app opens in a tab of its own (desktop/src/navigation.ts,
 * `openLinkTarget`). A browser that has no app for the link stays on the page.
 */

export const DESKTOP_LINKS = ["off", "ask", "always"] as const;
export type DesktopLinks = (typeof DESKTOP_LINKS)[number];

export function isDesktopLinks(value: unknown): value is DesktopLinks {
  return typeof value === "string" && (DESKTOP_LINKS as readonly string[]).includes(value);
}

/** The link that opens `pageUrl` in the desktop app. */
export function desktopLink(pageUrl: string) {
  return `leafdesk://open?${new URLSearchParams({ url: pageUrl })}`;
}

/** Pages that are worth opening in the app: a workspace's pages and its home. */
const OPENABLE = /^\/w\/[^/]+(?:\/p\/[^/]+)?\/?$/;

export function isOpenablePath(pathname: string) {
  return OPENABLE.test(pathname);
}

/**
 * What the page does about the desktop app: nothing, offer to open it there ("offer"), or open it
 * there now and offer it too in case nothing answered ("open"). Inside the app (its pages carry
 * `<html data-desktop-app>`, or, from versions before it, `data-window-controls`) there is nothing
 * to do; a browser tab tries on its own once, and an offer turned down stays down in that tab.
 */
export function desktopLinkAction({
  preference,
  inDesktopApp,
  pathname,
  dismissed,
  tried,
}: {
  preference: DesktopLinks;
  inDesktopApp: boolean;
  pathname: string;
  /** The offer was closed in this browser tab. */
  dismissed: boolean;
  /** This browser tab already tried opening the app on its own. */
  tried: boolean;
}): "none" | "offer" | "open" {
  if (preference === "off" || inDesktopApp || !isOpenablePath(pathname)) return "none";
  if (preference === "always" && !tried) return "open";
  return dismissed ? "none" : "offer";
}

/** Whether this page runs inside the desktop app (desktop/src/preload.cts marks it). */
export function inDesktopApp(root: { hasAttribute(name: string): boolean }) {
  return root.hasAttribute("data-desktop-app") || root.hasAttribute("data-window-controls");
}

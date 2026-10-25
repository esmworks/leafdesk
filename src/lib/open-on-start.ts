/**
 * What Leafdesk opens on when it starts (Settings > Preferences): the workspace's home page, or
 * the page the person opened last, on any device (from their page views, server/page-views.ts).
 * Starting means arriving at the app's own address, as after signing in or opening the installed
 * app; a link to a page still opens that page. Switching to another workspace then opens the page
 * opened last there (server/open-on-start.ts workspaceResumePath).
 */

export const OPEN_ON_START = ["home", "last_page"] as const;
export type OpenOnStart = (typeof OPEN_ON_START)[number];

export function isOpenOnStart(value: unknown): value is OpenOnStart {
  return typeof value === "string" && (OPEN_ON_START as readonly string[]).includes(value);
}

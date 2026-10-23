/**
 * Fired on `window` when something outside a page asks for its comments (a table row's menu):
 * the page view showing that page opens them, now or as soon as it shows it.
 */
export const COMMENTS_REQUEST_EVENT = "leafdesk:open-comments";

let requested: string | null = null;

/** Asks for `pageId`'s comments to open; call it as (or after) the page is opened. */
export function requestComments(pageId: string) {
  requested = pageId;
  window.dispatchEvent(new Event(COMMENTS_REQUEST_EVENT));
}

/** Whether `pageId`'s comments were asked for; the request is used up. */
export function takeCommentsRequest(pageId: string): boolean {
  if (requested !== pageId) return false;
  requested = null;
  return true;
}

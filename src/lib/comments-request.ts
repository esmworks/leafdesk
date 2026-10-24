/**
 * Fired on `window` when something outside a page asks for its comments (a table row's menu):
 * the page view showing that page opens them, now or as soon as it shows it.
 */
export const COMMENTS_REQUEST_EVENT = "leafdesk:open-comments";

/**
 * Fired on `window` when a row's property asks to be commented on: the row's comments, opened by
 * the same request, start a thread on that property.
 */
export const PROPERTY_COMMENT_EVENT = "leafdesk:comment-property";

let requested: string | null = null;
/** A property of a row to start a thread on, with its name. */
export type PropertyCommentRequest = { propertyId: string; name: string };

let requestedProperty: (PropertyCommentRequest & { pageId: string }) | null = null;

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

/** Opens `pageId`'s comments to discuss the value of one of its properties. */
export function requestPropertyComment(pageId: string, property: PropertyCommentRequest) {
  requestedProperty = { pageId, ...property };
  requestComments(pageId);
  window.dispatchEvent(new Event(PROPERTY_COMMENT_EVENT));
}

/** The property of `pageId` a thread was asked for on, if one was; the request is used up. */
export function takePropertyCommentRequest(pageId: string): PropertyCommentRequest | null {
  if (requestedProperty?.pageId !== pageId) return null;
  const { propertyId, name } = requestedProperty;
  requestedProperty = null;
  return { propertyId, name };
}

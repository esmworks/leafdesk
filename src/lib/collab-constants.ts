/** Y.XmlFragment holding the BlockNote document; client and server must agree. */
export const COLLAB_FRAGMENT = "blocknote";
/** Y.Map holding page metadata that syncs live (title). */
export const COLLAB_META = "meta";
/**
 * Page history saves an automatic version of a page at most this often while it is edited (see
 * collab/service.ts); analytics counts edits by these versions (server/analytics.ts).
 */
export const AUTO_SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000;
/**
 * Sent on a page's own document when its icon or cover changed (server/pages.ts): the page view
 * reloads them, so everyone who has the page open sees the change.
 */
export const PAGE_HEADER_EVENT = "header";

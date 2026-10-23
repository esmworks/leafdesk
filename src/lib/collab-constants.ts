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
 * Sent on a page's own document when its icon or background changed (server/pages.ts): the page view
 * reloads them, so everyone who has the page open sees the change.
 */
export const PAGE_HEADER_EVENT = "header";
/**
 * Sent on a page's own document after an AI app, the chat or an agent changed its body: the page
 * view looks for changes to review (server/page-review.ts).
 */
export const AI_EDIT_EVENT = "ai-edit";
/**
 * Sent on a page's own document when saving it to the database failed, and again (PAGE_SAVED_EVENT)
 * once a later save of it went through: open editors say their changes aren't saved meanwhile.
 */
export const PAGE_SAVE_FAILED_EVENT = "save-failed";
export const PAGE_SAVED_EVENT = "saved";
/**
 * Sent to one connection of a page's document that was read-only and takes edits again, in place:
 * the page was unlocked or restored, or the person was given edit access while it was open (see
 * collab/service.ts). The browser syncs again (components/collab/socket), sending the edits the
 * server turned down meanwhile.
 */
export const PAGE_WRITABLE_EVENT = "writable";

/**
 * Sent to a connection of someone who may only suggest (comment access) before the server drops
 * it for a change that was more than their own suggestions (collab/suggest-guard). Their tab
 * forgets its copy of the page and loads it again (components/collab/socket): the change can't be
 * sent, and edits after it build on it.
 */
export const SUGGESTION_REFUSED_EVENT = "suggestion-refused";

/** Sent to a page's document when its suggested edits were answered, so the open tabs read them again. */
export const SUGGESTIONS_EVENT = "suggestions";

/** Fired on `window` when this tab changed which notifications the inbox shows, so the sidebar recounts. */
export const INBOX_PREFERENCES_EVENT = "leafdesk:inbox-preferences";

/** Fired on `window` to open the inbox on a tab (the sidebar listens): the Calendar's reminders about no page open it on Scheduled. */
export const OPEN_INBOX_EVENT = "leafdesk:open-inbox";

/** A tab the inbox may be opened on from elsewhere. */
export type InboxTab = "scheduled";

/** Opens the inbox on `tab`. */
export function openInbox(tab: InboxTab) {
  window.dispatchEvent(new CustomEvent<InboxTab>(OPEN_INBOX_EVENT, { detail: tab }));
}

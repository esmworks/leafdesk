/**
 * The notifications that open as cards over the page when they come (server/notifications.ts
 * `recentArrivals`, components/sidebar/arrival-cards.tsx): what a person did for or to the user.
 * Agents' and automations' notices, reminders and changes to followed pages wait in the inbox.
 */
export const ARRIVAL_KINDS = ["assignment", "mention", "comment", "page_shared", "access_request"] as const;

/** How long after it came a notification still opens as a card; after that it waits in the inbox. */
export const ARRIVAL_WINDOW_MS = 2 * 60_000;

/** How long the cards stay when nothing new comes and the pointer isn't on them. */
export const ARRIVAL_SHOWN_MS = 8_000;

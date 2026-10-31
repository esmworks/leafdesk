/**
 * What the server sends a person's open windows, on the workspace's signal channel
 * (`ws:<workspaceId>`), when one of their agents' reminders comes (server/notifications.ts
 * deliverSnoozed): they read the reminders due. Its own module: the sidebar is in every first load.
 */
export const REMINDER_EVENT = "reminder";

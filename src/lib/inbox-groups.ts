/**
 * Notifications about the same page that arrive close together show as one entry in the inbox
 * ("3 new comments on Roadmap"), which opens to the single ones. Grouped when listing, here and
 * pure: the inbox keeps its flat list, and only how it shows it changes.
 */

/** Which notifications go together: comments and reactions to them, or edits of a page or row. */
export type InboxFamily = "comments" | "edits";

const FAMILIES: Record<string, InboxFamily> = {
  comment: "comments",
  reaction: "comments",
  page_updated: "edits",
  row_update: "edits",
};

export const familyOf = (kind: string): InboxFamily | null => FAMILIES[kind] ?? null;

/** How far apart (from the newest of them) notifications may be and still be one entry. */
export const GROUP_WINDOW_MS = 6 * 3_600_000;

export type GroupableItem = { id: string; kind: string; pageId: string | null; createdAt: Date | string; read: boolean };

export type InboxEntry<T extends GroupableItem> =
  | { type: "item"; item: T }
  | {
      type: "group";
      /** Stable while the group's newest notification stays the same. */
      key: string;
      family: InboxFamily;
      pageId: string;
      /** Newest first; two or more. */
      items: T[];
      /** How many of them are unread. */
      unread: number;
    };

const time = (value: Date | string) => new Date(value).getTime();

/**
 * The inbox's entries, in the order of `items` (newest first): each notification on its own, but
 * those of one family about one page within GROUP_WINDOW_MS of the newest of them, which become
 * one group where it stands. Others in between keep their places.
 */
export function groupInbox<T extends GroupableItem>(items: readonly T[], windowMs = GROUP_WINDOW_MS): InboxEntry<T>[] {
  const entries: InboxEntry<T>[] = [];
  // The group still taking notifications, per page and family.
  const open = new Map<string, { at: number; newest: number }>();
  for (const item of items) {
    const family = familyOf(item.kind);
    if (!family || !item.pageId) {
      entries.push({ type: "item", item });
      continue;
    }
    const key = `${family}:${item.pageId}`;
    const current = open.get(key);
    if (current && current.newest - time(item.createdAt) <= windowMs) {
      const entry = entries[current.at];
      if (entry.type === "item") {
        entries[current.at] = {
          type: "group",
          key: `group:${entry.item.id}`,
          family,
          pageId: item.pageId,
          items: [entry.item, item],
          unread: (entry.item.read ? 0 : 1) + (item.read ? 0 : 1),
        };
      } else {
        entry.items.push(item);
        if (!item.read) entry.unread++;
      }
      continue;
    }
    open.set(key, { at: entries.length, newest: time(item.createdAt) });
    entries.push({ type: "item", item });
  }
  return entries;
}

/** How many of a group's notifications are of each kind, for its line ("3 comments, 2 reactions"). */
export function groupCounts<T extends GroupableItem>(items: readonly T[], onlyUnread: boolean): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) if (!onlyUnread || !item.read) counts[item.kind] = (counts[item.kind] ?? 0) + 1;
  return counts;
}

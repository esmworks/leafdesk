"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { read } from "@/components/read";
import type { InboxItem } from "@/server/notifications";

/**
 * The agents' reminders to show over the page (reminder-prompt.tsx). Read once the count comes,
 * when the server says one came (REMINDER_EVENT, which bumps `wake`), when the unread count goes
 * up (a signal missed while offline, read again on focus) and, while some show, when it changes
 * at all (one was seen in another tab). Not on every inbox signal: every notification in the
 * workspace signals every sidebar in it. One closed here stays closed in this tab, unread, until
 * it comes again: a snoozed one wakes with a new `createdAt` (deliverSnoozed), so a new key.
 */
const key = (r: InboxItem) => `${r.id}:${new Date(r.createdAt).getTime()}`;

export function useDueReminders(workspaceId: string, unread: number, wake: number) {
  const [reminders, setReminders] = useState<InboxItem[]>([]);
  const last = useRef<{ workspaceId: string; unread: number; wake: number } | null>(null);
  const closed = useRef(new Set<string>());
  const showing = reminders.length > 0;
  useEffect(() => {
    const before = last.current?.workspaceId === workspaceId ? last.current : null;
    last.current = { workspaceId, unread, wake };
    if (before && before.wake === wake) {
      if (before.unread === unread) return;
      if (unread < before.unread && !showing) return;
    }
    if (!before) {
      closed.current.clear();
      // Due reminders are unread: none before the count comes.
      if (unread === 0) return;
    }
    read("dueReminders", workspaceId)
      .then((items) => last.current?.workspaceId === workspaceId && setReminders(items.filter((r) => !closed.current.has(key(r)))))
      .catch(() => {});
  }, [workspaceId, unread, wake, showing]);
  /** Takes one off the screen: it was read, snoozed or closed. */
  const settled = useCallback((item: InboxItem) => {
    closed.current.add(key(item));
    setReminders((list) => list.filter((r) => r.id !== item.id));
  }, []);
  return [reminders, settled] as const;
}

"use client";

import { AlarmClock } from "lucide-react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { markReadAction, snoozeAction } from "@/app/actions/notifications";
import { Button, Dialog, DialogBody, DialogFooter, DialogTitle, PageIcon, pageLabel } from "@/components/ui";
import { pushLink } from "@/lib/push";
import { relativeTime } from "@/lib/relative-time";
import { snoozeUntil } from "@/lib/snooze";
import type { InboxItem } from "@/server/notifications";

/**
 * An agent's reminder over the page when its time comes (server/ai-reminders.ts), the oldest of
 * those waiting first: Done marks it read, "in 1 hour" snoozes it, Open marks it read and goes
 * where the inbox would, and closing it (Escape, a click beside it) only takes it off the screen,
 * unread in the inbox. Reading it here reads it in the inbox, and the other tabs close their copy
 * once their count drops (use-due-reminders.ts).
 */
export function ReminderPrompt({ workspaceId, reminders, onSeen }: { workspaceId: string; reminders: InboxItem[]; onSeen: (item: InboxItem) => void }) {
  const t = useTranslations("sidebar.reminderPrompt");
  const tc = useTranslations("common");
  const locale = useLocale();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const item = reminders[0];
  if (!item) return null;

  const settle = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } catch {
      // It stays unread in the inbox.
    } finally {
      setBusy(false);
      onSeen(item);
    }
  };
  const done = () => settle(() => markReadAction(workspaceId, [item.id]));
  const later = () => settle(() => snoozeAction(item.id, snoozeUntil("hour", new Date()).toISOString()));
  const open = () => {
    void settle(() => markReadAction(workspaceId, [item.id]));
    router.push(pushLink({ ...item, workspaceId }));
  };
  const agent = item.aiReminder?.agentName || item.actorName || tc("agent");

  return (
    <Dialog open onClose={() => onSeen(item)} className="max-w-md">
      <DialogBody className="space-y-3">
        <div className="flex items-center gap-2">
          <AlarmClock aria-hidden className="h-4 w-4 shrink-0 text-accent" />
          <DialogTitle className="min-w-0 flex-1 truncate">{t("title", { agent })}</DialogTitle>
          <span className="shrink-0 text-xs text-fg-muted">{relativeTime(item.createdAt, locale)}</span>
        </div>
        <p className="text-sm leading-6 break-words whitespace-pre-wrap text-fg">{item.aiReminder?.text}</p>
        {item.pageId && (
          <p className="flex items-center gap-1.5 text-sm text-fg-muted">
            <PageIcon icon={item.pageIcon} kind="page" className="text-sm" />
            <span className="truncate">{pageLabel(item.pageTitle ?? "", tc("untitled"))}</span>
          </p>
        )}
      </DialogBody>
      <DialogFooter>
        <Button onClick={() => void later()} disabled={busy}>
          {t("later")}
        </Button>
        <Button onClick={open} disabled={busy}>
          {t("open")}
        </Button>
        <Button variant="primary" autoFocus onClick={() => void done()} disabled={busy}>
          {t("done")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

"use client";

import { AlarmClock, Archive, ArchiveRestore, CalendarClock, Check, CheckCheck, ChevronDown, ChevronRight, ClipboardCheck, Gauge, Inbox, KeyRound, ListFilter, Mail, NotebookPen, ShieldQuestion, UserPlus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useMemo, useState, useEffect } from "react";
import { approveAccessRequestAction, declineAccessRequestAction } from "@/app/actions/access-requests";
import { decideAgentLimitRequestAction } from "@/app/actions/agents";
import {
  archiveAction,
  archiveReadAction,
  markReadAction,
  markUnreadAction,
  snoozeAction,
  unarchiveAction,
} from "@/app/actions/notifications";
import { ApprovalActions } from "@/components/connections/approval-actions";
import { Value } from "@/components/database/row-activity";
import { Button, cn, Dialog, IconButton, PageIcon, pageLabel } from "@/components/ui";
import { UserAvatar } from "@/components/user-avatar";
import { InboxSwipe } from "./inbox-swipe";
import { groupCounts, groupInbox, type InboxEntry } from "@/lib/inbox-groups";
import { approvalLevelsFor, initialApprovalLevel, type ApprovalLevel } from "@/lib/access-requests";
import { pushLink, SUGGESTION_LINES } from "@/lib/push";
import { formatIsoDate } from "@/lib/mentions";
import { relativeTime } from "@/lib/relative-time";
import { canSnooze, SNOOZE_CHOICES, snoozeUntil, type SnoozeChoice } from "@/lib/snooze";
import type { InboxAccessRequest, InboxItem, InboxLimitRequest, InboxRowUpdate } from "@/server/notifications";
import { aiLimitLine } from "@/lib/agent-guardrails";
import { read } from "@/components/read";

/**
 * The workspace inbox: rows the user was assigned to, pages shared with them, comments, mentions,
 * reminders, requests for access to their pages, what database automations tell them, what others
 * changed in the rows they follow and, for
 * owners, join requests and agents' calls that wait for approval, newest first; opening one marks
 * it read. Access requests and agents' calls can be answered right here, and the others snoozed:
 * they leave the inbox and come back unread when the time is up. Where email on rows is on, the
 * Email tab shows only the messages that came in on rows; opening one opens its row, where it is
 * read and answered. Notifications of one kind about one page that came close together (comments
 * and reactions, or edits) show as one entry, which opens to the single ones (lib/inbox-groups.ts);
 * opening, snoozing or marking the entry read does so to all of them. Notifications can be archived
 * (one by one, or every read one at once): they move to the Archived tab, read, and can be moved
 * back from there.
 */
export function InboxDialog({
  workspaceId,
  open,
  onClose,
  version,
  onRead,
}: {
  workspaceId: string;
  open: boolean;
  onClose: () => void;
  /** Bumped when the inbox changed elsewhere, so an open dialog reloads. */
  version: number;
  /** Called after notifications were marked read, so the unread count updates. */
  onRead: () => void;
}) {
  const router = useRouter();
  const locale = useLocale();
  const t = useTranslations("sidebar.inbox");
  const tc = useTranslations("common");
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [error, setError] = useState(false);
  const [tab, setTab] = useState<"all" | "email" | "archived">("all");
  const archivedTab = tab === "archived";
  const [emailTab, setEmailTab] = useState(false);
  // Only the notifications not read yet (not in the archive, where they are read).
  const [unreadOnly, setUnreadOnly] = useState(false);
  const onlyUnread = unreadOnly && !archivedTab;

  useEffect(() => {
    if (!open) return;
    let current = true;
    setError(false);
    read("inbox", workspaceId, tab, onlyUnread).then(
      (list) => {
        if (!current) return;
        setItems(list.items);
        setEmailTab(list.email);
        if (!list.email && tab === "email") setTab("all");
      },
      () => current && setError(true),
    );
    return () => {
      current = false;
    };
  }, [open, workspaceId, version, tab, onlyUnread]);

  const markRead = async (ids?: string[]) => {
    // Unread only: what is read leaves the list.
    setItems((list) => list?.flatMap((item) => (!ids || ids.includes(item.id) ? (onlyUnread ? [] : [{ ...item, read: true }]) : [item])) ?? list);
    try {
      await markReadAction(workspaceId, ids);
    } catch {
      setError(true);
    }
    onRead();
  };

  const markUnread = async (ids: string[]) => {
    setItems((list) => list?.map((item) => (ids.includes(item.id) ? { ...item, read: false } : item)) ?? list);
    try {
      await markUnreadAction(workspaceId, ids);
    } catch {
      setError(true);
    }
    onRead();
  };

  // Archiving (or moving back to the inbox) takes them off the list shown.
  const archive = async (ids: string[], back = false) => {
    setItems((list) => list?.filter((item) => !ids.includes(item.id)) ?? list);
    try {
      await (back ? unarchiveAction(workspaceId, ids) : archiveAction(workspaceId, ids));
    } catch {
      setError(true);
    }
    onRead();
  };
  const archiveRead = async () => {
    setItems((list) => list?.filter((item) => !item.read) ?? list);
    try {
      await archiveReadAction(workspaceId);
    } catch {
      setError(true);
    }
    onRead();
  };

  // The notification whose snooze choices are open.
  const [snoozing, setSnoozing] = useState<string | null>(null);
  const snooze = async (id: string, choice: SnoozeChoice) => {
    setSnoozing(null);
    try {
      if (!(await snoozeAction(id, snoozeUntil(choice, new Date()).toISOString()))) throw new Error("not snoozed");
      setItems((list) => list?.filter((item) => item.id !== id) ?? list);
    } catch {
      setError(true);
    }
    onRead();
  };

  const unread = items?.filter((item) => !item.read) ?? [];
  const entries = useMemo(() => (items ? groupInbox(items) : null), [items]);
  // The groups opened to their single notifications.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const toggleGroup = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const snoozeAll = async (key: string, ids: string[], choice: SnoozeChoice) => {
    setSnoozing(null);
    const until = snoozeUntil(choice, new Date()).toISOString();
    const done = await Promise.all(ids.map((id) => snoozeAction(id, until).catch(() => false)));
    const gone = new Set(ids.filter((_, i) => done[i]));
    setItems((list) => list?.filter((item) => !gone.has(item.id)) ?? list);
    if (gone.size < ids.length) setError(true);
    setExpanded((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    onRead();
  };

  /** One notification of the list, on its own or (`nested`) opened from its group. */
  const itemRow = (item: InboxItem, nested = false) => (
    <li key={item.id} className={cn("relative", nested && "ms-4 border-s border-border ps-1")}>
      <InboxSwipe
        read={item.read}
        snoozable={canSnooze(item.kind) && !archivedTab}
        onRead={() => void (item.read ? markUnread([item.id]) : markRead([item.id]))}
        onSnooze={() => void snooze(item.id, SWIPE_SNOOZE)}
      >
        <button
          type="button"
          className={cn(
            ROW_CLASS,
            canSnooze(item.kind) && !archivedTab ? "[@media(hover:none)]:pe-[4.5rem]" : "[@media(hover:none)]:pe-10",
          )}
          onClick={() => {
            if (!item.read) void markRead([item.id]);
            onClose();
            // Join requests are decided in Settings > Members; an agent's call opens its run, its
            // proposed notes its memory, a scheduled run's report that run in the agent's chat.
            router.push(pushLink({ ...item, workspaceId }));
          }}
        >
          <span
            aria-hidden
            className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", item.read ? "bg-transparent" : "bg-accent")}
          />
          <span className="min-w-0 flex-1">
            {/* Opened from its group, which names the page already. */}
            {!nested && (
              <span className={cn("flex items-center gap-1.5 text-sm", !item.read && "font-medium")}>
                {item.kind === "agent_approval" ? (
                  <>
                    <ShieldQuestion aria-hidden className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
                    <span className="truncate">{t("approvalTitle", { agent: item.approval?.agentName ?? item.actorName ?? t("someone") })}</span>
                  </>
                ) : item.kind === "agent_memory" ? (
                  <>
                    <NotebookPen aria-hidden className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
                    <span className="truncate">{t("memoryTitle", { agent: item.memory?.agentName ?? item.actorName ?? t("someone") })}</span>
                  </>
                ) : item.kind === "agent_report" ? (
                  <>
                    <CalendarClock aria-hidden className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
                    <span className="truncate">{t("reportTitle", { agent: item.report?.agentName ?? item.actorName ?? t("someone") })}</span>
                  </>
                ) : item.kind === "ai_reminder" ? (
                  <>
                    <AlarmClock aria-hidden className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
                    <span className="truncate">{t("aiReminderTitle", { agent: item.aiReminder?.agentName ?? item.actorName ?? t("someone") })}</span>
                  </>
                ) : item.kind === "review" ? (
                  <>
                    <ClipboardCheck aria-hidden className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
                    <span className="truncate">{t("reviewTitle")}</span>
                  </>
                ) : item.kind === "ai_limit" || item.kind === "agent_limit_request" ? (
                  <>
                    <Gauge aria-hidden className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
                    <span className="truncate">
                      {item.kind === "agent_limit_request"
                        ? t("limitRequestTitle", { agent: item.limitRequest?.agentName ?? "" })
                        : (item.aiLimit?.agent?.name ?? t("aiLimitTitle"))}
                    </span>
                  </>
                ) : item.kind === "ai_account_detached" ? (
                  <>
                    <KeyRound aria-hidden className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
                    <span className="truncate">{t("aiAccountTitle")}</span>
                  </>
                ) : item.kind === "row_email" || item.kind === "follow_up" ? (
                  <>
                    <Mail aria-hidden className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
                    <span className="truncate">{pageLabel(item.pageTitle ?? "", tc("untitled"))}</span>
                  </>
                ) : item.pageId === null ? (
                  <>
                    <UserPlus aria-hidden className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
                    <span className="truncate">{t("joinRequestTitle")}</span>
                  </>
                ) : (
                  <>
                    <PageIcon icon={item.pageIcon} kind="page" className="text-sm" />
                    <span className="truncate">{pageLabel(item.pageTitle ?? "", tc("untitled"))}</span>
                  </>
              )}
              </span>
            )}
            <span
              className={cn(
                "break-words",
                nested ? cn("text-sm", !item.read && "font-medium") : "mt-0.5 text-xs leading-5 text-fg-muted",
                // A run's report can run long: the run itself has all of it. (line-clamp sets its own
                // display, which `block` would override.)
                item.kind === "agent_report" ? "line-clamp-3" : "block",
              )}
            >
              {item.kind === "agent_approval"
                ? item.approval
                  ? t("approval", { tool: item.approval.tool, connection: item.approval.connectionName })
                  : t("approvalAnswered")
                : item.kind === "agent_memory"
                ? !item.memory
                  ? t("memoryAnswered")
                  : item.memory.text === null
                    ? t("memoryHidden", { count: item.memory.count })
                    : t("memory", { text: item.memory.text, more: item.memory.count - 1 })
                : item.kind === "ai_reminder"
                ? (item.aiReminder?.text ?? "")
                : item.kind === "agent_report"
                ? !item.report
                  ? t("reportGone")
                  : item.report.status === "failed"
                    ? t("reportFailed")
                    : item.report.text === null
                      ? t("reportHidden")
                      : item.report.text || t("reportDone")
                : item.kind === "review"
                ? t("review", { count: item.review?.count ?? 0, agent: item.actorName || t("someone") })
                : item.kind === "ai_account_detached"
                ? t("aiAccountDetached", { actor: item.actorName || t("someone") })
                : item.kind === "ai_limit"
                ? item.aiLimit
                  ? t(`aiLimit.${aiLimitLine(item.aiLimit.notice, item.aiLimit.agent !== null)}`, { limit: item.aiLimit.agent?.limit ?? 0 })
                  : ""
                : item.kind === "agent_limit_request"
                ? t("limitRequest", { actor: item.actorName || t("someone"), tokens: item.limitRequest?.tokens ?? 0, current: item.limitRequest?.current ?? 0 })
                : item.kind === "sensitive_content"
                ? t("sensitiveContent", { kind: item.automationMessage ?? "" })
                : item.kind === "page_reported"
                ? t("pageReported", { reason: item.automationMessage ?? "" })
                : item.kind === "access_request"
                ? item.accessRequest && item.accessRequest.level !== "view"
                  ? t("accessRequestMore", { actor: item.actorName || item.accessRequest.requesterEmail || t("someone"), level: item.accessRequest.level })
                  : t("accessRequest", { actor: item.actorName || item.accessRequest?.requesterEmail || t("someone") })
                : item.kind === "join_request"
                ? item.requestKind === "invite"
                  ? t("inviteRequest", { actor: item.actorName || t("someone"), email: item.requestEmail ?? "" })
                  : t("joinRequest", { actor: item.actorName || t("someone") })
                : item.kind === "page_shared"
                ? t("pageShared", { actor: item.actorName || t("someone") })
                : item.kind === "comment"
                  ? item.suggestion
                    ? t(SUGGESTION_LINES[item.suggestion], { actor: item.actorName || t("someone") })
                    : t("comment", { actor: item.actorName || t("someone") })
                  : item.kind === "reaction"
                    ? t("reaction", {
                        actor: t("people", {
                          name: item.reaction?.people[0]?.name || item.actorName || t("someone"),
                          others: Math.max(0, (item.reaction?.people.length ?? 1) - 1),
                        }),
                        emoji: item.reaction?.emojis.join(" ") ?? "",
                      })
                  : item.kind === "mention"
                    ? t("mention", { actor: item.actorName || t("someone") })
                    : item.kind === "reminder"
                      ? t("reminder", { date: item.reminderDate ? formatIsoDate(item.reminderDate, locale) : "" })
                      : item.kind === "row_update"
                        ? t("rowUpdate", { actor: item.actorName || t("someone") })
                      : item.kind === "page_updated"
                        ? t("pageUpdated", { actor: item.actorName || t("someone") })
                      : item.kind === "verification"
                        ? // Recorded at or after the end: it ended; before it: it ends soon.
                          t(item.reminderDate && new Date(item.createdAt) >= new Date(item.reminderDate) ? "verificationEnded" : "verificationEnds", {
                            date: item.reminderDate ? new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(item.reminderDate)) : "",
                          })
                      : item.kind === "row_email"
                        ? t("rowEmail", { from: item.rowEmail?.from || t("someone") })
                      : item.kind === "follow_up"
                        ? t("followUp", { sequence: item.followUp?.sequence ?? "" })
                      : item.kind === "automation"
                        ? item.reminderDate
                          ? t("automationDatePassed", { name: item.automationName ?? "" })
                          : item.automationName === null
                            ? // No automation: someone clicked a button on the page (server/buttons.ts).
                              t("button", { actor: item.actorName || t("someone") })
                          : item.actorName
                            ? t("automation", { name: item.automationName ?? "", actor: item.actorName })
                            : // A schedule, a request or a test run: nobody's change started it.
                              t("automationRun", { name: item.automationName ?? "" })
                        : t("assignment", { actor: item.actorName || t("someone"), property: item.propertyName ?? "" })}
              {item.databaseTitle !== null && <> · {pageLabel(item.databaseTitle, tc("untitled"))}</>}
            </span>
            {item.automationMessage && (
              <bdi className="mt-1 line-clamp-3 text-xs leading-5 break-words whitespace-pre-line text-fg">{item.automationMessage}</bdi>
            )}
            {item.reaction?.excerpt && (
            <bdi className="mt-1 line-clamp-2 text-xs leading-5 break-words text-fg">{t("reactionExcerpt", { text: item.reaction.excerpt })}</bdi>
          )}
          {item.rowUpdate && <RowUpdateChanges update={item.rowUpdate} />}
            {item.rowEmail && (
              <span className="mt-1 block text-xs leading-5 text-fg-muted">
                <bdi className="block truncate text-fg">{item.rowEmail.subject || t("noSubject")}</bdi>
                {item.rowEmail.snippet && <bdi className="line-clamp-2 break-words">{item.rowEmail.snippet}</bdi>}
              </span>
            )}
          </span>
          <time
            dateTime={new Date(item.createdAt).toISOString()}
            className={TIME_CLASS}
            title={new Date(item.createdAt).toLocaleString(locale)}
          >
            {relativeTime(item.createdAt, locale)}
          </time>
          {!item.read && <span className="sr-only">{t("unread")}</span>}
        </button>
        <div className={ROW_ACTIONS_CLASS}>
          {canSnooze(item.kind) && !archivedTab && (
            <IconButton
              label={t("snooze")}
              aria-expanded={snoozing === item.id}
              className="text-fg-faint"
              onClick={() => setSnoozing(snoozing === item.id ? null : item.id)}
            >
              <AlarmClock className="h-3.5 w-3.5" />
            </IconButton>
          )}
          <IconButton
            label={archivedTab ? t("unarchive") : t("archive")}
            className="text-fg-faint"
            onClick={() => void archive([item.id], archivedTab)}
          >
            {archivedTab ? <ArchiveRestore className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
          </IconButton>
        </div>
      </InboxSwipe>
      {snoozing === item.id && (
        <div className="flex flex-wrap items-center gap-1 pb-2 ps-[2.125rem] pe-3" role="group" aria-label={t("snooze")}>
          {SNOOZE_CHOICES.map((choice) => (
            <Button key={choice} size="sm" variant="secondary" onClick={() => void snooze(item.id, choice)}>
              {t(`snoozeChoice.${choice}`)}
            </Button>
          ))}
        </div>
      )}
      {item.approval && (
        <ApprovalActions
          workspaceId={workspaceId}
          approval={item.approval}
          className="pb-2 ps-[2.125rem] pe-3"
          onOpenRun={() => {
            if (!item.read) void markRead([item.id]);
            onClose();
            router.push(`/w/${workspaceId}/settings?tab=agents&agent=${item.approval!.agentId}&run=${item.approval!.runId}`);
          }}
          onAnswered={() => {
            setItems((list) => list?.filter((other) => other.id !== item.id) ?? list);
            onRead();
          }}
        />
      )}
      {item.limitRequest && (
        <LimitRequestActions
          workspaceId={workspaceId}
          request={item.limitRequest}
          onAnswered={() => {
            setItems((list) => list?.filter((other) => other.id !== item.id) ?? list);
            onRead();
          }}
        />
      )}
      {item.accessRequest && (
        <AccessRequestActions
          request={item.accessRequest}
          onAnswered={() => {
            setItems((list) => list?.filter((other) => other.id !== item.id) ?? list);
            onRead();
          }}
        />
      )}
    </li>
  );

  /** Notifications of one kind about one page, as one entry (lib/inbox-groups.ts). */
  const groupRow = (entry: Extract<InboxEntry<InboxItem>, { type: "group" }>) => {
    const newest = entry.items[0];
    const open = expanded.has(entry.key);
    const ids = entry.items.map((item) => item.id);
    const unreadIds = entry.items.filter((item) => !item.read).map((item) => item.id);
    const counts = groupCounts(entry.items, entry.unread > 0);
    const fresh = entry.unread > 0;
    const edits = (counts.page_updated ?? 0) + (counts.row_update ?? 0);
    const parts = [
      counts.comment ? t(fresh ? "groupNewComments" : "groupComments", { count: counts.comment }) : null,
      counts.reaction ? t(fresh ? "groupNewReactions" : "groupReactions", { count: counts.reaction }) : null,
      edits ? t(fresh ? "groupNewEdits" : "groupEdits", { count: edits }) : null,
    ].filter(Boolean);
    const people = [...new Map(entry.items.flatMap((item) => (item.actorId ? [[item.actorId, item] as const] : []))).values()];
    return (
      <li key={entry.key} className="relative">
        <InboxSwipe
          read={entry.unread === 0}
          snoozable={!archivedTab}
          onRead={() => void (entry.unread === 0 ? markUnread(ids) : markRead(unreadIds))}
          onSnooze={() => void snoozeAll(entry.key, ids, SWIPE_SNOOZE)}
        >
          <button
            type="button"
            aria-expanded={open}
            className={cn(ROW_CLASS, archivedTab ? "[@media(hover:none)]:pe-[4.5rem]" : entry.unread > 0 ? "[@media(hover:none)]:pe-[8rem]" : "[@media(hover:none)]:pe-[6.25rem]")}
            onClick={() => {
              if (unreadIds.length) void markRead(unreadIds);
              onClose();
              router.push(pushLink({ ...newest, workspaceId }));
            }}
          >
            <span aria-hidden className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", entry.unread ? "bg-accent" : "bg-transparent")} />
            <span className="min-w-0 flex-1">
              <span className={cn("flex items-center gap-1.5 text-sm", entry.unread > 0 && "font-medium")}>
                <PageIcon icon={newest.pageIcon} kind="page" className="text-sm" />
                <span className="truncate">{pageLabel(newest.pageTitle ?? "", tc("untitled"))}</span>
              </span>
              <span className="mt-1 flex items-center gap-2 text-xs text-fg-muted">
                <span className="flex shrink-0 -space-x-1.5 rtl:space-x-reverse">
                  {people.slice(0, MAX_GROUP_AVATARS).map((item) => (
                    <UserAvatar
                      key={item.actorId}
                      name={item.actorName ?? t("someone")}
                      image={item.actorImage}
                      size="xs"
                      title={item.actorName ?? undefined}
                      className="ring-2 ring-bg"
                    />
                  ))}
                </span>
                <span className="min-w-0">
                  {parts.join(", ")}
                  {people.length > 0 && <> · {t("people", { name: people[0].actorName || t("someone"), others: people.length - 1 })}</>}
                </span>
              </span>
            </span>
            <time
              dateTime={new Date(newest.createdAt).toISOString()}
              className={TIME_CLASS}
              title={new Date(newest.createdAt).toLocaleString(locale)}
            >
              {relativeTime(newest.createdAt, locale)}
            </time>
            {entry.unread > 0 && <span className="sr-only">{t("unread")}</span>}
          </button>
          <div className={ROW_ACTIONS_CLASS}>
            {entry.unread > 0 && (
              <IconButton label={t("groupMarkRead")} className="text-fg-faint" onClick={() => void markRead(unreadIds)}>
                <Check className="h-3.5 w-3.5" />
              </IconButton>
            )}
            {!archivedTab && (
              <IconButton label={t("snooze")} aria-expanded={snoozing === entry.key} className="text-fg-faint" onClick={() => setSnoozing(snoozing === entry.key ? null : entry.key)}>
                <AlarmClock className="h-3.5 w-3.5" />
              </IconButton>
            )}
            <IconButton label={archivedTab ? t("unarchive") : t("archive")} className="text-fg-faint" onClick={() => void archive(ids, archivedTab)}>
              {archivedTab ? <ArchiveRestore className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
            </IconButton>
            <IconButton label={open ? t("groupCollapse") : t("groupExpand", { count: entry.items.length })} aria-expanded={open} className="text-fg-faint" onClick={() => toggleGroup(entry.key)}>
              {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5 rtl:rotate-180" />}
            </IconButton>
          </div>
        </InboxSwipe>
        {snoozing === entry.key && (
          <div className="flex flex-wrap items-center gap-1 pb-2 ps-[2.125rem] pe-3" role="group" aria-label={t("snooze")}>
            {SNOOZE_CHOICES.map((choice) => (
              <Button key={choice} size="sm" variant="secondary" onClick={() => void snoozeAll(entry.key, ids, choice)}>
                {t(`snoozeChoice.${choice}`)}
              </Button>
            ))}
          </div>
        )}
        {open && <ul className="pb-1">{entry.items.map((item) => itemRow(item, true))}</ul>}
      </li>
    );
  };

  return (
    <Dialog open={open} onClose={onClose}>
      <div className="border-b border-border">
        <div className="flex items-center gap-1 px-4 pt-3.5">
          <h2 className="me-auto min-w-0 truncate text-base font-semibold">{t("title")}</h2>
          {tab === "all" && !onlyUnread && items?.some((item) => item.read) && (
            <Button size="sm" variant="ghost" className="whitespace-nowrap" title={t("archiveRead")} onClick={() => void archiveRead()}>
              <Archive aria-hidden className="h-3.5 w-3.5" />
              {/* On a phone the icons alone, so the title keeps its line. */}
              <span className="max-sm:sr-only">{t("archiveRead")}</span>
            </Button>
          )}
          {unread.length > 0 && !archivedTab && (
            <Button size="sm" variant="ghost" className="whitespace-nowrap" title={t("markAllRead")} onClick={() => void markRead()}>
              <CheckCheck aria-hidden className="h-3.5 w-3.5" />
              {/* On a phone the icons alone, so the title keeps its line. */}
              <span className="max-sm:sr-only">{t("markAllRead")}</span>
            </Button>
          )}
        </div>
        <div className="mt-1.5 flex gap-4 px-4">
          <div role="tablist" aria-label={t("tabs")} className="flex gap-4">
            {(emailTab ? (["all", "email", "archived"] as const) : (["all", "archived"] as const)).map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={tab === value}
                className={cn(
                  "-mb-px flex items-center gap-1.5 border-b-2 py-2 text-sm whitespace-nowrap transition-colors",
                  tab === value ? "border-fg font-medium text-fg" : "border-transparent text-fg-muted hover:text-fg",
                )}
                onClick={() => {
                  if (tab === value) return;
                  setItems(null);
                  setTab(value);
                }}
              >
                {value === "all" ? t("tabAll") : value === "email" ? t("tabEmail") : t("tabArchived")}
                {value === "all" && tab === "all" && unread.length > 0 && (
                  <span className="rounded bg-accent px-1.5 text-[11px] leading-4 font-medium text-accent-fg tabular-nums">{unread.length}</span>
                )}
              </button>
            ))}
          </div>
          {!archivedTab && (
            <button
              type="button"
              aria-pressed={unreadOnly}
              title={t("unreadOnly")}
              className={cn(
                "ms-auto -mb-px flex items-center gap-1.5 border-b-2 border-transparent py-2 text-sm whitespace-nowrap transition-colors",
                unreadOnly ? "font-medium text-accent" : "text-fg-muted hover:text-fg",
              )}
              onClick={() => {
                setItems(null);
                setUnreadOnly(!unreadOnly);
              }}
            >
              <ListFilter aria-hidden className="h-3.5 w-3.5" />
              {/* On a phone the icon alone, so the tabs keep their line. */}
              <span className="max-sm:sr-only">{t("unreadOnly")}</span>
            </button>
          )}
        </div>
      </div>
      {error && (
        <p role="alert" className="border-b border-border px-4 py-2 text-xs text-danger">
          {tc("genericError")}
        </p>
      )}
      <ul className="max-h-[60vh] overflow-y-auto p-1.5">
        {items?.length === 0 && (
          <li className="flex flex-col items-center gap-2 px-3 py-10 text-center text-sm text-fg-muted">
            <Inbox aria-hidden className="h-6 w-6 text-fg-faint" strokeWidth={1.5} />
            {archivedTab ? t("emptyArchived") : onlyUnread ? t("emptyUnread") : tab === "email" ? t("emptyEmail") : t("empty")}
          </li>
        )}
        {entries?.map((entry) => (entry.type === "item" ? itemRow(entry.item) : groupRow(entry)))}
      </ul>
    </Dialog>
  );
}

/** Share (at a level) or decline an access request from the inbox; the notification goes away once answered. */
/** An owner's answer to a request for a higher agent limit: raise it to what was asked, or decline. */
function LimitRequestActions({ workspaceId, request, onAnswered }: { workspaceId: string; request: InboxLimitRequest; onAnswered: () => void }) {
  const t = useTranslations("sidebar.inbox");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const answer = async (approve: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const result = await decideAgentLimitRequestAction(workspaceId, request.id, approve);
      if (result.ok) onAnswered();
      else setError(result.error);
    } catch {
      setError(t("limitRequestFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pb-2 ps-[2.125rem] pe-3">
      {request.note && <bdi className="mb-1.5 block text-sm break-words whitespace-pre-line text-fg-muted">{t("limitRequestNote", { note: request.note })}</bdi>}
      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="sm" variant="primary" disabled={busy} onClick={() => void answer(true)}>
          {t("limitRequestApprove", { tokens: request.tokens })}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void answer(false)}>
          {t("limitRequestDecline")}
        </Button>
      </div>
      {error && (
        <p role="alert" className="mt-1 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function AccessRequestActions({ request, onAnswered }: { request: InboxAccessRequest; onAnswered: () => void }) {
  const ts = useTranslations("page.share");
  const [level, setLevel] = useState<ApprovalLevel>(() => initialApprovalLevel(request, "edit"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const answer = async (run: () => ReturnType<typeof declineAccessRequestAction>) => {
    setBusy(true);
    setError(null);
    try {
      const result = await run();
      if (result.ok) onAnswered();
      else setError(ts(`errors.${result.code}`));
    } catch {
      setError(ts("errors.generic"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pb-2 ps-[2.125rem] pe-3">
      {request.message && (
        <p className="mb-1.5 text-sm break-words whitespace-pre-line text-fg-muted">{ts("requests.message", { message: request.message })}</p>
      )}
      {!request.inWorkspace && (
        <p className="mb-1.5 text-xs text-fg-faint">{request.approvable ? ts("requests.outsider") : ts("requests.cantInvite")}</p>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <select
          value={level}
          aria-label={ts("requests.level")}
          disabled={busy || !request.approvable}
          onChange={(e) => setLevel(e.target.value as ApprovalLevel)}
          className="h-7 rounded-md bg-transparent px-1.5 text-sm text-fg-muted hover:bg-bg-hover focus:outline-none"
        >
          {approvalLevelsFor(request.current).map((l) => (
            <option key={l} value={l}>
              {ts(`levels.${l}`)}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          variant="primary"
          disabled={busy || !request.approvable}
          onClick={() => void answer(() => approveAccessRequestAction(request.id, level))}
        >
          {ts("requests.approve")}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void answer(() => declineAccessRequestAction(request.id))}>
          {ts("requests.decline")}
        </Button>
      </div>
      {error && (
        <p role="alert" className="mt-1 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/** A notification's row; its actions (`ROW_ACTIONS_CLASS`) cover the time while it is hovered or focused. */
const ROW_CLASS =
  "flex w-full items-start gap-2.5 rounded-md px-3 py-2.5 text-start group-hover/row:bg-bg-hover group-focus-within/row:bg-bg-hover";

/** A row's time, which its actions take the place of while it is hovered or focused. */
const TIME_CLASS = "shrink-0 pt-0.5 text-xs text-fg-faint group-hover/row:invisible group-focus-within/row:invisible [@media(hover:none)]:visible";

/** Shown only while the row is hovered or focused, except where nothing hovers (the row then leaves room for them). */
const ROW_ACTIONS_CLASS =
  "absolute inset-e-2 top-2 flex items-center gap-0.5 rounded-md bg-bg-hover ps-1 opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100 [@media(hover:none)]:bg-transparent [@media(hover:none)]:opacity-100";

/** Where a swipe snoozes an item to (components/sidebar/inbox-swipe.tsx): tomorrow morning. */
const SWIPE_SNOOZE: SnoozeChoice = "tomorrow";

/** The most people's pictures a group of notifications shows. */
const MAX_GROUP_AVATARS = 3;

/** The most changes of a row update the inbox lists; the row's activity has all of them. */
const MAX_ROW_CHANGES = 4;

/** What a followed row's update changed: "Status: To do → Done", one line each, then whether the text. */
function RowUpdateChanges({ update }: { update: InboxRowUpdate }) {
  const t = useTranslations("sidebar.inbox");
  const shown = update.changes.slice(0, MAX_ROW_CHANGES);
  const more = update.changes.length - shown.length;
  return (
    <span className="mt-1 block space-y-0.5 text-xs leading-5 text-fg-muted">
      {shown.map((change, i) => (
        <span key={change.property?.id ?? `title-${i}`} className="block break-words">
          {t.rich("rowChange", {
            property: change.property?.name ?? t("rowTitle"),
            // Isolated, so a name or value written the other way doesn't pull the arrow around.
            prop: (chunks) => <bdi className="text-fg">{chunks}</bdi>,
            old: () => (
              <bdi>
                <Value value={change.from} />
              </bdi>
            ),
            new: () => (
              <bdi>
                <Value value={change.to} />
              </bdi>
            ),
            from: "",
            to: "",
          })}
        </span>
      ))}
      {more > 0 && <span className="block">{t("rowChangesMore", { count: more })}</span>}
      {update.body && <span className="block">{t("rowBodyChanged")}</span>}
    </span>
  );
}

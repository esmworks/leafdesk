"use client";

import { ShieldQuestion, UserPlus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { approveAccessRequestAction, declineAccessRequestAction } from "@/app/actions/access-requests";
import { listInboxAction, markReadAction } from "@/app/actions/notifications";
import { ApprovalActions } from "@/components/connections/approval-actions";
import { Button, cn, Dialog, PageIcon, pageLabel } from "@/components/ui";
import { APPROVAL_LEVELS, type ApprovalLevel } from "@/lib/access-requests";
import { formatIsoDate } from "@/lib/mentions";
import { relativeTime } from "@/lib/relative-time";
import type { InboxAccessRequest, InboxItem } from "@/server/notifications";

/**
 * The workspace inbox: rows the user was assigned to, pages shared with them, comments, mentions,
 * reminders, requests for access to their pages, what database automations tell them and, for
 * owners, join requests and agents' calls that wait for approval, newest first; opening one marks
 * it read. Access requests and agents' calls can be answered right here.
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

  useEffect(() => {
    if (!open) return;
    let current = true;
    setError(false);
    listInboxAction(workspaceId).then(
      (list) => current && setItems(list),
      () => current && setError(true),
    );
    return () => {
      current = false;
    };
  }, [open, workspaceId, version]);

  const markRead = async (ids?: string[]) => {
    setItems((list) => list?.map((item) => (!ids || ids.includes(item.id) ? { ...item, read: true } : item)) ?? list);
    try {
      await markReadAction(workspaceId, ids);
    } catch {
      setError(true);
    }
    onRead();
  };

  const unread = items?.filter((item) => !item.read) ?? [];

  return (
    <Dialog open={open} onClose={onClose}>
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <span className="flex-1 text-sm font-medium">{t("title")}</span>
        {unread.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => void markRead()}>
            {t("markAllRead")}
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="border-b border-border px-4 py-2 text-xs text-danger">
          {tc("genericError")}
        </p>
      )}
      <ul className="max-h-[60vh] overflow-y-auto p-1">
        {items?.length === 0 && <li className="px-3 py-6 text-center text-sm text-fg-muted">{t("empty")}</li>}
        {items?.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              className="flex w-full items-start gap-2.5 rounded-md px-3 py-2 text-left hover:bg-bg-hover"
              onClick={() => {
                if (!item.read) void markRead([item.id]);
                onClose();
                // Join requests are decided in Settings > Members; an agent's call opens its run.
                router.push(
                  item.kind === "agent_approval"
                    ? `/w/${workspaceId}/settings?tab=agents${item.approval ? `&agent=${item.approval.agentId}&run=${item.approval.runId}` : ""}`
                    : item.pageId === null
                      ? `/w/${workspaceId}/settings?tab=members&view=requests`
                      : `/w/${workspaceId}/p/${item.pageId}`,
                );
              }}
            >
              <span
                aria-hidden
                className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", item.read ? "bg-transparent" : "bg-accent")}
              />
              <span className="min-w-0 flex-1">
                <span className={cn("flex items-center gap-1.5 text-sm", !item.read && "font-medium")}>
                  {item.kind === "agent_approval" ? (
                    <>
                      <ShieldQuestion aria-hidden className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
                      <span className="truncate">{t("approvalTitle", { agent: item.approval?.agentName ?? item.actorName ?? t("someone") })}</span>
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
                <span className="mt-0.5 block text-xs text-fg-muted">
                  {item.kind === "agent_approval"
                    ? item.approval
                      ? t("approval", { tool: item.approval.tool, connection: item.approval.connectionName })
                      : t("approvalAnswered")
                    : item.kind === "access_request"
                    ? t("accessRequest", { actor: item.actorName || item.accessRequest?.requesterEmail || t("someone") })
                    : item.kind === "join_request"
                    ? item.requestKind === "invite"
                      ? t("inviteRequest", { actor: item.actorName || t("someone"), email: item.requestEmail ?? "" })
                      : t("joinRequest", { actor: item.actorName || t("someone") })
                    : item.kind === "page_shared"
                    ? t("pageShared", { actor: item.actorName || t("someone") })
                    : item.kind === "comment"
                      ? t("comment", { actor: item.actorName || t("someone") })
                      : item.kind === "mention"
                        ? t("mention", { actor: item.actorName || t("someone") })
                        : item.kind === "reminder"
                          ? t("reminder", { date: item.reminderDate ? formatIsoDate(item.reminderDate, locale) : "" })
                          : item.kind === "automation"
                            ? t("automation", { name: item.automationName ?? "", actor: item.actorName || t("someone") })
                            : t("assignment", { actor: item.actorName || t("someone"), property: item.propertyName ?? "" })}
                  {item.databaseTitle !== null && <> · {pageLabel(item.databaseTitle, tc("untitled"))}</>}
                </span>
              </span>
              <time
                dateTime={new Date(item.createdAt).toISOString()}
                className="shrink-0 pt-0.5 text-xs text-fg-faint"
                title={new Date(item.createdAt).toLocaleString(locale)}
              >
                {relativeTime(item.createdAt, locale)}
              </time>
              {!item.read && <span className="sr-only">{t("unread")}</span>}
            </button>
            {item.approval && (
              <ApprovalActions
                workspaceId={workspaceId}
                approval={item.approval}
                className="pb-2 pl-[2.125rem] pr-3"
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
        ))}
      </ul>
    </Dialog>
  );
}

/** Share (at a level) or decline an access request from the inbox; the notification goes away once answered. */
function AccessRequestActions({ request, onAnswered }: { request: InboxAccessRequest; onAnswered: () => void }) {
  const ts = useTranslations("page.share");
  const [level, setLevel] = useState<ApprovalLevel>("edit");
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
    <div className="pb-2 pl-[2.125rem] pr-3">
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
          {APPROVAL_LEVELS.map((l) => (
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

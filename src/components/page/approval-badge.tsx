"use client";

/**
 * Approvals of a page (server/page-approvals.ts): the badge under its title, saying how its latest
 * request stands ("Approved · by A, B · 3 Nov", "Changed since approval", waiting, changes asked
 * for). It opens the request history (./approval-history, loaded then).
 */
import { BadgeAlert, BadgeCheck, Clock, MessageSquareWarning } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { lazyPart } from "@/components/lazy-part";
import { cn, Popover } from "@/components/ui";
import { badgeState, type ApprovalHeader } from "@/lib/page-approvals";

const ApprovalHistory = lazyPart(() => import("./approval-history").then((m) => m.ApprovalHistory));

const ICONS = { approved: BadgeCheck, changed: BadgeAlert, open: Clock, changes_requested: MessageSquareWarning } as const;

export function ApprovalBadge({
  approval,
  pageId,
  workspaceId,
  currentUserId,
  canRequest,
  canWithdrawAny,
  onAsk,
  onSeeVersion,
  onChanged,
}: {
  approval: ApprovalHeader;
  pageId: string;
  workspaceId: string;
  currentUserId: string;
  /** The reader may ask for approval (edit access, a page or row outside templates and the trash). */
  canRequest: boolean;
  /** The reader has full access, so may withdraw anyone's request. */
  canWithdrawAny: boolean;
  onAsk: () => void;
  /** Opens the page history at a version sent. */
  onSeeVersion: (snapshotId: string) => void;
  /** Something changed here (a request withdrawn): the page loads its header again. */
  onChanged: () => void;
}) {
  const t = useTranslations("page.approval.badge");
  const locale = useLocale();
  const state = badgeState(approval);
  const day = (iso: string) => new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(new Date(iso));
  const label =
    state === "approved"
      ? t("approved", { names: approval.approvedBy.filter(Boolean).join(", "), date: day(approval.decidedAt ?? approval.requestedAt) })
      : state === "changed"
        ? t("changed")
        : state === "open"
          ? t("open", { rule: approval.rule, done: approval.approvedBy.length, total: approval.total })
          : t("changesRequested");
  const Icon = ICONS[state];
  return (
    <Popover
      className="w-80 p-0"
      trigger={({ toggle, open }) => (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          title={t("hint")}
          data-approval={state}
          className={cn(
            "mt-2 inline-flex max-w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs hover:opacity-80",
            state === "approved" ? "bg-added-bg text-added-fg" : "bg-bg-subtle text-fg-muted",
          )}
        >
          <Icon className={cn("h-3.5 w-3.5 shrink-0", state === "changed" && "text-amber-600 dark:text-amber-400")} aria-hidden />
          <span className="truncate">{label}</span>
        </button>
      )}
    >
      {(close) => (
        <ApprovalHistory
          pageId={pageId}
          workspaceId={workspaceId}
          currentUserId={currentUserId}
          canRequest={canRequest}
          canWithdrawAny={canWithdrawAny}
          onAsk={() => {
            close();
            onAsk();
          }}
          onSeeVersion={(id) => {
            close();
            onSeeVersion(id);
          }}
          onChanged={onChanged}
        />
      )}
    </Popover>
  );
}

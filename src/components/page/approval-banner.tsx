"use client";

/**
 * The approver's box under the page's title (server/page-approvals.ts) while they have a decision to
 * make: who asked, their note and due day, Approve and Request changes (which needs a comment), and
 * the version that was sent, which is what they approve when the page changed since. Loaded when
 * such a request waits for the reader.
 */
import { BadgeCheck, CircleAlert, History } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { decideApprovalAction } from "@/app/actions/page-approvals";
import { Button, textareaClass } from "@/components/ui";
import { MAX_APPROVAL_NOTE, type ApprovalDecision, type ApprovalHeader } from "@/lib/page-approvals";

export function ApprovalBanner({
  workspaceId,
  approval,
  onSeeVersion,
  onDone,
}: {
  workspaceId: string;
  approval: ApprovalHeader & { ask: NonNullable<ApprovalHeader["ask"]> };
  onSeeVersion: (snapshotId: string) => void;
  onDone: () => void;
}) {
  const t = useTranslations("page.approval.banner");
  const tc = useTranslations("common");
  const format = useFormatter();
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const { ask } = approval;

  const decide = async (decision: ApprovalDecision) => {
    if (decision === "changes_requested" && !comment.trim()) {
      setError(t("commentNeeded"));
      field.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await decideApprovalAction(workspaceId, approval.id, decision, comment.trim() || null);
      if (!result.ok) return setError(result.error);
      onDone();
    } catch {
      setError(tc("genericError"));
    } finally {
      setBusy(false);
    }
  };

  const sentOn = format.dateTime(new Date(approval.requestedAt), { dateStyle: "medium", timeStyle: "short" });
  return (
    <section data-approval-banner className="mt-3 flex flex-col gap-2 rounded-lg bg-bg-subtle p-3 text-sm">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <BadgeCheck className="h-4 w-4 shrink-0 self-center text-fg-muted" aria-hidden />
        <span className="font-medium text-fg">{t("asked", { name: approval.requestedBy || t("someone") })}</span>
        {ask.dueDate && <span className="text-xs text-fg-faint">{t("due", { date: format.dateTime(new Date(`${ask.dueDate}T12:00:00`), { dateStyle: "medium" }) })}</span>}
      </div>
      {ask.note && <p className="whitespace-pre-wrap text-fg">{ask.note}</p>}
      {approval.changed && (
        <p className="flex items-start gap-1.5 text-[13px] text-fg-muted">
          <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          {t("changed", { date: sentOn })}
        </p>
      )}
      <textarea
        ref={field}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        maxLength={MAX_APPROVAL_NOTE}
        rows={2}
        aria-label={t("commentLabel")}
        placeholder={t("commentPlaceholder")}
        className={textareaClass}
      />
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="primary" disabled={busy} onClick={() => void decide("approved")}>
          {t("approve")}
        </Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void decide("changes_requested")}>
          {t("requestChanges")}
        </Button>
        {ask.snapshotId && (
          <Button size="sm" variant="ghost" className="ms-auto" onClick={() => onSeeVersion(ask.snapshotId!)}>
            <History className="h-3.5 w-3.5" /> {t("seeVersion")}
          </Button>
        )}
      </div>
    </section>
  );
}

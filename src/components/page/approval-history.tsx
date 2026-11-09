"use client";

/**
 * A page's approval requests, newest first (server/page-approvals `approvalHistory`): who asked and
 * when, the note, each approver's decision, comment and time, and the version each was about. Opened
 * from the badge under the title; editors ask again from here, and the requester (or someone with
 * full access) withdraws a request still waiting.
 */
import { CircleAlert, History } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { withdrawApprovalAction } from "@/app/actions/page-approvals";
import { read } from "@/components/read";
import { Button, cn } from "@/components/ui";
import { roundStuck, type ApprovalRound } from "@/lib/page-approvals";

export function ApprovalHistory({
  pageId,
  workspaceId,
  currentUserId,
  canRequest,
  canWithdrawAny,
  onAsk,
  onSeeVersion,
  onChanged,
}: {
  pageId: string;
  workspaceId: string;
  currentUserId: string;
  canRequest: boolean;
  canWithdrawAny: boolean;
  onAsk: () => void;
  onSeeVersion: (snapshotId: string) => void;
  onChanged: () => void;
}) {
  const t = useTranslations("page.approval.history");
  const tRules = useTranslations("page.approval.rules");
  const tc = useTranslations("common");
  const format = useFormatter();
  const [rounds, setRounds] = useState<ApprovalRound[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    read("approvalHistory", pageId)
      .then(setRounds)
      .catch(() => {
        setRounds([]);
        setError(t("loadError"));
      });
  }, [pageId, t]);
  useEffect(load, [load]);

  const when = (iso: string) => format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" });
  const day = (date: string) => format.dateTime(new Date(`${date}T12:00:00`), { dateStyle: "medium" });

  const withdraw = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await withdrawApprovalAction(workspaceId, id);
      if (!result.ok) return setError(result.error);
      load();
      onChanged();
    } catch {
      setError(tc("genericError"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex max-h-[min(70vh,32rem)] flex-col">
      <div className="px-3 pt-3 pb-1 text-sm font-semibold text-fg">{t("title")}</div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
        {rounds === null ? (
          <p className="py-2 text-xs text-fg-faint">{tc("loading")}</p>
        ) : !rounds.length ? (
          <p className="py-2 text-xs text-fg-faint">{t("empty")}</p>
        ) : (
          <ol className="flex flex-col gap-4 pt-1">
            {rounds.map((round) => (
              <li key={round.id} className="flex flex-col gap-1.5" data-approval-round={round.status}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className={cn("text-[13px] font-medium", round.status === "approved" ? "text-added-fg" : "text-fg")}>{t(`status.${round.status}`)}</span>
                  <span className="shrink-0 text-xs text-fg-faint tabular-nums">{when(round.createdAt)}</span>
                </div>
                <p className="text-xs text-fg-faint">
                  {t("asked", { name: round.requestedBy || t("someone") })} · {tRules(round.rule)}
                  {round.dueDate && <> · {t("due", { date: day(round.dueDate) })}</>}
                </p>
                {round.note && <p className="text-sm whitespace-pre-wrap text-fg">{round.note}</p>}
                <ul className="flex flex-col gap-1">
                  {round.decisions.map((d) => (
                    <li key={d.userId} className="text-sm">
                      <span className="text-fg">{d.name || t("someone")}</span>
                      <span className="text-xs text-fg-faint">
                        {" · "}
                        {d.decision
                          ? t(d.decision === "approved" ? "approvedAt" : "changesAt", { date: when(d.decidedAt ?? round.createdAt) })
                          : round.status === "open"
                            ? d.canOpen
                              ? t("waiting")
                              : t("noAccess")
                            : t("noDecision")}
                      </span>
                      {d.comment && <p className="text-[13px] whitespace-pre-wrap text-fg-muted">{d.comment}</p>}
                    </li>
                  ))}
                </ul>
                {roundStuck(round) && (
                  <p className="flex items-start gap-1.5 text-xs text-fg-muted">
                    <CircleAlert className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
                    {t("stuck")}
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-1">
                  {round.snapshotId && (
                    <Button type="button" size="sm" variant="ghost" className="-ms-2" onClick={() => onSeeVersion(round.snapshotId!)}>
                      <History className="h-3.5 w-3.5" /> {t("version")}
                    </Button>
                  )}
                  {round.status === "open" && (round.requestedById === currentUserId || canWithdrawAny) && (
                    <Button type="button" size="sm" variant="ghost" className="hover:text-danger" disabled={busy} onClick={() => void withdraw(round.id)}>
                      {t("withdraw")}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
        {error && (
          <p role="alert" className="pt-1 text-xs text-danger">
            {error}
          </p>
        )}
      </div>
      {canRequest && (
        <div className="border-t border-border p-1">
          <Button type="button" size="sm" variant="ghost" className="w-full justify-start" onClick={onAsk}>
            {t("askAgain")}
          </Button>
        </div>
      )}
    </div>
  );
}

"use client";

import { ClipboardCheck } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RunProposals as Proposals } from "@/app/actions/review";
import { decidePendingChangesAction } from "@/app/actions/review";
import { useChannel } from "@/components/collab/use-channel";
import { read } from "@/components/read";
import { Button, buttonClass } from "@/components/ui";
import { reviewPath } from "@/lib/pending-changes";

/**
 * The rows an agent's run proposed (from email, or as its owners chose), under its message in the
 * agent's chat: how many wait for the person, approved all at once here or one by one in "For
 * review", narrowed to the run. Asked for when the message shows and whenever the workspace's
 * inbox signal says a proposal came or was answered.
 */
export function RunProposals({ workspaceId, runId }: { workspaceId: string; runId: string }) {
  const t = useTranslations("page.agentChat.proposals");
  const [proposals, setProposals] = useState<Proposals | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const asked = useRef(0);

  const load = useCallback(async () => {
    const n = ++asked.current;
    try {
      const result = await read("runProposals", workspaceId, runId);
      if (n === asked.current && result.ok) setProposals(result.data);
    } catch {
      // Offline: the box stays as it was until the next signal.
    }
  }, [workspaceId, runId]);

  useEffect(() => {
    void load();
  }, [load]);
  useChannel(`ws:${workspaceId}`, (event) => {
    if (event === "inbox") void load();
  });

  async function approveAll() {
    if (!proposals?.open.length) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await decidePendingChangesAction(proposals.open, "approve");
      if (!result.ok) setNotice(result.error);
      else {
        const skipped = result.data.filter((o) => !o.ok).length;
        if (skipped) setNotice(t("skipped", { count: skipped }));
      }
      await load();
    } catch {
      setNotice(t("failed"));
    } finally {
      setBusy(false);
    }
  }

  if (!proposals || (!proposals.waiting && !proposals.approved)) return null;
  return (
    <div role="region" aria-label={t("title")} className="mt-2 rounded-lg border border-border p-3" data-run-proposals={runId}>
      <p className="flex items-center gap-2">
        <ClipboardCheck className="h-4 w-4 shrink-0 text-accent" aria-hidden />
        <span>
          {proposals.waiting > 0 ? <span className="font-medium">{t("waiting", { count: proposals.waiting })}</span> : null}
          {proposals.waiting > 0 && proposals.approved > 0 ? <span className="text-fg-muted"> · </span> : null}
          {proposals.approved > 0 ? <span className="text-fg-muted">{t("approved", { count: proposals.approved })}</span> : null}
        </span>
      </p>
      {proposals.waiting > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {proposals.open.length > 0 && (
            <Button size="sm" variant="primary" disabled={busy} onClick={() => void approveAll()}>
              {t("approveAll", { count: proposals.open.length })}
            </Button>
          )}
          <Link href={`${reviewPath(workspaceId)}?run=${encodeURIComponent(runId)}`} className={buttonClass({ size: "sm" })}>
            {t("review")}
          </Link>
        </div>
      )}
      {notice && (
        <p className="mt-2 text-xs text-danger" role="alert">
          {notice}
        </p>
      )}
    </div>
  );
}

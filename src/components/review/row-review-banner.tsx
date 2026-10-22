"use client";

import { ClipboardCheck } from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { rowPendingChangesAction } from "@/app/actions/review";
import { useChannel } from "@/components/collab/use-channel";
import { buttonClass } from "@/components/ui";
import { REVIEW_EVENT, reviewPath, type PendingChangeView } from "@/lib/pending-changes";

/**
 * Changes agents proposed for this row that wait for review (server/pending-changes.ts), as a bar
 * above its properties: how many and by whom, and a link to them in the "For review" page. Looked
 * up when the row opens, when its values change, and whenever its database says a proposal came,
 * went or was answered.
 */
export function RowReviewBanner({ workspaceId, databaseId, rowId, signal }: { workspaceId: string; databaseId: string; rowId: string; signal: number }) {
  const t = useTranslations("review.banner");
  const format = useFormatter();
  const [changes, setChanges] = useState<PendingChangeView[]>([]);
  const asked = useRef(0);

  const load = useCallback(async () => {
    const n = ++asked.current;
    try {
      const result = await rowPendingChangesAction(workspaceId, rowId);
      if (n === asked.current && result.ok) setChanges(result.data);
    } catch {
      // Offline: the bar stays as it was.
    }
  }, [workspaceId, rowId]);

  useEffect(() => {
    void load();
  }, [load, signal]);
  useChannel(`db:${databaseId}`, (event) => {
    if (event === REVIEW_EVENT) void load();
  });

  if (!changes.length) return null;
  // Agents that proposed changes, and automations whose runs wait for an approval.
  const agents = [...new Set(changes.map((c) => c.agent?.name ?? c.approval?.automation?.name).filter((n): n is string => Boolean(n)))];
  return (
    <div role="region" aria-label={t("title")} className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border bg-bg-subtle px-3 py-1.5 text-sm">
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <ClipboardCheck className="h-4 w-4 shrink-0 text-accent" />
        <span className="min-w-0">
          <span className="font-medium">{t("bar", { count: changes.length })}</span>
          {agents.length > 0 && <span className="text-fg-muted"> · {t("by", { names: format.list(agents) })}</span>}
        </span>
      </span>
      <Link href={reviewPath(workspaceId, { rowId })} className={buttonClass({ size: "sm" })}>
        {t("open")}
      </Link>
    </div>
  );
}

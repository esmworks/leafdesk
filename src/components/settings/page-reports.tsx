"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { handlePageReportAction } from "@/app/actions/page-reports";
import { Button, PageIcon, pageLabel } from "@/components/ui";
import type { PageReportView } from "@/server/page-reports";

/**
 * The open reports visitors made about the workspace's published pages (Settings > Security):
 * the page, why and what they wrote, with "Take off the web" (the publication that served it) and
 * "Dismiss".
 */
export function PageReports({ workspaceId, reports, total }: { workspaceId: string; reports: PageReportView[]; total: number }) {
  const t = useTranslations("settings.security.pageReports");
  const tr = useTranslations("publish.report.reasons");
  const tc = useTranslations("common");
  const format = useFormatter();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!reports.length) return <p className="px-5 py-4 text-sm text-fg-muted">{t("none")}</p>;

  const act = (id: string, action: "dismiss" | "unpublish") => {
    setBusy(id);
    setError(null);
    startTransition(async () => {
      const result = await handlePageReportAction(workspaceId, id, action);
      if (!result.ok) setError(result.error);
      router.refresh();
    });
  };

  return (
    <div>
      <ul className="divide-y divide-border" data-page-reports>
        {reports.map((report) => (
          <li key={report.id} className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-start sm:gap-4" data-report={report.id}>
            <div className="min-w-0 flex-1">
              <Link href={`/w/${workspaceId}/p/${report.page.id}`} className="flex min-w-0 items-center gap-1.5 text-sm font-medium hover:underline">
                <PageIcon icon={report.page.icon} kind={report.page.kind === "database" ? "database" : "page"} className="text-sm" />
                <span className="truncate">{pageLabel(report.page.title, tc("untitled"))}</span>
              </Link>
              <p className="mt-0.5 text-xs text-fg-muted">
                {tr(report.reason)} · {t("reportedAt", { when: format.dateTime(new Date(report.createdAt), { dateStyle: "medium", timeStyle: "short" }) })}
                {report.email && <> · {t("from", { email: report.email })}</>}
                {!report.published && <> · {t("offline")}</>}
              </p>
              {report.details && <p className="mt-1 text-sm whitespace-pre-wrap break-words">{report.details}</p>}
            </div>
            <div className="flex shrink-0 gap-2 self-start">
              {report.published && (
                <Button size="sm" variant="danger" disabled={pending && busy === report.id} onClick={() => act(report.id, "unpublish")}>
                  {t("unpublish")}
                </Button>
              )}
              <Button size="sm" disabled={pending && busy === report.id} onClick={() => act(report.id, "dismiss")}>
                {t("dismiss")}
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {(error || total > reports.length) && (
        <p role="status" className={error ? "px-5 py-2 text-xs text-danger" : "px-5 py-2 text-xs text-fg-muted"}>
          {error ?? t("more", { count: total - reports.length })}
        </p>
      )}
    </div>
  );
}

"use client";

/**
 * Settings > Security > Sensitive content (owners): whether saved pages and rows are scanned for
 * card numbers, IBANs, national ID numbers and secrets (server/sensitive-content.ts), and what was
 * found and is still there, each with its page and a way to dismiss it.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { dismissSensitiveFindingAction } from "@/app/actions/sensitive-content";
import { updateWorkspaceSettingsAction } from "@/app/actions/workspaces";
import { Button, PageIcon, pageLabel, Switch } from "@/components/ui";
import type { SensitiveFindingView } from "@/server/sensitive-content";
import { SettingsRow } from "./section";
import { useAction } from "./workspace-settings";

export function SensitiveContentSetting({ workspaceId, enabled }: { workspaceId: string; enabled: boolean }) {
  const t = useTranslations("settings.sensitiveContent");
  const [value, setValue] = useState(enabled);
  const { pending, error, run } = useAction();

  return (
    <SettingsRow
      title={t("toggle")}
      description={error ? <span className="text-danger">{error}</span> : t("toggleDescription")}
      control={
        <Switch
          checked={value}
          label={t("toggle")}
          disabled={pending}
          onChange={(next) => {
            setValue(next);
            run(async () => {
              const result = await updateWorkspaceSettingsAction(workspaceId, { sensitiveContent: next });
              if (!result.ok) setValue(!next);
              return result;
            });
          }}
        />
      }
    />
  );
}

export function SensitiveFindings({ workspaceId, findings, total }: { workspaceId: string; findings: SensitiveFindingView[]; total: number }) {
  const t = useTranslations("settings.sensitiveContent");
  const tc = useTranslations("common");
  const format = useFormatter();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!findings.length) return <p className="px-5 py-4 text-sm text-fg-muted">{t("none")}</p>;

  return (
    <div>
      <ul className="divide-y divide-border" data-sensitive-findings>
        {findings.map((finding) => (
          <li key={finding.id} className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:gap-4" data-finding={finding.id}>
            <div className="min-w-0 flex-1">
              <Link href={`/w/${workspaceId}/p/${finding.page.id}`} className="flex min-w-0 items-center gap-1.5 text-sm font-medium hover:underline">
                <PageIcon icon={finding.page.icon} kind={finding.page.kind === "database" ? "database" : "page"} className="text-sm" />
                <span className="truncate">{pageLabel(finding.page.title, tc("untitled"))}</span>
              </Link>
              <p className="mt-0.5 text-xs text-fg-muted">
                {t(`kinds.${finding.kind}`)} · <span className="tabular-nums">{finding.excerpt}</span> ·{" "}
                {t("foundAt", { when: format.dateTime(new Date(finding.foundAt), { dateStyle: "medium", timeStyle: "short" }) })}
              </p>
            </div>
            <Button
              size="sm"
              className="shrink-0 self-start sm:self-center"
              disabled={pending && busy === finding.id}
              onClick={() => {
                setBusy(finding.id);
                setError(null);
                startTransition(async () => {
                  const result = await dismissSensitiveFindingAction(workspaceId, finding.id);
                  if (!result.ok) setError(result.error);
                  router.refresh();
                });
              }}
            >
              {t("dismiss")}
            </Button>
          </li>
        ))}
      </ul>
      {(error || total > findings.length) && (
        <p role="status" className={error ? "px-5 py-2 text-xs text-danger" : "px-5 py-2 text-xs text-fg-muted"}>
          {error ?? t("more", { count: total - findings.length })}
        </p>
      )}
    </div>
  );
}

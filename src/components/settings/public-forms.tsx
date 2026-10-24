"use client";

import { IconGlyph } from "@/components/builtin-icon";
import { ClipboardList, ExternalLink, Lock } from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { revokeFormPublicationAction } from "@/app/actions/workspaces";
import { SettingsRow } from "@/components/settings/section";
import { useAction } from "@/components/settings/workspace-settings";
import { Button } from "@/components/ui";
import type { WorkspaceFormPublication } from "@/server/forms";

/** Settings > Security, owners only: every form open to the web, each with a way to turn it off. */
export function PublicForms({ workspaceId, forms }: { workspaceId: string; forms: WorkspaceFormPublication[] }) {
  const t = useTranslations("settings.security.forms");
  if (!forms.length) return <SettingsRow title={<span className="font-normal text-fg-muted">{t("empty")}</span>} />;
  return forms.map((f) => <PublicFormRow key={f.viewId} workspaceId={workspaceId} form={f} />);
}

function PublicFormRow({ workspaceId, form: f }: { workspaceId: string; form: WorkspaceFormPublication }) {
  const t = useTranslations("settings.security.forms");
  const tc = useTranslations("common");
  const format = useFormatter();
  const { pending, error, run } = useAction();
  const date = format.dateTime(f.createdAt, { dateStyle: "medium" });

  const title =
    f.title === null ? (
      <span className="inline-flex items-center gap-1.5 text-fg-muted">
        <Lock className="h-3.5 w-3.5" />
        {t("privateForm")}
      </span>
    ) : (
      <Link
        href={`/w/${workspaceId}/p/${f.databaseId}?view=${f.viewId}`}
        className="inline-flex min-w-0 items-center gap-1.5 hover:underline"
      >
        {f.icon ? <IconGlyph icon={f.icon} /> : <ClipboardList className="h-3.5 w-3.5 shrink-0 text-fg-muted" />}
        <span className="truncate">{t("name", { view: f.viewName ?? "", database: f.title || tc("untitled") })}</span>
      </Link>
    );

  return (
    <SettingsRow
      title={title}
      description={
        error ? (
          <span className="text-danger">{error}</span>
        ) : (
          <>
            {f.publishedBy ? t("publishedBy", { name: f.publishedBy, date }) : t("publishedOn", { date })}
            {f.anonymous && <> · {t("anonymous")}</>}
            {f.inTrash && <> · {t("inTrash")}</>}
            {!f.live && !f.inTrash && <> · {t("stale")}</>}
          </>
        )
      }
      control={
        <>
          {f.url && (
            <a
              href={f.url}
              target="_blank"
              rel="noreferrer"
              aria-label={t("open")}
              title={t("open")}
              className="inline-flex h-7 w-7 items-center justify-center rounded text-fg-muted hover:bg-bg-hover hover:text-fg"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
          <Button
            size="sm"
            disabled={pending}
            onClick={() => {
              if (confirm(t("confirm"))) run(() => revokeFormPublicationAction(workspaceId, f.viewId));
            }}
          >
            {t("turnOff")}
          </Button>
        </>
      }
    />
  );
}

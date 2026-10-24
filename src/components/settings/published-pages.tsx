"use client";

import { IconGlyph } from "@/components/builtin-icon";
import { ExternalLink, Globe, Lock } from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { revokePublicationAction } from "@/app/actions/workspaces";
import { SettingsRow } from "@/components/settings/section";
import { useAction } from "@/components/settings/workspace-settings";
import { Button } from "@/components/ui";
import type { WorkspacePublication } from "@/server/publication";

/** Settings > Security, owners only: every published page, each with a way to take it offline. */
export function PublishedPages({ workspaceId, publications }: { workspaceId: string; publications: WorkspacePublication[] }) {
  const t = useTranslations("settings.security.publications");
  if (!publications.length) return <SettingsRow title={<span className="font-normal text-fg-muted">{t("empty")}</span>} />;
  return publications.map((p) => <PublishedPageRow key={p.pageId} workspaceId={workspaceId} publication={p} />);
}

function PublishedPageRow({ workspaceId, publication: p }: { workspaceId: string; publication: WorkspacePublication }) {
  const t = useTranslations("settings.security.publications");
  const tc = useTranslations("common");
  const format = useFormatter();
  const { pending, error, run } = useAction();
  const date = format.dateTime(p.createdAt, { dateStyle: "medium" });

  const title =
    p.title === null ? (
      <span className="inline-flex items-center gap-1.5 text-fg-muted">
        <Lock className="h-3.5 w-3.5" />
        {t("privatePage")}
      </span>
    ) : (
      <Link href={`/w/${workspaceId}/p/${p.pageId}`} className="inline-flex min-w-0 items-center gap-1.5 hover:underline">
        {p.icon ? <IconGlyph icon={p.icon} /> : <Globe className="h-3.5 w-3.5 shrink-0 text-fg-muted" />}
        <span className="truncate">{p.title || tc("untitled")}</span>
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
            {p.publishedBy ? t("publishedBy", { name: p.publishedBy, date }) : t("publishedOn", { date })}
            {p.inTrash && <> · {t("inTrash")}</>}
            {p.indexable && <> · {t("indexable")}</>}
          </>
        )
      }
      control={
        <>
          {p.url && (
            <a
              href={p.url}
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
              if (confirm(t("confirm"))) run(() => revokePublicationAction(workspaceId, p.pageId));
            }}
          >
            {t("unpublish")}
          </Button>
        </>
      }
    />
  );
}

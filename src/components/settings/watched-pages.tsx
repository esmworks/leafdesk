"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { setWatchingAction } from "@/app/actions/page-menu";
import { setTeamspaceWatchingAction } from "@/app/actions/teamspaces";
import { Button, PageIcon } from "@/components/ui";
import { pageLabel } from "@/lib/labels";
import type { WatchedPage, WatchedTeamspace } from "@/server/page-watch";
import { SettingsRow } from "./section";

/**
 * Settings > Preferences: the pages the user chose to watch or edited, and the teamspaces they
 * watch, in every workspace (server/page-watch.ts), each with a way to stop. Stopping mutes a page,
 * so editing it again doesn't bring it back.
 */
export function WatchedPages({ pages: initialPages, teamspaces: initialTeamspaces }: { pages: WatchedPage[]; teamspaces: WatchedTeamspace[] }) {
  const t = useTranslations("settings.notifications");
  const tc = useTranslations("common");
  const [pages, setPages] = useState(initialPages);
  const [teamspaces, setTeamspaces] = useState(initialTeamspaces);
  const [error, setError] = useState(false);
  const [pending, startTransition] = useTransition();

  const stopPage = (page: WatchedPage) =>
    startTransition(async () => {
      setError(false);
      try {
        await setWatchingAction(page.id, false);
        setPages((list) => list.filter((p) => p.id !== page.id));
      } catch {
        setError(true);
      }
    });

  const stopTeamspace = (teamspace: WatchedTeamspace) =>
    startTransition(async () => {
      setError(false);
      const result = await setTeamspaceWatchingAction(teamspace.workspaceId, teamspace.id, false);
      if (result.ok) setTeamspaces((list) => list.filter((s) => s.id !== teamspace.id));
      else setError(true);
    });

  if (!pages.length && !teamspaces.length) {
    return <SettingsRow title={t("watchedNone")} description={t("watchedNoneDescription")} />;
  }
  return (
    <>
      {error && <p className="px-5 pt-4 text-sm text-danger">{tc("genericError")}</p>}
      {teamspaces.map((s) => (
        <SettingsRow
          key={`teamspace:${s.id}`}
          title={
            <span className="flex min-w-0 items-center gap-2">
              <PageIcon icon={s.icon} className="h-4 w-4 shrink-0" />
              <span className="truncate">{s.name}</span>
            </span>
          }
          description={t("watchedTeamspace", { workspace: s.workspaceName })}
          control={
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => stopTeamspace(s)}>
              {t("stopWatching")}
            </Button>
          }
        />
      ))}
      {pages.map((p) => (
        <SettingsRow
          key={`page:${p.id}`}
          title={
            <Link href={`/w/${p.workspaceId}/p/${p.id}`} className="flex min-w-0 items-center gap-2 hover:underline">
              <PageIcon icon={p.icon} className="h-4 w-4 shrink-0" />
              <span className="truncate">{pageLabel(p.title, tc("untitled"))}</span>
            </Link>
          }
          description={p.workspaceName}
          control={
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => stopPage(p)}>
              {t("stopWatching")}
            </Button>
          }
        />
      ))}
    </>
  );
}

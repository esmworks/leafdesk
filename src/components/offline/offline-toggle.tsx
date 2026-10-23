"use client";

import { HardDriveDownload, ListTree } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Switch } from "@/components/ui";
import { formatBytes } from "@/lib/files";
import { pageLabel } from "@/lib/labels";
import { keepPage, keptSummaries, MAX_SUBPAGES, type OfflinePage } from "@/lib/offline";
import { useOffline } from "./offline-context";
import { askToPersist, useDownloading } from "./offline-status";
import { useOfflineState, writeOfflineState } from "./offline-store";

/**
 * "Available offline" in a page's menu (the page header's and the sidebar's): downloads the page to
 * this device and keeps it fresh (offline-download.ts), with its sub-pages (a database: its rows)
 * if asked. Says how it stands: downloading, when it was downloaded and how big it is, or that the
 * page is kept anyway as a favorite or with a page above it.
 */
export function OfflineToggle({ page }: { page: OfflinePage }) {
  const t = useTranslations("offline.keep");
  const tc = useTranslations("common");
  const locale = useLocale();
  const userId = useOffline()?.userId;
  const state = useOfflineState(userId);
  const downloading = useDownloading();
  if (!userId) return null;
  const kept = state.kept.find((p) => p.id === page.id);
  const parent = kept ? undefined : state.kept.find((p) => p.children.some((c) => c.id === page.id));
  const summary = kept ? keptSummaries(state).find((s) => s.page.id === page.id) : undefined;
  const busy = downloading.has(page.id) || Boolean(kept?.children.some((c) => downloading.has(c.id)));

  const set = (change: { manual?: boolean; subpages?: boolean }) => {
    // The first page downloaded asks the browser to keep the copies (it needs this click to).
    if (change.manual && !state.kept.some((p) => p.manual)) void askToPersist();
    writeOfflineState(userId, (s) => keepPage(s, page, change));
  };

  // Kept with a page above it, or as a favorite, it is offline without its own switch on.
  const reason = parent
    ? t("withParent", { title: pageLabel(parent.title, tc("untitled")) })
    : kept && !kept.manual && kept.favorite
      ? t("asFavorite")
      : null;
  let progress: string | null = null;
  if (busy) progress = t("downloading");
  else if (summary && summary.syncedAt !== null)
    progress = t("downloaded", {
      time: new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(summary.syncedAt),
      size: formatBytes(summary.bytes),
    });
  else if (kept) progress = t("pending");
  const status = [reason, progress].filter(Boolean).join(" · ") || null;

  const subLabel = page.kind === "database" ? t("rows") : t("subpages");
  return (
    <>
      <div className="flex items-center gap-2 rounded px-2 py-1.5 text-sm" title={t("hint")}>
        <HardDriveDownload className="h-4 w-4 text-fg-muted" />
        <span className="flex-1">{t("toggle")}</span>
        <Switch checked={Boolean(kept?.manual)} onChange={(on) => set({ manual: on })} label={t("toggle")} />
      </div>
      {/* Rows aren't parents of anything: only pages and databases bring pages along. */}
      {kept?.manual && !page.row && (
        <div
          className="flex items-center gap-2 rounded px-2 py-1.5 text-sm"
          title={page.kind === "database" ? t("rowsHint", { max: MAX_SUBPAGES }) : t("subpagesHint", { max: MAX_SUBPAGES })}
        >
          <ListTree className="h-4 w-4 text-fg-muted" />
          <span className="flex-1">{subLabel}</span>
          <Switch checked={kept.subpages} onChange={(on) => set({ subpages: on })} label={subLabel} />
        </div>
      )}
      {status && <p className="px-2 pb-1 ps-8 text-xs text-fg-faint">{status}</p>}
    </>
  );
}

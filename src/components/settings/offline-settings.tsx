"use client";

import { Trash2 } from "lucide-react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { askToPersist, useDownloading } from "@/components/offline/offline-status";
import { readOfflineState, useOfflineState, writeOfflineState } from "@/components/offline/offline-store";
import { Button, Dialog, IconButton, PageIcon, Switch } from "@/components/ui";
import { formatBytes } from "@/lib/files";
import { pageLabel } from "@/lib/labels";
import { copiesToDrop, keepPage, keptSummaries, setKeepFavorites, wantedPages } from "@/lib/offline";
import { SettingsGroup, SettingsRow } from "./section";

type Storage = { used: number | null; quota: number | null; persisted: boolean | null };

/**
 * Settings > Offline: what this device keeps for offline use (components/offline), read from this
 * browser alone. Keeping favorites offline, how much storage it takes and whether the browser keeps
 * it, the downloaded pages with a way to remove each, and removing everything.
 */
export function OfflineSettings({ userId }: { userId: string }) {
  const t = useTranslations("offline.settings");
  const tc = useTranslations("common");
  const locale = useLocale();
  const state = useOfflineState(userId);
  const downloading = useDownloading();
  const [storage, setStorage] = useState<Storage>({ used: null, quota: null, persisted: null });
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [mounted, setMounted] = useState(false);

  const measure = useCallback(async () => {
    try {
      const [estimate, persisted] = await Promise.all([navigator.storage.estimate(), navigator.storage.persisted()]);
      setStorage({ used: estimate.usage ?? null, quota: estimate.quota ?? null, persisted });
    } catch {
      setStorage({ used: null, quota: null, persisted: null });
    }
  }, []);
  useEffect(() => {
    setMounted(true);
    void measure();
  }, [measure, state]);

  const summaries = keptSummaries(state);
  const wanted = wantedPages(state);
  const unsent = state.dirty.length;
  const recentOnly = state.recent.filter((p) => !wanted.has(p.id)).length;
  const time = (at: number) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(at);

  const removeOne = async (pageId: string) => {
    const page = state.kept.find((p) => p.id === pageId);
    if (!page) return;
    writeOfflineState(userId, (s) => keepPage(s, page, { manual: false }));
    const { removeCopy, syncDownloads } = await import("@/components/offline/offline-download");
    for (const id of copiesToDrop(readOfflineState(userId))) await removeCopy(userId, id);
    // The service worker hears which pages stay (a run in the workspace does this too).
    void syncDownloads(userId);
  };

  const removeAll = async () => {
    setRemoving(true);
    const { removeAllCopies } = await import("@/components/offline/offline-download");
    await removeAllCopies(userId);
    setRemoving(false);
    setConfirming(false);
    void measure();
  };

  // The server render knows nothing of this browser: render the lists once mounted.
  if (!mounted) return null;
  return (
    <div className="space-y-10">
      <SettingsGroup title={t("deviceHeading")}>
        <SettingsRow
          title={t("favorites")}
          description={t("favoritesHint")}
          control={
            <Switch
              checked={state.keepFavorites}
              onChange={(on) => writeOfflineState(userId, (s) => setKeepFavorites(s, on))}
              label={t("favorites")}
            />
          }
        />
        <SettingsRow
          title={t("storage")}
          description={
            <>
              {storage.used !== null && storage.quota !== null
                ? t("storageUsed", { used: formatBytes(storage.used), quota: formatBytes(storage.quota) })
                : t("storageUnknown")}
              {storage.persisted !== null && <> {storage.persisted ? t("persisted") : t("notPersisted")}</>}
            </>
          }
          control={
            storage.persisted === false && (
              <Button size="sm" variant="ghost" onClick={() => void askToPersist().then(measure)}>
                {t("askPersist")}
              </Button>
            )
          }
        />
      </SettingsGroup>

      <SettingsGroup title={t("pagesHeading")} description={t("pagesDescription")}>
        {summaries.length === 0 && <SettingsRow title={t("none")} />}
        {summaries.map(({ page, bytes, syncedAt, unsent: pageUnsent }) => {
          const busy = downloading.has(page.id) || page.children.some((c) => downloading.has(c.id));
          const details = [
            busy ? null : syncedAt !== null ? t("synced", { time: time(syncedAt), size: formatBytes(bytes) }) : t("notYet"),
            page.children.length > 0 ? t("subpageCount", { count: page.children.length }) : null,
            page.favorite ? t("favorite") : null,
          ].filter(Boolean);
          return (
            <SettingsRow
              key={page.id}
              title={
                <Link href={`/w/${page.workspaceId}/p/${page.id}`} className="flex min-w-0 items-center gap-2 hover:underline">
                  <PageIcon icon={page.icon} kind={page.kind} className="h-4 w-4 shrink-0" />
                  <span className="truncate">{pageLabel(page.title, tc("untitled"))}</span>
                </Link>
              }
              description={
                <>
                  {busy && <span>{tc("loading")} </span>}
                  {details.join(" · ")}
                  {pageUnsent && <span className="ms-2 font-medium text-fg">{t("unsent")}</span>}
                </>
              }
              control={
                page.manual ? (
                  <IconButton label={tc("remove")} onClick={() => void removeOne(page.id)}>
                    <Trash2 className="h-4 w-4" />
                  </IconButton>
                ) : (
                  <span className="max-w-56 text-xs text-fg-faint">{t("favoriteOnly")}</span>
                )
              }
            />
          );
        })}
        <SettingsRow title={t("recent", { count: recentOnly })} />
      </SettingsGroup>

      <SettingsGroup bare>
        <div className="flex flex-col gap-3 rounded-xl border border-border px-5 py-4 sm:flex-row sm:items-center sm:gap-6">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">{t("removeAll")}</div>
            <div className="mt-1 text-sm text-fg-muted">{t("removeAllDescription")}</div>
          </div>
          <Button variant="danger" size="sm" onClick={() => setConfirming(true)}>
            {t("removeAll")}
          </Button>
        </div>
      </SettingsGroup>

      <Dialog open={confirming} onClose={() => setConfirming(false)} className="max-w-md">
        <div className="space-y-3 p-5">
          <h2 className="text-base font-semibold">{t("removeAllTitle")}</h2>
          <p className="text-sm text-fg-muted">{t("removeAllBody")}</p>
          {unsent > 0 && <p className="text-sm font-medium text-danger">{t("removeAllUnsent", { count: unsent })}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              {tc("cancel")}
            </Button>
            <Button variant="danger" disabled={removing} onClick={() => void removeAll()}>
              {t("removeAllConfirm")}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

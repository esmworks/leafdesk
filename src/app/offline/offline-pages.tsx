"use client";

import { RotateCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Button, PageIcon, pageLabel } from "@/components/ui";
import { readOfflineState } from "@/components/offline/offline-store";
import { OFFLINE_STATE_PREFIX, type RecentPage } from "@/lib/offline";
import { sameOriginPath } from "@/lib/same-origin";

/**
 * Pages this browser kept, most recent first. Only one person's list can be here: another user's
 * is wiped when they sign in (see OfflineProvider). Plain links, so the service worker answers
 * them from its copies.
 */
export function OfflinePages() {
  const t = useTranslations("offline.page");
  const tc = useTranslations("common");
  const [pages, setPages] = useState<(RecentPage & { dirty: boolean })[] | null>(null);
  const [back, setBack] = useState<string | null>(null);

  useEffect(() => {
    let userId: string | null = null;
    try {
      const key = Object.keys(localStorage).find((k) => k.startsWith(OFFLINE_STATE_PREFIX));
      userId = key ? key.slice(OFFLINE_STATE_PREFIX.length) : null;
    } catch {}
    const state = userId ? readOfflineState(userId) : null;
    setPages(state ? state.recent.map((p) => ({ ...p, dirty: state.dirty.includes(p.id) })) : []);
    // The service worker sends people here from the page they asked for; "Try again" goes back there.
    const from = new URLSearchParams(window.location.search).get("from");
    setBack(sameOriginPath(from, window.location.origin) ?? "/");
  }, []);

  return (
    <>
      {pages && pages.length > 0 && (
        <section className="mt-5">
          <h2 className="mb-1 text-xs font-medium text-fg-muted">{t("saved")}</h2>
          <ul className="-mx-2 max-h-80 overflow-y-auto">
            {pages.map((p) => (
              <li key={p.id}>
                {/* A full navigation: the service worker serves the copy it kept. */}
                <a
                  href={`/w/${p.workspaceId}/p/${p.id}`}
                  className="flex h-8 items-center gap-2 rounded-md px-2 text-sm hover:bg-bg-hover"
                >
                  <PageIcon icon={p.icon} kind="page" className="text-sm" />
                  <span className="min-w-0 flex-1 truncate">{pageLabel(p.title, tc("untitled"))}</span>
                  {p.dirty && <span className="shrink-0 text-xs text-fg-faint">{t("unsynced")}</span>}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
      {pages && pages.length === 0 && <p className="mt-5 text-sm text-fg-muted">{t("empty")}</p>}
      <div className="mt-5 flex justify-end">
        <Button onClick={() => window.location.assign(back ?? "/")}>
          <RotateCw className="h-3.5 w-3.5" /> {t("retry")}
        </Button>
      </div>
    </>
  );
}

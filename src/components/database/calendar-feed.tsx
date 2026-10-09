"use client";

import { CalendarSync } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { createCalendarFeedAction, deleteCalendarFeedAction, getCalendarFeedAction, type ActionResult } from "@/app/actions/databases";
import { useIsOffline } from "@/components/offline/offline-context";
import { CopyButton } from "@/components/settings/copy-button";
import { Button, Dialog, IconButton, Input } from "@/components/ui";
import type { CalendarFeedInfo } from "@/server/calendar-feeds";

/**
 * Subscribing to a calendar view from a calendar app (see server/calendar-feeds): makes the
 * viewer's own secret address, shown once, or a new one in its place, or turns it off.
 */
export function CalendarFeedButton({ viewId }: { viewId: string }) {
  const t = useTranslations("database.calendar.feed");
  const offline = useIsOffline();
  const [open, setOpen] = useState(false);
  if (offline) return null;
  return (
    <>
      <IconButton label={t("open")} onClick={() => setOpen(true)} className="h-7 w-7 rounded-md">
        <CalendarSync className="h-4 w-4" />
      </IconButton>
      {open && <CalendarFeedDialog viewId={viewId} onClose={() => setOpen(false)} />}
    </>
  );
}

function CalendarFeedDialog({ viewId, onClose }: { viewId: string; onClose: () => void }) {
  const t = useTranslations("database.calendar.feed");
  const tc = useTranslations("common");
  const te = useTranslations("database.errors");
  const format = useFormatter();
  const [info, setInfo] = useState<CalendarFeedInfo | null>(null);
  // The address just made: shown until the dialog closes, never again.
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    getCalendarFeedAction(viewId).then(
      (result) => current && (result.ok ? setInfo(result.data) : setError(result.error)),
      () => current && setError(tc("genericError")),
    );
    return () => {
      current = false;
    };
  }, [viewId, tc]);

  const run = async <T,>(action: () => Promise<ActionResult<T>>, done: (data: T) => void) => {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (result.ok) done(result.data);
      else setError(result.error);
    } catch {
      setError(tc("genericError"));
    } finally {
      setBusy(false);
    }
  };
  const create = () =>
    run(
      () => createCalendarFeedAction(viewId),
      (address) => {
        setUrl(address);
        setInfo((old) => old && { ...old, feed: { createdAt: new Date(), lastUsedAt: null } });
      },
    );
  const remove = () =>
    run(
      () => deleteCalendarFeedAction(viewId),
      () => {
        setUrl(null);
        setInfo((old) => old && { ...old, feed: null });
      },
    );

  return (
    <Dialog open onClose={onClose} className="max-w-md">
      <div className="space-y-3 p-4">
        <h2 className="text-sm font-medium">{t("title")}</h2>
        <p className="text-sm text-fg-muted">{t("description")}</p>
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
        {info && !info.allowed && <p className="text-xs text-fg-muted">{te("calendarFeedExportOff")}</p>}
        {url && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Input readOnly value={url} aria-label={t("address")} onFocus={(e) => e.currentTarget.select()} />
              <CopyButton value={url} />
            </div>
            <p className="text-xs text-fg-muted">{t("shownOnce")}</p>
            <a href={url.replace(/^https?:/, "webcal:")} className="text-xs text-accent underline underline-offset-2">
              {t("openInApp")}
            </a>
          </div>
        )}
        {info?.feed && !url && (
          <p className="text-xs text-fg-muted">
            {t("active", {
              created: format.dateTime(new Date(info.feed.createdAt), { dateStyle: "medium" }),
            })}{" "}
            {info.feed.lastUsedAt
              ? t("lastRead", { time: format.relativeTime(new Date(info.feed.lastUsedAt)) })
              : t("neverRead")}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          {info?.feed && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={remove}>
              {t("turnOff")}
            </Button>
          )}
          {info?.allowed && (
            <Button size="sm" variant={info.feed ? "secondary" : "primary"} disabled={busy} onClick={create}>
              {info.feed ? t("replace") : t("create")}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onClose}>
            {tc("close")}
          </Button>
        </div>
        {info?.feed && !url && <p className="text-xs text-fg-faint">{t("replaceHint")}</p>}
      </div>
    </Dialog>
  );
}

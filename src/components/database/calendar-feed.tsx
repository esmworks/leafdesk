"use client";

import { CalendarSync } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import {
  createAssignedCalendarFeedAction,
  createCalendarFeedAction,
  deleteAssignedCalendarFeedAction,
  deleteCalendarFeedAction,
  getAssignedCalendarFeedAction,
  getCalendarFeedAction,
  type ActionResult,
} from "@/app/actions/databases";
import { useIsOffline } from "@/components/offline/offline-context";
import { CopyButton } from "@/components/settings/copy-button";
import { Button, Dialog, DialogBody, DialogFooter, DialogTitle, IconButton, Input } from "@/components/ui";
import type { CalendarFeedInfo } from "@/server/calendar-feeds";

/** The feed a button is about: a calendar view's, or the rows assigned to the viewer in a workspace. */
type FeedOf = { viewId: string; workspaceId?: undefined } | { workspaceId: string; viewId?: undefined };

/**
 * Subscribing to a calendar view from a calendar app (see server/calendar-feeds): makes the
 * viewer's own secret address, shown once, or a new one in its place, or turns it off.
 */
export function CalendarFeedButton({ viewId }: { viewId: string }) {
  return <FeedButton of={{ viewId }} />;
}

/** The same for the rows assigned to the viewer across the workspace (the home page's list). */
export function AssignedCalendarFeedButton({ workspaceId }: { workspaceId: string }) {
  return <FeedButton of={{ workspaceId }} labelled />;
}

/** In a view's toolbar it is an icon; beside a heading it says what it does. */
function FeedButton({ of, labelled }: { of: FeedOf; labelled?: boolean }) {
  const t = useTranslations("database.calendar.feed");
  const offline = useIsOffline();
  const [open, setOpen] = useState(false);
  if (offline) return null;
  return (
    <>
      {labelled ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          title={t("open")}
          className="flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-xs text-fg-muted hover:bg-bg-hover hover:text-fg"
        >
          <CalendarSync className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{t("open")}</span>
        </button>
      ) : (
        <IconButton label={t("open")} onClick={() => setOpen(true)} className="h-7 w-7 rounded-md">
          <CalendarSync className="h-4 w-4" />
        </IconButton>
      )}
      {open && <CalendarFeedDialog of={of} onClose={() => setOpen(false)} />}
    </>
  );
}

function CalendarFeedDialog({ of: { viewId, workspaceId }, onClose }: { of: FeedOf; onClose: () => void }) {
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
    (viewId ? getCalendarFeedAction(viewId) : getAssignedCalendarFeedAction(workspaceId!)).then(
      (result) => current && (result.ok ? setInfo(result.data) : setError(result.error)),
      () => current && setError(tc("genericError")),
    );
    return () => {
      current = false;
    };
  }, [viewId, workspaceId, tc]);

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
      () => (viewId ? createCalendarFeedAction(viewId) : createAssignedCalendarFeedAction(workspaceId!)),
      (address) => {
        setUrl(address);
        setInfo((old) => old && { ...old, feed: { createdAt: new Date(), lastUsedAt: null } });
      },
    );
  const remove = () =>
    run(
      () => (viewId ? deleteCalendarFeedAction(viewId) : deleteAssignedCalendarFeedAction(workspaceId!)),
      () => {
        setUrl(null);
        setInfo((old) => old && { ...old, feed: null });
      },
    );

  return (
    <Dialog open onClose={onClose} className="max-w-md">
      <DialogBody className="pt-5">
        <div className="space-y-1.5">
          <DialogTitle>{t("title")}</DialogTitle>
          <p className="text-sm text-fg-muted">{t(viewId ? "description" : "assignedDescription")}</p>
        </div>
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
            <p className="text-xs text-fg-muted">{t(viewId ? "shownOnce" : "assignedShownOnce")}</p>
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
              ? t("lastRead", { time: format.relativeTime(new Date(info.feed.lastUsedAt), new Date()) })
              : t("neverRead")}
          </p>
        )}
        {info?.feed && !url && <p className="text-xs text-fg-faint">{t("replaceHint")}</p>}
      </DialogBody>
      <DialogFooter>
        {info?.feed && (
          <Button variant="ghost" disabled={busy} onClick={remove}>
            {t("turnOff")}
          </Button>
        )}
        <Button variant="secondary" onClick={onClose}>
          {tc("close")}
        </Button>
        {info?.allowed && (
          <Button variant={info.feed ? "secondary" : "primary"} disabled={busy} onClick={create}>
            {info.feed ? t("replace") : t("create")}
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}

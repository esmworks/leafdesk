"use client";

import { CalendarDays, NotebookPen } from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { IconGlyph } from "@/components/builtin-icon";
import { read } from "@/components/read";
import { PanelEmpty, panelHeading, panelIcon, panelMeta, panelMore, panelRow, panelRowActive, panelSection } from "@/components/sidebar/panel";
import { cn } from "@/components/ui";
import { isUpcoming, SIDEBAR_MEETINGS, type MeetingListItem } from "@/lib/meeting-list";

/** How often the list is read again while the tab is shown. */
const MEETINGS_MS = 60_000;

export type MeetingPanelProps = {
  workspaceId: string;
  /** The page shown, to mark its meeting and read the list again as it changes. */
  pathname: string;
  offline: boolean;
  /** The pages the list holds, so the tab stays while one of them is open. */
  onPages: (ids: Set<string>) => void;
};

/**
 * The sidebar's Meetings tab: the Meetings page, then the planned meetings and the latest past
 * ones (server/meetings.ts listMeetings), each opening its page.
 */
export function MeetingPanel({ workspaceId, pathname, offline, onPages }: MeetingPanelProps) {
  const t = useTranslations("meetings");
  const format = useFormatter();
  const [meetings, setMeetings] = useState<MeetingListItem[] | null>(null);

  const load = useCallback(() => {
    if (document.visibilityState !== "visible") return;
    read("sidebarMeetings", workspaceId)
      .then((result) => {
        if (!result.ok) return;
        setMeetings(result.data);
        onPages(new Set(result.data.map((m) => m.pageId)));
      })
      .catch(() => {});
  }, [workspaceId, onPages]);
  // Read again as the person moves on too, so a note made, renamed or recorded shows.
  useEffect(() => {
    if (offline) return;
    load();
    const timer = setInterval(load, MEETINGS_MS);
    document.addEventListener("visibilitychange", load);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, [offline, load, pathname]);

  const meetingsPath = `/w/${workspaceId}/meetings`;
  const now = Date.now();
  const upcoming = (meetings ?? []).filter((m) => isUpcoming(m, now)).reverse();
  const past = (meetings ?? []).filter((m) => !isUpcoming(m, now));
  const today = new Date(now).toDateString();
  const thisYear = new Date(now).getFullYear();
  const when = (m: MeetingListItem) => {
    const at = m.startedAt ?? m.scheduledAt;
    if (!at) return null;
    const date = new Date(at);
    if (date.toDateString() === today) return format.dateTime(date, { timeStyle: "short" });
    return format.dateTime(date, date.getFullYear() === thisYear ? { day: "numeric", month: "short" } : { dateStyle: "medium" });
  };
  const row = (m: MeetingListItem) => {
    const href = `/w/${workspaceId}/p/${m.pageId}`;
    const status = m.status === "recording" ? t("statusRecording") : m.status === "summarizing" ? t("statusSummarizing") : null;
    const at = when(m);
    const current = pathname === href;
    return (
      <li key={`${m.pageId}:${m.meetingId}`}>
        <Link href={href} aria-current={current ? "page" : undefined} className={cn(panelRow, current && panelRowActive)}>
          <span className="flex h-4 w-4 shrink-0 items-center justify-center text-fg-icon">
            {m.icon ? <IconGlyph icon={m.icon} className="text-sm" /> : <NotebookPen className="h-4 w-4" aria-hidden />}
          </span>
          <span className="min-w-0 flex-1 truncate">{m.title.trim() || m.pageTitle.trim() || t("untitled")}</span>
          {status && <span role="img" aria-label={status} title={status} className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger motion-safe:animate-pulse" />}
          {at && <span className={cn("shrink-0", panelMeta)}>{at}</span>}
        </Link>
      </li>
    );
  };

  return (
    <div className="flex flex-col">
      <ul className="space-y-px">
        <li>
          <Link href={meetingsPath} aria-current={pathname === meetingsPath ? "page" : undefined} className={cn(panelRow, pathname === meetingsPath && panelRowActive)}>
            <CalendarDays className={panelIcon} aria-hidden />
            <span className="min-w-0 flex-1 truncate">{t("panel.all")}</span>
          </Link>
        </li>
      </ul>
      {upcoming.length > 0 && (
        <section aria-labelledby="meetings-upcoming-heading" className={panelSection}>
          <h3 id="meetings-upcoming-heading" className={panelHeading}>
            {t("upcoming")}
          </h3>
          <ul className="space-y-px">{upcoming.map(row)}</ul>
        </section>
      )}
      {past.length > 0 && (
        <section aria-labelledby="meetings-past-heading" className={panelSection}>
          <h3 id="meetings-past-heading" className={panelHeading}>
            {t("past")}
          </h3>
          <ul className="space-y-px">{past.map(row)}</ul>
        </section>
      )}
      {meetings?.length === 0 && <PanelEmpty className={panelSection}>{t("panel.empty")}</PanelEmpty>}
      {meetings && meetings.length >= SIDEBAR_MEETINGS && (
        <Link href={meetingsPath} className={panelMore}>
          {t("panel.more")}
        </Link>
      )}
    </div>
  );
}

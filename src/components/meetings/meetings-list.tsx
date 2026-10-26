"use client";

import { Loader2, NotebookPen, Plus, Search } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { createMeetingNoteAction } from "@/app/actions/meetings";
import { IconGlyph } from "@/components/builtin-icon";
import { Button, Input } from "@/components/ui";
import { UserAvatar } from "@/components/user-avatar";
import { isUpcoming, matchesMeeting, type MeetingListItem } from "@/lib/meeting-list";

/** The Meetings page (/w/[id]/meetings): upcoming and past meeting notes, filtered as you type. */
export function MeetingsList({ workspaceId, meetings, now }: { workspaceId: string; meetings: MeetingListItem[]; now: Date }) {
  const t = useTranslations("meetings");
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = useMemo(() => meetings.filter((m) => matchesMeeting(m, query)), [meetings, query]);
  const upcoming = shown.filter((m) => isUpcoming(m, now.getTime())).reverse();
  const past = shown.filter((m) => !isUpcoming(m, now.getTime()));

  const create = async () => {
    setCreating(true);
    setError(null);
    const res = await createMeetingNoteAction(workspaceId).catch(() => null);
    if (res?.ok) return router.push(`/w/${workspaceId}/p/${res.data.id}`);
    setCreating(false);
    setError(res?.error ?? t("errors.failed"));
  };

  return (
    <div className="page-gutter pt-[4.25rem] pb-12">
      <header className="mb-6 flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold leading-tight md:text-3xl">{t("heading")}</h1>
          <p className="mt-2 text-sm text-fg-muted">{t("description")}</p>
        </div>
        <Button variant="primary" onClick={() => void create()} disabled={creating}>
          {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          {t("newMeeting")}
        </Button>
      </header>
      {error && (
        <p role="alert" className="mb-4 text-sm text-danger">
          {error}
        </p>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative min-w-0 flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute top-1/2 inset-s-2 h-3.5 w-3.5 -translate-y-1/2 text-fg-faint" />
          <Input type="search" aria-label={t("search")} placeholder={t("search")} value={query} onChange={(e) => setQuery(e.target.value)} className="w-full ps-7" />
        </div>
        <span className="text-sm text-fg-muted" aria-live="polite">
          {t("count", { count: shown.length })}
        </span>
      </div>

      {meetings.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-fg-muted">{t("empty")}</p>
      ) : shown.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-fg-muted">{t("noMatches")}</p>
      ) : (
        <div className="space-y-8">
          {upcoming.length > 0 && <Group title={t("upcoming")} items={upcoming} workspaceId={workspaceId} />}
          {past.length > 0 && <Group title={t("past")} items={past} workspaceId={workspaceId} />}
        </div>
      )}
    </div>
  );
}

function Group({ title, items, workspaceId }: { title: string; items: MeetingListItem[]; workspaceId: string }) {
  return (
    <section>
      <h2 className="mb-2 text-sm font-medium text-fg-muted">{title}</h2>
      <ul className="divide-y divide-border rounded-xl border border-border">
        {items.map((m) => (
          <li key={`${m.pageId}:${m.meetingId}`}>
            <Row item={m} workspaceId={workspaceId} />
          </li>
        ))}
      </ul>
    </section>
  );
}

const STATUS_KEYS = { recording: "statusRecording", summarizing: "statusSummarizing" } as const;

function Row({ item, workspaceId }: { item: MeetingListItem; workspaceId: string }) {
  const t = useTranslations("meetings");
  const tc = useTranslations("common");
  const format = useFormatter();
  const when = item.startedAt ?? item.scheduledAt;
  const title = item.title.trim() || item.pageTitle.trim() || t("untitled");
  const status = STATUS_KEYS[item.status as keyof typeof STATUS_KEYS];
  return (
    <Link href={`/w/${workspaceId}/p/${item.pageId}`} className="flex items-start gap-3 px-4 py-3 hover:bg-bg-hover">
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center text-fg-muted">{item.icon ? <IconGlyph icon={item.icon} /> : <NotebookPen className="h-4 w-4" aria-hidden />}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="truncate text-sm font-medium">{title}</span>
          {status && <span className="shrink-0 text-xs text-danger">{t(status)}</span>}
        </span>
        {item.title.trim() && item.pageTitle.trim() && item.pageTitle.trim() !== item.title.trim() && (
          <span className="block truncate text-xs text-fg-muted">{item.pageTitle || tc("untitled")}</span>
        )}
        {item.preview && <span className="mt-0.5 block truncate text-sm text-fg-muted">{item.preview}</span>}
        <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted">
          {when && <time dateTime={when}>{format.dateTime(new Date(when), { dateStyle: "medium", timeStyle: "short" })}</time>}
          <span>{item.seconds > 0 ? t("duration", { minutes: Math.max(1, Math.round(item.seconds / 60)) }) : t("notRecorded")}</span>
          {item.attendees.length > 0 && (
            <span className="flex items-center gap-1" title={item.attendees.map((a) => a.name).join(", ")}>
              <span className="flex -space-x-1 rtl:space-x-reverse">
                {item.attendees.slice(0, 4).map((a) => (
                  <UserAvatar key={a.id || a.name} name={a.name} size="sm" className="ring-2 ring-bg" />
                ))}
              </span>
              {t("attendeeCount", { count: item.attendees.length })}
            </span>
          )}
        </span>
      </span>
    </Link>
  );
}

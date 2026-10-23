"use client";

import { CalendarClock, ChevronRight, CircleStop, Loader2, Mic, NotebookPen, Pause, Play, Plus, RefreshCw, Search, X } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { mentionCandidatesAction } from "@/app/actions/mentions";
import { regenerateMeetingSummaryAction, finishMeetingAction } from "@/app/actions/meetings";
import { Button, cn, Popover, textareaClass } from "@/components/ui";
import { UserAvatar } from "@/components/user-avatar";
import { useMeetingRecorder } from "@/components/voice/meeting-recorder";
import {
  chunkAt,
  formatStamp,
  isStale,
  MAX_ATTENDEES,
  MAX_MEETING_SECONDS,
  MAX_MEETING_TITLE,
  MEETING_NOTICES,
  parseAttendees,
  parseTakeaways,
  parseTranscript,
  serializeAttendees,
  takeawayLine,
  type Attendee,
  type MeetingProps,
  type Takeaway,
  type TranscriptChunk,
} from "@/lib/meetings";

type Change = Partial<MeetingProps>;

/** `datetime-local` value of an ISO time, in the browser's time zone. */
function localInput(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "";
  const d = new Date(time);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * A meeting block's view (see meeting-block.tsx): the meeting's details people fill in, the
 * recording's controls while the workspace's recorder (components/voice/meeting-recorder) records
 * it, and the summary, decisions and action items once it is written up, each linking to the
 * transcript line it comes from.
 */
export function MeetingView({
  props,
  editable,
  pageId,
  onChange,
}: {
  props: MeetingProps;
  editable: boolean;
  pageId: string | null;
  onChange: (change: Change) => void;
}) {
  const t = useTranslations("meetings.block");
  const tm = useTranslations("meetings");
  const recorder = useMeetingRecorder();
  const chunks = useMemo(() => parseTranscript(props.transcript), [props.transcript]);
  const attendees = useMemo(() => parseAttendees(props.attendees), [props.attendees]);
  const [transcriptOpen, setTranscriptOpen] = useState(props.status === "recording");
  const [highlight, setHighlight] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lines = useRef(new Map<number, HTMLLIElement>());
  // Rendered again each half second while recording (the time), and when a piece comes in.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (props.status !== "recording" && props.status !== "summarizing") return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [props.status]);

  const mine = recorder?.current?.meetingId === props.meetingId ? recorder.current : null;
  const recordingElsewhere = recorder?.current && !mine;
  const problem = recorder?.problem?.meetingId === props.meetingId ? recorder.problem.message : null;
  const stale = isStale(props, now);
  const sttOff = !recorder?.limits;

  // The transcript opens while recording, so its lines can be seen coming in.
  useEffect(() => {
    if (mine?.status === "recording") setTranscriptOpen(true);
  }, [mine?.status]);

  const jump = (seconds: number) => {
    const chunk = chunkAt(chunks, seconds);
    if (!chunk) return;
    setTranscriptOpen(true);
    setHighlight(chunk.c);
    requestAnimationFrame(() => lines.current.get(chunk.c)?.scrollIntoView({ block: "center", behavior: "smooth" }));
  };

  const run = async (action: () => Promise<{ ok: boolean; error?: string } | null>) => {
    setBusy(true);
    setActionError(null);
    const res = await action().catch(() => null);
    setBusy(false);
    if (!res?.ok) setActionError(res?.error ?? tm("errors.failed"));
  };

  const start = () => {
    if (!recorder || !pageId) return;
    void recorder.start(pageId, props.meetingId, props.title);
  };

  const status = mine ? mine.status : props.status;
  const starting = mine?.status === "starting";
  const recordedSeconds = mine ? mine.seconds : props.seconds;
  const recordingByOther = props.status === "recording" && !mine && !stale;
  const canStart = editable && !!pageId && !sttOff && !recordingElsewhere && !recorder?.current && (props.status === "" || ((props.status === "recording" || props.status === "summarizing") && stale));
  const showTakeaways = props.status === "done" || Boolean(props.summary || props.decisions || props.actions);

  return (
    <section aria-label={props.title || t("label")} className="my-1 w-full rounded-lg border border-border bg-bg p-4">
      <Header props={props} attendees={attendees} editable={editable} pageId={pageId} onChange={onChange} />

      {/* Recording */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {mine && mine.status !== "starting" ? (
          <>
            <span className="flex items-center gap-2 text-sm">
              <span className={cn("h-2.5 w-2.5 rounded-full", mine.status === "recording" ? "animate-pulse bg-danger" : "bg-fg-faint")} aria-hidden />
              <span className="font-medium">{mine.status === "paused" ? t("paused") : mine.status === "finishing" ? t("finishing") : t("recording")}</span>
              <span className="tabular-nums text-fg-muted">{formatStamp(mine.seconds)}</span>
              <span className="text-xs text-fg-faint">/ {formatStamp(MAX_MEETING_SECONDS)}</span>
            </span>
            {mine.status !== "finishing" && (
              <span className="ms-auto flex items-center gap-1.5">
                {mine.status === "paused" ? (
                  <Button size="sm" onClick={recorder!.resume}>
                    <Play className="h-3.5 w-3.5" />
                    {t("resume")}
                  </Button>
                ) : (
                  <Button size="sm" onClick={recorder!.pause}>
                    <Pause className="h-3.5 w-3.5" />
                    {t("pause")}
                  </Button>
                )}
                <Button size="sm" variant="danger" onClick={recorder!.stop}>
                  <CircleStop className="h-3.5 w-3.5" />
                  {t("stop")}
                </Button>
              </span>
            )}
          </>
        ) : props.status === "summarizing" && !stale ? (
          <span className="flex items-center gap-2 text-sm text-fg-muted">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            {t("summarizing")}
          </span>
        ) : recordingByOther ? (
          <span className="flex items-center gap-2 text-sm text-fg-muted">
            <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-danger" aria-hidden />
            {props.recorderName ? t("recordingBy", { name: props.recorderName }) : t("recording")}
            <span className="tabular-nums">{formatStamp(props.seconds)}</span>
          </span>
        ) : (
          (props.status === "" || stale) &&
          editable && (
            <>
              {stale && props.status !== "" && <span className="text-sm text-fg-muted">{t("interrupted")}</span>}
              <Button size="sm" variant={props.status === "" ? "primary" : "secondary"} disabled={!canStart} onClick={start} title={sttOff ? t("sttOff") : undefined}>
                {starting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Mic className="h-3.5 w-3.5" />}
                {props.status === "" ? t("start") : t("continue")}
              </Button>
              {stale && props.status === "recording" && pageId && (
                <Button size="sm" disabled={busy} onClick={() => void run(() => finishMeetingAction(pageId, props.meetingId))}>
                  <CircleStop className="h-3.5 w-3.5" />
                  {t("endMeeting")}
                </Button>
              )}
              {props.status === "" && <span className="text-xs text-fg-muted">{sttOff ? t("sttOff") : recordingElsewhere ? t("recordingElsewhere") : t("limit", { hours: MAX_MEETING_SECONDS / 3600 })}</span>}
            </>
          )
        )}
      </div>
      {(problem || actionError) && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {problem ?? actionError}
        </p>
      )}
      {mine && mine.gaps > 0 && <p className="mt-2 text-xs text-fg-muted">{t("gapsLeft", { count: mine.gaps })}</p>}
      {(MEETING_NOTICES as readonly string[]).includes(props.notice) && props.status === "done" && (
        <p className="mt-2 text-sm text-fg-muted">{tm(`notices.${props.notice as (typeof MEETING_NOTICES)[number]}`)}</p>
      )}

      {showTakeaways && (
        <Takeaways
          props={props}
          editable={editable && status === "done"}
          busy={busy}
          onJump={jump}
          onChange={onChange}
          onRegenerate={pageId && chunks.length ? () => void run(() => regenerateMeetingSummaryAction(pageId, props.meetingId)) : undefined}
        />
      )}

      <Transcript
        chunks={chunks}
        open={transcriptOpen}
        onToggle={() => setTranscriptOpen((v) => !v)}
        highlight={highlight}
        lines={lines.current}
        live={status === "recording"}
        seconds={recordedSeconds}
      />
    </section>
  );
}

/** Title, when and who: what people fill in before (or after) the meeting. */
function Header({
  props,
  attendees,
  editable,
  pageId,
  onChange,
}: {
  props: MeetingProps;
  attendees: Attendee[];
  editable: boolean;
  pageId: string | null;
  onChange: (change: Change) => void;
}) {
  const t = useTranslations("meetings.block");
  const tm = useTranslations("meetings");
  const format = useFormatter();
  const [title, setTitle] = useState(props.title);
  const [focused, setFocused] = useState(false);
  // Someone else's change shows unless this person is typing in it.
  useEffect(() => {
    if (!focused) setTitle(props.title);
  }, [props.title, focused]);
  const commitTitle = () => {
    const next = title.trim().slice(0, MAX_MEETING_TITLE);
    if (next !== props.title) onChange({ title: next });
  };
  const when = props.startedAt || props.scheduledAt;
  return (
    <div>
      <div className="flex items-center gap-2">
        <NotebookPen className="h-4 w-4 shrink-0 text-fg-muted" aria-hidden />
        {editable ? (
          <input
            value={title}
            maxLength={MAX_MEETING_TITLE}
            placeholder={t("titlePlaceholder")}
            aria-label={t("titlePlaceholder")}
            onChange={(e) => setTitle(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              setFocused(false);
              commitTitle();
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            className="min-w-0 flex-1 bg-transparent text-base font-semibold outline-none placeholder:text-fg-faint"
          />
        ) : (
          <h3 className="min-w-0 flex-1 truncate text-base font-semibold">{props.title || tm("untitled")}</h3>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-fg-muted">
        <span className="flex items-center gap-1.5">
          <CalendarClock className="h-3.5 w-3.5" aria-hidden />
          {editable && !props.startedAt ? (
            <input
              type="datetime-local"
              aria-label={t("when")}
              value={localInput(props.scheduledAt)}
              onChange={(e) => {
                const time = Date.parse(e.target.value);
                onChange({ scheduledAt: Number.isFinite(time) ? new Date(time).toISOString() : "" });
              }}
              onKeyDown={(e) => e.stopPropagation()}
              className="rounded border border-transparent bg-transparent px-1 text-sm text-fg-muted outline-none hover:border-border focus:border-accent"
            />
          ) : when ? (
            <time dateTime={when}>{format.dateTime(new Date(when), { dateStyle: "medium", timeStyle: "short" })}</time>
          ) : (
            <span>{t("noDate")}</span>
          )}
        </span>
        {props.seconds > 0 && <span>{tm("duration", { minutes: Math.max(1, Math.round(props.seconds / 60)) })}</span>}
        <Attendees attendees={attendees} editable={editable} pageId={pageId} onChange={(list) => onChange({ attendees: serializeAttendees(list) })} />
      </div>
    </div>
  );
}

function Attendees({ attendees, editable, pageId, onChange }: { attendees: Attendee[]; editable: boolean; pageId: string | null; onChange: (list: Attendee[]) => void }) {
  const t = useTranslations("meetings.block");
  const [query, setQuery] = useState("");
  const [people, setPeople] = useState<{ id: string; name: string; image: string | null }[] | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open || !pageId) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      mentionCandidatesAction(pageId, query.trim())
        .then((res) => !cancelled && setPeople(res.people))
        .catch(() => !cancelled && setPeople([]));
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, query, pageId]);
  const chosen = new Set(attendees.map((a) => a.id));
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
      <span className="sr-only">{t("attendees")}</span>
      {attendees.length === 0 && !editable && <span>{t("noAttendees")}</span>}
      {attendees.map((a) => (
        <span key={a.id || a.name} className="inline-flex items-center gap-1 rounded-md border border-border py-0.5 ps-0.5 pe-1.5 text-xs text-fg">
          <UserAvatar name={a.name} size="sm" />
          {a.name}
          {editable && (
            <button
              type="button"
              aria-label={t("removeAttendee", { name: a.name })}
              onClick={() => onChange(attendees.filter((x) => x !== a))}
              className="ms-0.5 rounded text-fg-faint hover:text-fg"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </span>
      ))}
      {editable && pageId && attendees.length < MAX_ATTENDEES && (
        <Popover
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (!next) setQuery("");
          }}
          trigger={({ toggle }) => (
            <button type="button" onClick={toggle} className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs text-fg-muted hover:bg-bg-hover hover:text-fg">
              <Plus className="h-3.5 w-3.5" />
              {attendees.length ? t("addAttendeeShort") : t("addAttendee")}
            </button>
          )}
          className="w-64"
        >
          <div className="flex items-center gap-2 border-b border-border px-2">
            <Search className="h-3.5 w-3.5 text-fg-muted" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder={t("searchPeople")}
              aria-label={t("searchPeople")}
              className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-fg-faint"
            />
          </div>
          <div className="max-h-60 overflow-y-auto py-1">
            {(people ?? [])
              .filter((p) => !chosen.has(p.id))
              .map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    onChange([...attendees, { id: p.id, name: p.name }]);
                    setQuery("");
                  }}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-sm hover:bg-bg-hover"
                >
                  <UserAvatar name={p.name} image={p.image} size="sm" />
                  <span className="truncate">{p.name}</span>
                </button>
              ))}
            {people && !people.some((p) => !chosen.has(p.id)) && <p className="px-2 py-2 text-sm text-fg-muted">{t("noPeople")}</p>}
          </div>
        </Popover>
      )}
    </span>
  );
}

const SECTIONS = ["summary", "decisions", "actions"] as const;

/** Summary, decisions and action items, each takeaway with a link to its moment of the transcript. */
function Takeaways({
  props,
  editable,
  busy,
  onJump,
  onChange,
  onRegenerate,
}: {
  props: MeetingProps;
  editable: boolean;
  busy: boolean;
  onJump: (seconds: number) => void;
  onChange: (change: Change) => void;
  onRegenerate?: () => void;
}) {
  const t = useTranslations("meetings.block");
  const [editing, setEditing] = useState<Record<(typeof SECTIONS)[number], string> | null>(null);
  const toggle = (index: number, item: Takeaway) => {
    const items = parseTakeaways(props.actions);
    items[index] = { ...item, done: !item.done };
    onChange({ actions: items.map((i) => takeawayLine(i, true)).join("\n") });
  };
  if (editing) {
    return (
      <div className="mt-4 space-y-3">
        {SECTIONS.map((key) => (
          <label key={key} className="block">
            <span className="mb-1 block text-xs font-medium text-fg-muted">{t(key)}</span>
            <textarea
              value={editing[key]}
              rows={Math.min(10, Math.max(2, editing[key].split("\n").length + 1))}
              onChange={(e) => setEditing({ ...editing, [key]: e.target.value })}
              onKeyDown={(e) => e.stopPropagation()}
              className={textareaClass}
            />
          </label>
        ))}
        <p className="text-xs text-fg-muted">{t("editHint")}</p>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              const clean = (key: (typeof SECTIONS)[number]) =>
                parseTakeaways(editing[key])
                  .map((item) => takeawayLine(item, key === "actions"))
                  .join("\n");
              onChange({ summary: clean("summary"), decisions: clean("decisions"), actions: clean("actions") });
              setEditing(null);
            }}
          >
            {t("save")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
            {t("cancel")}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="mt-4 space-y-4">
      {SECTIONS.map((key) => {
        const items = parseTakeaways(props[key]);
        return (
          <div key={key}>
            <h4 className="mb-1 text-xs font-medium tracking-wide text-fg-muted">{t(key)}</h4>
            {items.length === 0 ? (
              <p className="text-sm text-fg-faint">{t("none")}</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {items.map((item, i) => (
                  <li key={i} className="flex items-start gap-2">
                    {key === "actions" ? (
                      <input
                        type="checkbox"
                        checked={item.done}
                        disabled={!editable}
                        onChange={() => toggle(i, item)}
                        aria-label={item.text}
                        className="mt-1 h-3.5 w-3.5 shrink-0 accent-[var(--accent)]"
                      />
                    ) : (
                      <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-fg-muted" aria-hidden />
                    )}
                    <span className={cn("min-w-0 flex-1", item.done && "text-fg-muted line-through")}>
                      {item.assignee && <span className="font-medium">@{item.assignee} </span>}
                      {item.text}
                      {item.at !== null && (
                        <button
                          type="button"
                          onClick={() => onJump(item.at!)}
                          title={t("jump", { time: formatStamp(item.at) })}
                          className="ms-1.5 rounded px-0.5 text-xs tabular-nums text-accent hover:underline"
                        >
                          [{formatStamp(item.at)}]
                        </button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
      {editable && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setEditing({ summary: props.summary, decisions: props.decisions, actions: props.actions })}>
            {t("edit")}
          </Button>
          {onRegenerate && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={onRegenerate}>
              <RefreshCw className={cn("h-3.5 w-3.5", busy && "animate-spin")} />
              {t("regenerate")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** The transcript, folded by default: a line per piece, `[mm:ss]` and what was said, gaps said so. */
function Transcript({
  chunks,
  open,
  onToggle,
  highlight,
  lines,
  live,
  seconds,
}: {
  chunks: TranscriptChunk[];
  open: boolean;
  onToggle: () => void;
  highlight: number | null;
  lines: Map<number, HTMLLIElement>;
  live: boolean;
  seconds: number;
}) {
  const t = useTranslations("meetings.block");
  const shown = chunks.filter((c) => "gap" in c || c.x.trim());
  return (
    <div className="mt-4 border-t border-border pt-2">
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex items-center gap-1 rounded px-1 py-0.5 text-sm font-medium text-fg-muted hover:bg-bg-hover hover:text-fg">
        <ChevronRight className={cn("h-4 w-4 transition-transform", open && "rotate-90 rtl:-rotate-90")} aria-hidden />
        {t("transcript")}
        {shown.length > 0 && <span className="font-normal text-fg-faint">· {t("transcriptCount", { count: shown.length })}</span>}
      </button>
      {open && (
        <ol className="mt-1 max-h-96 space-y-1 overflow-y-auto pe-1 text-sm" aria-live={live ? "polite" : undefined}>
          {shown.length === 0 && <li className="px-1 py-1 text-fg-faint">{t("noTranscript")}</li>}
          {shown.map((c) => (
            <li
              key={c.c}
              ref={(el) => {
                if (el) lines.set(c.c, el);
                else lines.delete(c.c);
              }}
              className={cn("flex gap-3 rounded px-1 py-0.5 transition-colors", highlight === c.c && "bg-accent/15 ring-1 ring-accent/40")}
            >
              <span className="shrink-0 tabular-nums text-xs leading-5 text-fg-faint">[{formatStamp(c.t)}]</span>
              {"gap" in c ? <span className="text-fg-faint">{t("gap")}</span> : <span className="min-w-0 flex-1 whitespace-pre-wrap">{c.x}</span>}
            </li>
          ))}
          {live && (
            <li className="flex items-center gap-2 px-1 py-0.5 text-xs text-fg-faint">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
              {t("listening", { time: formatStamp(seconds) })}
            </li>
          )}
        </ol>
      )}
    </div>
  );
}

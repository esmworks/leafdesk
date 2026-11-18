"use client";

import { Plus } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { createBookingLinkAction, deleteBookingLinkAction, updateBookingLinkAction, type BookingLinkError } from "@/app/actions/booking";
import { useDurationText } from "@/components/calendar/duration";
import { read } from "@/components/read";
import { CopyButton } from "@/components/settings/copy-button";
import { Button, cn, Dialog, DialogBody, DialogFooter, DialogHeader, Input, selectClass, Switch, textareaClass } from "@/components/ui";
import { useViewerTimeZone } from "@/components/database/use-today";
import { BOOKING_DEFAULTS, BOOKING_DURATIONS, BOOKING_LIMITS, WEEK_ORDER } from "@/lib/booking";
import type { BookingLinkView } from "@/server/booking";
import type { WritableCalendar } from "@/server/calendar-events";

type Draft = {
  title: string;
  description: string;
  databaseId: string;
  durationMinutes: number;
  weekdays: number[];
  startMinute: number;
  endMinute: number;
  bufferMinutes: number;
  daysAhead: number;
  minNoticeMinutes: number;
  timeZone: string;
  enabled: boolean;
};

const BUFFERS = [0, 5, 10, 15, 30, 60];
const AHEAD = [7, 14, 30, 60];
const NOTICES = [0, 60, 120, 240, 720, 1440, 2880];
/** Hours of a day, half an hour apart, up to the end of it. */
const HOURS = Array.from({ length: 49 }, (_, i) => i * 30);

/**
 * The person's booking links (server/booking.ts), from the Calendar place: each one's public
 * address to copy, whether it takes bookings, and a form for its settings. A link books into a
 * Google Calendar synced both ways, so without one the dialog says to set it up first.
 */
export function BookingLinksDialog({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const t = useTranslations("calendar.booking");
  const common = useTranslations("common");
  const format = useFormatter();
  const duration = useDurationText();
  const viewerZone = useViewerTimeZone();
  const [links, setLinks] = useState<BookingLinkView[] | null>(null);
  const [calendars, setCalendars] = useState<WritableCalendar[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState<{ id: string | null; draft: Draft } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<BookingLinkError | null>(null);

  const load = useCallback(async () => {
    const [list, cals] = await Promise.all([read("bookingLinks", workspaceId), read("bookingCalendars", workspaceId)]).catch(() => [null, null] as const);
    setFailed(list === null || cals === null);
    setLinks(list);
    setCalendars(cals);
  }, [workspaceId]);
  useEffect(() => {
    void load();
  }, [load]);

  const clock = (minutes: number) => format.dateTime(new Date(minutes * 60_000), { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
  const dayName = (day: number) => format.dateTime(new Date(Date.UTC(2024, 0, 7 + day)), { weekday: "short", timeZone: "UTC" });
  const summary = (l: Pick<BookingLinkView, "durationMinutes" | "weekdays" | "startMinute" | "endMinute">) =>
    t("summary", {
      duration: duration(l.durationMinutes),
      days: format.list(WEEK_ORDER.filter((d) => l.weekdays.includes(d)).map(dayName), { type: "unit", style: "short" }),
      hours: t("hours", { from: clock(l.startMinute), to: clock(l.endMinute) }),
    });

  const startNew = () => {
    setError(null);
    setEditing({
      id: null,
      draft: { ...BOOKING_DEFAULTS, weekdays: [...BOOKING_DEFAULTS.weekdays], title: "", description: "", databaseId: calendars?.[0]?.databaseId ?? "", timeZone: viewerZone, enabled: true },
    });
  };
  const startEdit = (l: BookingLinkView) => {
    setError(null);
    const { id, url: _url, calendar: _calendar, createdAt: _created, ...draft } = l;
    setEditing({ id, draft });
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    const { enabled, ...input } = editing.draft;
    setBusy(true);
    setError(null);
    const result = await (editing.id ? updateBookingLinkAction(workspaceId, editing.id, input, enabled) : createBookingLinkAction(workspaceId, input)).catch(() => ({ ok: false, error: "failed" }) as const);
    setBusy(false);
    if (!result.ok) return setError(result.error);
    setEditing(null);
    await load();
  };

  const toggle = async (l: BookingLinkView, enabled: boolean) => {
    const { id, url: _url, calendar: _calendar, createdAt: _created, ...input } = l;
    setLinks((list) => list?.map((x) => (x.id === l.id ? { ...x, enabled } : x)) ?? null);
    const result = await updateBookingLinkAction(workspaceId, id, input, enabled).catch(() => ({ ok: false }) as const);
    if (!result.ok) await load();
  };

  const remove = async (id: string) => {
    setBusy(true);
    const result = await deleteBookingLinkAction(workspaceId, id).catch(() => ({ ok: false }) as const);
    setBusy(false);
    setRemoving(null);
    if (result.ok) await load();
  };

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setEditing((s) => (s ? { ...s, draft: { ...s.draft, [key]: value } } : s));
  const draft = editing?.draft;

  return (
    <Dialog open onClose={onClose} className="max-w-xl">
      {editing && draft ? (
        <form onSubmit={save}>
          <DialogHeader title={editing.id ? t("editTitle") : t("newTitle")} onClose={onClose} closeLabel={common("close")} />
          <DialogBody className="max-h-[65vh] overflow-y-auto">
            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium text-fg">{t("title")}</span>
              <Input required maxLength={BOOKING_LIMITS.title} placeholder={t("titlePlaceholder")} value={draft.title} onChange={(e) => set("title", e.target.value)} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium text-fg">{t("description")}</span>
              <textarea className={textareaClass} rows={2} maxLength={BOOKING_LIMITS.description} value={draft.description} onChange={(e) => set("description", e.target.value)} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium text-fg">{t("calendar")}</span>
              <select required value={draft.databaseId} onChange={(e) => set("databaseId", e.target.value)} className={`${selectClass} w-full`}>
                {!calendars?.some((c) => c.databaseId === draft.databaseId) && <option value={draft.databaseId}>—</option>}
                {calendars?.map((c) => (
                  <option key={c.databaseId} value={c.databaseId}>
                    {c.calendarName ? `${c.calendarName} (${c.title.trim() || common("untitled")})` : c.title.trim() || common("untitled")}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex gap-4">
              <label className="flex min-w-0 flex-1 flex-col gap-1.5">
                <span className="text-[13px] font-medium text-fg">{t("duration")}</span>
                <select value={draft.durationMinutes} onChange={(e) => set("durationMinutes", Number(e.target.value))} className={`${selectClass} w-full`}>
                  {[...new Set<number>([...BOOKING_DURATIONS, draft.durationMinutes])].sort((a, b) => a - b).map((m) => (
                    <option key={m} value={m}>
                      {duration(m)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex min-w-0 flex-1 flex-col gap-1.5">
                <span className="text-[13px] font-medium text-fg">{t("buffer")}</span>
                <select value={draft.bufferMinutes} onChange={(e) => set("bufferMinutes", Number(e.target.value))} className={`${selectClass} w-full`}>
                  {[...new Set([...BUFFERS, draft.bufferMinutes])].sort((a, b) => a - b).map((m) => (
                    <option key={m} value={m}>
                      {m === 0 ? t("none") : duration(m)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <fieldset className="flex flex-col gap-1.5">
              <legend className="mb-1.5 text-[13px] font-medium text-fg">{t("days")}</legend>
              <div className="flex flex-wrap gap-1.5">
                {WEEK_ORDER.map((d) => {
                  const on = draft.weekdays.includes(d);
                  return (
                    <button
                      key={d}
                      type="button"
                      aria-pressed={on}
                      onClick={() => set("weekdays", on ? draft.weekdays.filter((x) => x !== d) : [...draft.weekdays, d])}
                      className={cn("h-8 min-w-11 rounded-md border px-2 text-sm hover:bg-bg-hover", on ? "border-accent bg-bg-hover font-medium" : "border-border text-fg-muted")}
                    >
                      {dayName(d)}
                    </button>
                  );
                })}
              </div>
            </fieldset>
            <div className="flex gap-4">
              <label className="flex min-w-0 flex-1 flex-col gap-1.5">
                <span className="text-[13px] font-medium text-fg">{t("from")}</span>
                <select value={draft.startMinute} onChange={(e) => set("startMinute", Number(e.target.value))} className={`${selectClass} w-full`}>
                  {HOURS.filter((m) => m < 1440).map((m) => (
                    <option key={m} value={m}>
                      {clock(m)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex min-w-0 flex-1 flex-col gap-1.5">
                <span className="text-[13px] font-medium text-fg">{t("to")}</span>
                <select value={draft.endMinute} onChange={(e) => set("endMinute", Number(e.target.value))} className={`${selectClass} w-full`}>
                  {HOURS.filter((m) => m > 0).map((m) => (
                    <option key={m} value={m}>
                      {m === 1440 ? t("endOfDay") : clock(m)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="flex gap-4">
              <label className="flex min-w-0 flex-1 flex-col gap-1.5">
                <span className="text-[13px] font-medium text-fg">{t("daysAhead")}</span>
                <select value={draft.daysAhead} onChange={(e) => set("daysAhead", Number(e.target.value))} className={`${selectClass} w-full`}>
                  {[...new Set([...AHEAD, draft.daysAhead])].sort((a, b) => a - b).map((n) => (
                    <option key={n} value={n}>
                      {t("daysAheadValue", { count: n })}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex min-w-0 flex-1 flex-col gap-1.5">
                <span className="text-[13px] font-medium text-fg">{t("notice")}</span>
                <select value={draft.minNoticeMinutes} onChange={(e) => set("minNoticeMinutes", Number(e.target.value))} className={`${selectClass} w-full`}>
                  {[...new Set([...NOTICES, draft.minNoticeMinutes])].sort((a, b) => a - b).map((m) => (
                    <option key={m} value={m}>
                      {m === 0 ? t("none") : m % 60 === 0 ? t("noticeHours", { count: m / 60 }) : duration(m)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="text-xs text-fg-faint">{t("timeZone", { zone: draft.timeZone.replaceAll("_", " ") })}</p>
            {error && (
              <p role="alert" className="text-[13px] text-danger">
                {t(`errors.${error}`)}
              </p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setEditing(null)}>
              {common("cancel")}
            </Button>
            <Button type="submit" variant="primary" disabled={busy || !draft.title.trim() || !draft.databaseId}>
              {editing.id ? common("save") : t("create")}
            </Button>
          </DialogFooter>
        </form>
      ) : (
        <>
          <DialogHeader
            title={t("linksTitle")}
            description={t("intro")}
            onClose={onClose}
            closeLabel={common("close")}
            actions={
              calendars?.length ? (
                <Button size="sm" variant="secondary" onClick={startNew}>
                  <Plus className="h-3.5 w-3.5" aria-hidden />
                  {t("new")}
                </Button>
              ) : null
            }
          />
          <DialogBody className="max-h-[65vh] overflow-y-auto">
            {failed ? (
              <p role="alert" className="text-sm text-danger">
                {t("couldNotLoad")}
              </p>
            ) : links === null ? (
              <p className="text-sm text-fg-muted">{common("loading")}</p>
            ) : (
              <>
                {calendars?.length === 0 && <p className="rounded-lg border border-border bg-bg-subtle p-4 text-sm text-fg-muted">{t("noCalendar")}</p>}
                {calendars?.length ? links.length === 0 && <p className="text-sm text-fg-muted">{t("empty")}</p> : null}
                <ul className="flex flex-col gap-3">
                  {links.map((l) => (
                    <li key={l.id} className="rounded-lg border border-border p-3">
                      <div className="flex items-start gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{l.title}</p>
                          <p className="mt-0.5 text-xs text-fg-muted">{summary(l)}</p>
                          {l.calendar === null && <p className="mt-1 text-xs text-danger">{t("calendarLost")}</p>}
                        </div>
                        <Switch checked={l.enabled} onChange={(on) => void toggle(l, on)} label={t("accepting", { title: l.title })} />
                      </div>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <CopyButton value={l.url} label={t("copyLink")} />
                        <Button size="sm" onClick={() => startEdit(l)}>
                          {t("edit")}
                        </Button>
                        {removing === l.id ? (
                          <>
                            <span className="text-xs text-fg-muted">{t("deleteConfirm")}</span>
                            <Button size="sm" variant="danger" disabled={busy} onClick={() => void remove(l.id)}>
                              {common("delete")}
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setRemoving(null)}>
                              {common("cancel")}
                            </Button>
                          </>
                        ) : (
                          <Button size="sm" variant="ghost" onClick={() => setRemoving(l.id)}>
                            {common("delete")}
                          </Button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" onClick={onClose}>
              {common("close")}
            </Button>
          </DialogFooter>
        </>
      )}
    </Dialog>
  );
}

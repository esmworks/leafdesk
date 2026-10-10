"use client";

import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { Button, cn, PageIcon } from "@/components/ui";
import { PHONE_QUERY, useMediaQuery } from "@/components/use-media-query";
import type { CalendarMode } from "@/db/schema/app";
import {
  calendarEvent,
  dayBlocks,
  eventsOn,
  isAllDay,
  MINUTES_PER_DAY,
  monthWeeks,
  weekBars,
  weekDays,
  type CalendarEvent,
} from "@/lib/calendar";
import { moveDateStart, parseDateValue, shiftDateValue } from "@/lib/date-value";
import { pageLabel } from "@/lib/labels";
import { dayNumber, dayString, monthDay, zonedInstant } from "@/lib/time-zone";
import { CALENDAR_MODES, viewDateProperty } from "@/lib/views";
import { CardTitleInput } from "./board-view";
import { CalendarFeedButton } from "./calendar-feed";
import { usePropertyAccess } from "./property-access";
import { RowValue, shownValues } from "./property-cell";
import { QuickAddContext } from "./quick-add";
import { useNewRow } from "./use-new-row";
import { useToday, useViewerTimeZone } from "./use-today";
import type { Property, Row, View } from "./types";
import type { DatabaseApi } from "./use-database";

const MAX_ENTRY_PROPS = 2;
/** Height of an hour in the week's hours, in pixels. */
const HOUR_HEIGHT = 48;
/** The week's hours take rows and drops by the half hour. */
const SLOT_MINUTES = 30;

type RowEvent = CalendarEvent & { row: Row };

/** A day number as a Date at its midnight in UTC: days are formatted in UTC so zones never shift them. */
const utcDay = (day: number) => new Date(day * 86_400_000);

/** First weekday of the locale as a `getUTCDay()` index (0 = Sunday). */
function firstDayOfWeek(locale: string) {
  try {
    const l = new Intl.Locale(locale) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const first = l.getWeekInfo?.().firstDay ?? l.weekInfo?.firstDay;
    if (first) return first % 7;
  } catch {
    // Older engines without week info fall through to the default below.
  }
  return locale.startsWith("en") ? 0 : 1;
}

/**
 * Rows on the days of a date property: a month of days, or a week with its hours. A date over
 * several days is a bar across them; in the week, dates with times sit on the hours and all-day
 * ones (and times over several days) in a strip above. Dragging a row moves its whole date, both
 * ends, keeping whether it has times.
 */
export function CalendarView({
  workspaceId,
  view,
  properties,
  rows,
  api,
  readOnly,
  locked,
  onCreateDateProperty,
}: {
  workspaceId: string;
  view: View;
  properties: Property[];
  rows: Row[];
  api: DatabaseApi;
  readOnly?: boolean;
  locked?: boolean;
  onCreateDateProperty: () => void;
}) {
  const t = useTranslations("database");
  const format = useFormatter();
  const locale = useLocale();
  const today = useToday();
  const timeZone = useViewerTimeZone();
  // The day the calendar is on: its month or week shows, and phones list its rows.
  const [anchor, setAnchor] = useState(today);
  // The config holds the saved mode; viewers who can't save still switch locally.
  const [localMode, setLocalMode] = useState<CalendarMode | null>(null);
  const mode = localMode ?? view.config.calendarMode ?? "month";
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<string | null>(null);
  // How many days after the start of the dragged date it was picked up at.
  const grabOffset = useRef(0);
  const hours = useRef<HTMLDivElement>(null);
  const { editTitleOf, typed, create: createNew, stopEditing, quick } = useNewRow(api, view, properties);
  const [showUndated, setShowUndated] = useState(false);
  // On phones the days are a compact grid, and the rows of the picked day are listed under it.
  const phone = useMediaQuery(PHONE_QUERY);
  const access = usePropertyAccess();

  const dateBy = viewDateProperty(view.config, properties);
  const weekStart = firstDayOfWeek(locale);
  const anchorDay = dayNumber(anchor);
  const year = Number(anchor.slice(0, 4));
  const month = Number(anchor.slice(5, 7)) - 1;
  const weeks = useMemo(
    () => (mode === "week" ? [weekDays(anchorDay, weekStart)[0]] : monthWeeks(year, month, weekStart)),
    [mode, anchorDay, year, month, weekStart],
  );

  const events = useMemo(() => {
    const list: RowEvent[] = [];
    if (!dateBy) return list;
    for (const row of rows) {
      const event = calendarEvent(row.id, row.properties[dateBy.id], timeZone);
      if (event) list.push({ ...event, row });
    }
    return list;
  }, [rows, dateBy, timeZone]);

  // The week opens on the morning, or earlier when a row starts earlier.
  const firstWeekDay = weeks[0];
  useEffect(() => {
    if (mode !== "week" || phone || !hours.current) return;
    const timed = events.filter((e) => !isAllDay(e) && e.start >= firstWeekDay && e.start < firstWeekDay + 7);
    const earliest = Math.min(7 * 60, ...timed.map((e) => e.startMinutes - SLOT_MINUTES));
    // A little above, so the first hour shows its label.
    hours.current.scrollTop = Math.max((earliest / 60) * HOUR_HEIGHT - 12, 0);
    // Only when another week (or the week view) opens, not on every change of a row.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, phone, firstWeekDay]);

  if (!dateBy) {
    return (
      <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed border-border px-6 py-10">
        <div>
          <p className="text-sm font-medium">{t("calendar.needsDateTitle")}</p>
          <p className="mt-1 text-sm text-fg-muted">{t("calendar.needsDateBody")}</p>
        </div>
        {!readOnly && !locked && (
          <Button size="sm" onClick={onCreateDateProperty}>
            <Plus className="h-3.5 w-3.5" />
            {t("calendar.addDateProperty", { name: t("calendar.defaultDateProperty") })}
          </Button>
        )}
      </div>
    );
  }

  const hidden = new Set(view.config.hidden ?? []);
  const entryProps = properties.filter((p) => p.id !== dateBy.id && !hidden.has(p.id));
  const undated = rows.filter((r) => !parseDateValue(r.properties[dateBy.id]));
  const canAdd = !readOnly && access.canEditValues(dateBy.id);
  const todayDay = dayNumber(today);
  const days = weeks.flatMap((start) => Array.from({ length: 7 }, (_, i) => start + i));

  const move = (delta: number) => {
    if (mode === "week") return setAnchor(dayString(anchorDay + 7 * delta));
    // Another month opens on today when it holds today, else on its 1st.
    const index = year * 12 + month + delta;
    const first = monthDay(index, 1);
    setAnchor(dayString(todayDay >= first && todayDay < monthDay(index + 1, 1) ? todayDay : first));
  };
  const setMode = (next: CalendarMode) => {
    if (next === mode) return;
    if (readOnly) setLocalMode(next);
    else {
      setLocalMode(null);
      void api.updateView(view, { config: { ...view.config, calendarMode: next } });
    }
  };

  const addOn = (day: number) => createNew(() => api.createRow({ properties: { [dateBy.id]: dayString(day) } }));
  const addAt = (day: number, minutes: number) =>
    createNew(() => api.createRow({ properties: { [dateBy.id]: new Date(zonedInstant(day, minutes, timeZone)).toISOString() } }));

  const endDrag = () => {
    setDragId(null);
    setDropAt(null);
  };
  /** Moves the dragged row's date: `place` gives its new value from its event (none for a row without a date). */
  const drop = (e: DragEvent<HTMLElement>, place: (value: unknown, event: RowEvent | undefined) => string | null) => {
    e.preventDefault();
    const rowId = dragId ?? e.dataTransfer.getData("text/plain");
    endDrag();
    const row = rows.find((r) => r.id === rowId);
    if (!row) return;
    const value = row.properties[dateBy.id];
    const next = place(value, events.find((ev) => ev.id === row.id));
    if ((value ?? null) === next) return;
    void api.setCell(row.id, dateBy.id, next);
  };
  // Days move a date by whole days (from where it was picked up), keeping its times.
  const dropOnDay = (e: DragEvent<HTMLElement>, day: number) =>
    drop(e, (value, event) => (event ? shiftDateValue(value, day - grabOffset.current - event.start, timeZone) : dayString(day)));
  // Hours move a date with times to start there, as long as before; a day value only changes day.
  const dropOnSlot = (e: DragEvent<HTMLElement>, day: number, minutes: number) =>
    drop(e, (value, event) => {
      const at = zonedInstant(day, minutes, timeZone);
      if (!event) return new Date(at).toISOString();
      return event.time ? moveDateStart(value, at) : shiftDateValue(value, day - grabOffset.current - event.start, timeZone);
    });
  const target = (key: string, onDrop: (e: DragEvent<HTMLElement>) => void) => ({
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (!dragId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (dropAt !== key) setDropAt(key);
    },
    onDragLeave: (e: DragEvent<HTMLElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropAt(null);
    },
    onDrop,
  });

  /** Minutes past midnight as the locale writes a time of day ("14:30", "2:30 PM"). */
  const clock = (minutes: number) =>
    format.dateTime(new Date(Math.min(minutes, MINUTES_PER_DAY - 1) * 60_000), { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
  const dayLabel = (day: number) => format.dateTime(utcDay(day), { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

  const entry = (row: Row, options: { time?: string | null; before?: boolean; after?: boolean; block?: boolean } = {}) => (
    <CalendarEntry
      key={row.id}
      workspaceId={workspaceId}
      row={row}
      props={entryProps}
      time={options.time}
      before={options.before}
      after={options.after}
      block={options.block}
      // Property access: an entry moves only where the viewer may change its date.
      readOnly={readOnly || access.valueAccess(row, dateBy.id) !== "edit"}
      dragging={dragId === row.id}
      editTitle={editTitleOf === row.id}
      typed={typed}
      onTitle={(title) => {
        stopEditing();
        if (title !== row.title) quick.save(row.id, title);
      }}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", row.id);
        e.dataTransfer.effectAllowed = "move";
        setDragId(row.id);
        // The day under the pointer, so a date over several days keeps its place under it.
        const event = events.find((ev) => ev.id === row.id);
        const under = document
          .elementsFromPoint(e.clientX, e.clientY)
          .find((el): el is HTMLElement => el instanceof HTMLElement && el.dataset.day !== undefined);
        grabOffset.current = event && under ? Math.max(0, Number(under.dataset.day) - event.start) : 0;
      }}
      onDragEnd={endDrag}
    />
  );
  const timeOf = (event: RowEvent) => (event.time ? clock(event.startMinutes) : null);

  /**
   * A week's rows of bars over its day cells. The cells take drops; while dragging, the bars let
   * the pointer through to them. Month weeks have the day numbers on top of their cells.
   */
  const weekRow = (start: number, list: RowEvent[], header: boolean) => {
    const { bars, lanes } = weekBars(list, start);
    const first = header ? 2 : 1;
    return (
      <div
        className={cn("grid grid-cols-7", header && "min-h-28")}
        style={{ gridTemplateRows: `${header ? "1.75rem " : ""}repeat(${lanes}, auto) minmax(${header ? "1.5rem" : "1.75rem"}, 1fr)` }}
      >
        {Array.from({ length: 7 }, (_, i) => {
          const day = start + i;
          const key = dayString(day);
          const inMonth = mode === "week" || utcDay(day).getUTCMonth() === month;
          return (
            <section
              key={key}
              data-day={day}
              aria-label={dayLabel(day)}
              {...target(key, (e) => dropOnDay(e, day))}
              style={{ gridColumn: i + 1, gridRow: "1 / -1" }}
              className={cn(
                "group min-w-0 p-1",
                i > 0 && "border-l border-border",
                !inMonth && "bg-bg-subtle",
                dragId && dropAt === key && "bg-bg-hover",
              )}
            >
              {header && (
                <div className="flex h-6 items-center justify-between">
                  {canAdd ? (
                    <button
                      type="button"
                      aria-label={t("calendar.addOnDay", { date: dayLabel(day) })}
                      title={t("calendar.addOnDay", { date: dayLabel(day) })}
                      onClick={() => addOn(day)}
                      className="invisible inline-flex h-6 w-6 items-center justify-center rounded text-fg-muted group-hover:visible hover:bg-bg-active hover:text-fg focus-visible:visible"
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  ) : (
                    <span />
                  )}
                  <DayNumber day={day} today={day === todayDay} faint={!inMonth} />
                </div>
              )}
            </section>
          );
        })}
        {bars.map((bar) => (
          <div
            key={bar.event.id}
            style={{ gridColumn: `${bar.col + 1} / span ${bar.span}`, gridRow: bar.lane + first }}
            className={cn("min-w-0 pb-1", !bar.before && "pl-1", !bar.after && "pr-1", dragId && "pointer-events-none")}
          >
            {entry(bar.event.row, { time: bar.before ? null : timeOf(bar.event), before: bar.before, after: bar.after })}
          </div>
        ))}
      </div>
    );
  };

  const weekdayHeader = (
    <div className="grid grid-cols-7 border-b border-border bg-bg-subtle">
      {days.slice(0, 7).map((day) => (
        <div key={day} className="px-2 py-1.5 text-xs text-fg-muted">
          {format.dateTime(utcDay(day), { weekday: "short", timeZone: "UTC" })}
        </div>
      ))}
    </div>
  );

  const monthGrid = (
    <div className="-mx-2 overflow-x-auto px-2">
      <div className="min-w-[42rem] overflow-hidden rounded-lg border border-border">
        {weekdayHeader}
        {weeks.map((start, w) => (
          <div key={start} className={cn(w > 0 && "border-t border-border")}>
            {weekRow(start, events, true)}
          </div>
        ))}
      </div>
    </div>
  );

  const weekGrid = (
    <div className="-mx-2 overflow-x-auto px-2">
      <div className="min-w-[42rem] overflow-hidden rounded-lg border border-border">
        <div className="flex border-b border-border bg-bg-subtle">
          <div className="w-14 shrink-0" />
          <div className="grid min-w-0 flex-1 grid-cols-7">
            {days.map((day) => (
              <div key={day} className="group flex items-center justify-between gap-1 border-l border-border px-1.5 py-1">
                <span className="flex min-w-0 items-center gap-1 text-xs text-fg-muted">
                  <span className="truncate">{format.dateTime(utcDay(day), { weekday: "short", timeZone: "UTC" })}</span>
                  <DayNumber day={day} today={day === todayDay} />
                </span>
                {canAdd && (
                  <button
                    type="button"
                    aria-label={t("calendar.addOnDay", { date: dayLabel(day) })}
                    title={t("calendar.addOnDay", { date: dayLabel(day) })}
                    onClick={() => addOn(day)}
                    className="invisible inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-muted group-hover:visible hover:bg-bg-active hover:text-fg focus-visible:visible"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
        <div className="flex border-b border-border">
          <div className="w-14 shrink-0 px-1.5 py-1.5 text-right text-[11px] leading-4 text-fg-muted">{t("calendar.allDay")}</div>
          <div className="min-w-0 flex-1">{weekRow(days[0], events.filter(isAllDay), false)}</div>
        </div>
        <div ref={hours} className="max-h-[32rem] overflow-y-auto">
          <div className="flex" style={{ height: 24 * HOUR_HEIGHT }}>
            <div aria-hidden className="relative w-14 shrink-0">
              {Array.from({ length: 23 }, (_, h) => (
                <span
                  key={h}
                  style={{ top: (h + 1) * HOUR_HEIGHT }}
                  className="absolute right-1.5 -translate-y-1/2 text-[11px] tabular-nums text-fg-muted"
                >
                  {format.dateTime(new Date((h + 1) * 3_600_000), { hour: "numeric", timeZone: "UTC" })}
                </span>
              ))}
            </div>
            {days.map((day) => (
              <div key={day} className={cn("relative min-w-0 flex-1 border-l border-border", day === todayDay && "bg-bg-subtle")}>
                {Array.from({ length: MINUTES_PER_DAY / SLOT_MINUTES }, (_, s) => {
                  const minutes = s * SLOT_MINUTES;
                  const key = `${day}@${minutes}`;
                  const slot = {
                    "data-day": day,
                    ...target(key, (e) => dropOnSlot(e, day, minutes)),
                    style: { height: (SLOT_MINUTES / 60) * HOUR_HEIGHT },
                    className: cn(
                      "block w-full",
                      s > 0 && minutes % 60 === 0 && "border-t border-border",
                      canAdd && "hover:bg-bg-hover",
                      dragId && dropAt === key && "bg-bg-hover",
                    ),
                  };
                  return canAdd ? (
                    <button
                      key={key}
                      type="button"
                      // The day's add button is the keyboard's way in; the hours are for the pointer.
                      tabIndex={-1}
                      aria-label={t("calendar.addAt", { date: dayLabel(day), time: clock(minutes) })}
                      title={t("calendar.addAt", { date: dayLabel(day), time: clock(minutes) })}
                      onClick={() => addAt(day, minutes)}
                      {...slot}
                    />
                  ) : (
                    <div key={key} {...slot} />
                  );
                })}
                {dayBlocks(events.filter((e) => !isAllDay(e) && e.start === day)).map((b) => (
                  <div
                    key={b.event.id}
                    style={{
                      top: (b.top / 60) * HOUR_HEIGHT,
                      height: ((b.bottom - b.top) / 60) * HOUR_HEIGHT - 1,
                      left: `calc(${(b.col / b.cols) * 100}% + 2px)`,
                      width: `calc(${100 / b.cols}% - 4px)`,
                    }}
                    className={cn("absolute", dragId && "pointer-events-none")}
                  >
                    {entry(b.event.row, { time: timeOf(b.event), block: true })}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );

  const title =
    mode === "week"
      ? format.dateTimeRange(utcDay(days[0]), utcDay(days[6]), { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
      : format.dateTime(utcDay(monthDay(year * 12 + month, 1)), { month: "long", year: "numeric", timeZone: "UTC" });
  const previous = mode === "week" ? t("calendar.previousWeek") : t("calendar.previous");
  const next = mode === "week" ? t("calendar.nextWeek") : t("calendar.next");

  return (
    <QuickAddContext value={quick}>
      <div className="pb-4">
        <div className="flex flex-wrap items-center gap-1 pb-2">
          <h3 className="min-w-0 flex-1 truncate text-sm font-medium first-letter:uppercase">{title}</h3>
          <div role="group" aria-label={t("calendar.mode")} className="inline-flex rounded-md border border-border p-0.5">
            {CALENDAR_MODES.map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                onClick={() => setMode(m)}
                className={cn(
                  "h-6 rounded px-2 text-xs",
                  mode === m ? "bg-bg-active font-medium text-fg" : "text-fg-muted hover:bg-bg-hover hover:text-fg",
                )}
              >
                {t(`calendar.${m}`)}
              </button>
            ))}
          </div>
          <CalendarFeedButton viewId={view.id} />
          <Button size="sm" variant="ghost" onClick={() => setAnchor(today)}>
            {t("calendar.today")}
          </Button>
          <button
            type="button"
            aria-label={previous}
            title={previous}
            onClick={() => move(-1)}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label={next}
            title={next}
            onClick={() => move(1)}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>

        {phone ? (
          <PhoneDays
            days={days}
            inRange={(day) => mode === "week" || utcDay(day).getUTCMonth() === month}
            today={todayDay}
            selected={anchorDay}
            count={(day) => eventsOn(events, day).length}
            canAdd={canAdd}
            entries={eventsOn(events, anchorDay).map((e) => entry(e.row, { time: e.start === anchorDay ? timeOf(e) : null }))}
            onPick={(day) => setAnchor(dayString(day))}
            onAdd={addOn}
          />
        ) : mode === "week" ? (
          weekGrid
        ) : (
          monthGrid
        )}

        {undated.length > 0 && (
          <div className="mt-3">
            <button
              type="button"
              aria-expanded={showUndated}
              onClick={() => setShowUndated((v) => !v)}
              className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-sm text-fg-muted hover:bg-bg-hover hover:text-fg"
            >
              <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", showUndated && "rotate-90")} />
              {t("calendar.noDate", { count: undated.length, property: dateBy.name })}
            </button>
            {showUndated && (
              <section
                aria-label={t("calendar.noDateTitle", { property: dateBy.name })}
                onDragOver={(e) => {
                  if (!dragId) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                }}
                onDrop={(e) => drop(e, () => null)}
                className="mt-1 grid grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-1.5"
              >
                {undated.map((row) => entry(row))}
              </section>
            )}
          </div>
        )}
      </div>
    </QuickAddContext>
  );
}

function DayNumber({ day, today, faint }: { day: number; today: boolean; faint?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-xs tabular-nums",
        today ? "bg-accent font-medium text-accent-fg" : faint ? "text-fg-faint" : "text-fg",
      )}
    >
      {utcDay(day).getUTCDate()}
    </span>
  );
}

/**
 * The days on a phone: every day fits the width, with a dot for each of its rows (up to three),
 * and the rows of the picked day listed below, where a row can be added on that day too. Rows
 * aren't dragged between days here; their date is changed on the row.
 */
function PhoneDays({
  days,
  inRange,
  today,
  selected,
  count,
  canAdd,
  entries,
  onPick,
  onAdd,
}: {
  days: number[];
  /** Whether a day belongs to the month shown (others are dimmed). */
  inRange: (day: number) => boolean;
  today: number;
  selected: number;
  count: (day: number) => number;
  canAdd: boolean;
  entries: ReactNode[];
  onPick: (day: number) => void;
  onAdd: (day: number) => void;
}) {
  const t = useTranslations("database");
  const format = useFormatter();
  const label = (day: number) => format.dateTime(utcDay(day), { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  const selectedLabel = format.dateTime(utcDay(selected), { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  return (
    <>
      <div className="overflow-hidden rounded-lg border border-border">
        <div className="grid grid-cols-7 border-b border-border bg-bg-subtle">
          {days.slice(0, 7).map((day) => (
            <div key={day} className="py-1.5 text-center text-xs text-fg-muted">
              {format.dateTime(utcDay(day), { weekday: "narrow", timeZone: "UTC" })}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {days.map((day, i) => {
            const n = count(day);
            const shown = inRange(day);
            return (
              <button
                key={day}
                type="button"
                aria-pressed={day === selected}
                aria-label={t("calendar.dayRows", { date: label(day), count: n })}
                onClick={() => onPick(day)}
                className={cn(
                  "flex h-12 min-w-0 flex-col items-center justify-start gap-1 pt-1",
                  i >= 7 && "border-t border-border",
                  !shown && "bg-bg-subtle",
                  day === selected && "bg-bg-active",
                )}
              >
                <DayNumber day={day} today={day === today} faint={!shown} />
                {n > 0 && (
                  <span aria-hidden className="flex gap-0.5">
                    {Array.from({ length: Math.min(n, 3) }, (_, k) => (
                      <span key={k} className="h-1 w-1 rounded-full bg-fg-muted" />
                    ))}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
      <section aria-label={label(selected)} className="mt-3">
        <div className="flex h-8 items-center justify-between">
          <h4 className="text-sm font-medium first-letter:uppercase">{selectedLabel}</h4>
          {canAdd && (
            <button
              type="button"
              aria-label={t("calendar.addOnDay", { date: label(selected) })}
              title={t("calendar.addOnDay", { date: label(selected) })}
              onClick={() => onAdd(selected)}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg"
            >
              <Plus className="h-4 w-4" />
            </button>
          )}
        </div>
        {entries.length > 0 ? (
          <div className="mt-1 flex flex-col gap-1.5">{entries}</div>
        ) : (
          <p className="mt-1 text-sm text-fg-muted">{t("calendar.emptyDay")}</p>
        )}
      </section>
    </>
  );
}

function CalendarEntry({
  workspaceId,
  row,
  props,
  time,
  before,
  after,
  block,
  readOnly,
  dragging,
  editTitle,
  typed,
  onTitle,
  onDragStart,
  onDragEnd,
}: {
  workspaceId: string;
  row: Row;
  props: Property[];
  /** When it starts, for dates with times. */
  time?: string | null;
  /** A bar going on from the week before, or into the week after: that side is cut off. */
  before?: boolean;
  after?: boolean;
  /** On the week's hours: fills its block's height. */
  block?: boolean;
  readOnly?: boolean;
  dragging: boolean;
  editTitle: boolean;
  /** Typed before the title editor opened. */
  typed?: string;
  onTitle: (title: string) => void;
  onDragStart: (e: DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
}) {
  const tc = useTranslations("common");
  const router = useRouter();
  const href = `/w/${workspaceId}/p/${row.id}`;
  const shown = shownValues(props, row).slice(0, MAX_ENTRY_PROPS);
  return (
    <div
      role="link"
      tabIndex={0}
      draggable={!readOnly && !editTitle}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={() => !editTitle && router.push(href)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !editTitle && e.target === e.currentTarget) router.push(href);
      }}
      className={cn(
        "min-w-0 cursor-pointer rounded-md border border-border bg-bg px-1.5 py-1 text-xs shadow-sm hover:bg-bg-subtle",
        before && "rounded-l-none border-l-0",
        after && "rounded-r-none border-r-0",
        block && "h-full overflow-hidden py-0.5",
        dragging && "opacity-40",
      )}
    >
      {editTitle ? (
        <CardTitleInput initial={typed || row.title} onDone={onTitle} />
      ) : (
        <div className={cn("flex min-w-0 items-center", block ? "flex-wrap gap-x-1" : "gap-1")}>
          {time && <span className="shrink-0 tabular-nums text-fg-muted">{time}</span>}
          {row.icon && <PageIcon icon={row.icon} className="shrink-0 text-xs" />}
          <span className={cn("truncate font-medium", block && "min-w-0 grow basis-12", !row.title && "text-fg-faint")}>
            {pageLabel(row.title, tc("untitled"))}
          </span>
        </div>
      )}
      {shown.length > 0 && (
        <div className="mt-0.5 flex flex-col gap-0.5 text-fg-muted">
          {shown.map((p) => (
            <div key={p.id} className="flex min-w-0 items-center" title={p.name}>
              <RowValue prop={p} row={row} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

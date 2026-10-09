"use client";

import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useMemo, useState, type DragEvent } from "react";
import { Button, cn, PageIcon } from "@/components/ui";
import { PHONE_QUERY, useMediaQuery } from "@/components/use-media-query";
import { pageLabel } from "@/lib/labels";
import { CardTitleInput } from "./board-view";
import { CalendarFeedButton } from "./calendar-feed";
import { usePropertyAccess } from "./property-access";
import { RowValue, shownValues } from "./property-cell";
import { QuickAddContext } from "./quick-add";
import { viewDateProperty } from "@/lib/views";
import { useNewRow } from "./use-new-row";
import { useToday } from "./use-today";
import type { Property, Row, View } from "./types";
import type { DatabaseApi } from "./use-database";

const MAX_ENTRY_PROPS = 2;

/** Calendar days are `YYYY-MM-DD` strings; arithmetic happens in UTC so time zones never shift them. */
function isoDay(d: Date) {
  return d.toISOString().slice(0, 10);
}
function utcDate(year: number, month: number, day = 1) {
  return new Date(Date.UTC(year, month, day));
}
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

/** The days shown for a month: whole weeks from the week containing the 1st to the one with the last day. */
function monthGrid(year: number, month: number, weekStart: number) {
  const first = utcDate(year, month);
  const start = new Date(first);
  start.setUTCDate(1 - ((first.getUTCDay() - weekStart + 7) % 7));
  const last = utcDate(year, month + 1, 0);
  const days: Date[] = [];
  for (const d = new Date(start); d <= last || days.length % 7 !== 0; d.setUTCDate(d.getUTCDate() + 1)) {
    days.push(new Date(d));
  }
  return days;
}

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
  const [cursor, setCursor] = useState(() => ({ year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) - 1 }));
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropDay, setDropDay] = useState<string | null>(null);
  const { editTitleOf, typed, create: createNew, stopEditing, quick } = useNewRow(api, view, properties);
  const [showUndated, setShowUndated] = useState(false);
  // On phones the month is a compact grid, and the rows of the picked day are listed under it.
  const phone = useMediaQuery(PHONE_QUERY);
  const [picked, setPicked] = useState<string | null>(null);
  const access = usePropertyAccess();

  const dateBy = viewDateProperty(view.config, properties);
  const weekStart = firstDayOfWeek(locale);
  const days = useMemo(() => monthGrid(cursor.year, cursor.month, weekStart), [cursor, weekStart]);

  const byDay = useMemo(() => {
    const map = new Map<string, Row[]>();
    if (!dateBy) return map;
    for (const row of rows) {
      const value = row.properties[dateBy.id];
      if (typeof value !== "string") continue;
      const day = value.slice(0, 10);
      map.set(day, [...(map.get(day) ?? []), row]);
    }
    return map;
  }, [rows, dateBy]);

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
  const undated = rows.filter((r) => typeof r.properties[dateBy.id] !== "string");
  const move = (delta: number) =>
    setCursor(({ year, month }) => {
      const d = utcDate(year, month + delta);
      return { year: d.getUTCFullYear(), month: d.getUTCMonth() };
    });

  const monthKey = `${cursor.year}-${String(cursor.month + 1).padStart(2, "0")}`;
  // The picked day while its month shows, else today in the current month, else the 1st.
  const selected = picked?.startsWith(monthKey) ? picked : today.startsWith(monthKey) ? today : `${monthKey}-01`;
  const canAdd = !readOnly && access.canEditValues(dateBy.id);

  const addOn = async (day: string) => {
    await createNew(() => api.createRow({ properties: { [dateBy.id]: day } }));
  };

  const onDrop = (e: DragEvent<HTMLElement>, day: string | null) => {
    e.preventDefault();
    const rowId = dragId ?? e.dataTransfer.getData("text/plain");
    setDragId(null);
    setDropDay(null);
    const row = rows.find((r) => r.id === rowId);
    if (!row || (row.properties[dateBy.id] ?? null) === day) return;
    void api.setCell(row.id, dateBy.id, day);
  };

  const entry = (row: Row) => (
    <CalendarEntry
      key={row.id}
      workspaceId={workspaceId}
      row={row}
      props={entryProps}
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
      }}
      onDragEnd={() => {
        setDragId(null);
        setDropDay(null);
      }}
    />
  );

  const monthLabel = format.dateTime(utcDate(cursor.year, cursor.month), { month: "long", year: "numeric", timeZone: "UTC" });

  return (
    <QuickAddContext value={quick}>
      <div className="pb-4">
        <div className="flex items-center gap-1 pb-2">
          <h3 className="flex-1 text-sm font-medium first-letter:uppercase">{monthLabel}</h3>
          <CalendarFeedButton viewId={view.id} />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setCursor({ year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) - 1 })}
          >
            {t("calendar.today")}
          </Button>
          <button
            type="button"
            aria-label={t("calendar.previous")}
            title={t("calendar.previous")}
            onClick={() => move(-1)}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label={t("calendar.next")}
            title={t("calendar.next")}
            onClick={() => move(1)}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>

        {phone ? (
          <PhoneMonth
            days={days}
            month={cursor.month}
            today={today}
            selected={selected}
            byDay={byDay}
            canAdd={canAdd}
            entry={entry}
            onPick={(d) => {
              setPicked(isoDay(d));
              if (d.getUTCMonth() !== cursor.month) setCursor({ year: d.getUTCFullYear(), month: d.getUTCMonth() });
            }}
            onAdd={addOn}
          />
        ) : (
          <div className="-mx-2 overflow-x-auto px-2">
            <div className="min-w-[42rem] overflow-hidden rounded-lg border border-border">
              <div className="grid grid-cols-7 border-b border-border bg-bg-subtle">
                {days.slice(0, 7).map((d) => (
                  <div key={isoDay(d)} className="px-2 py-1.5 text-xs text-fg-muted">
                    {format.dateTime(d, { weekday: "short", timeZone: "UTC" })}
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-7">
                {days.map((d, i) => {
                  const day = isoDay(d);
                  const inMonth = d.getUTCMonth() === cursor.month;
                  const entries = byDay.get(day) ?? [];
                  const dayLabel = format.dateTime(d, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
                  return (
                    <section
                      key={day}
                      aria-label={dayLabel}
                      onDragOver={(e) => {
                        if (!dragId) return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                        if (dropDay !== day) setDropDay(day);
                      }}
                      onDragLeave={(e) => {
                        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropDay(null);
                      }}
                      onDrop={(e) => onDrop(e, day)}
                      className={cn(
                        "group flex min-h-28 min-w-0 flex-col gap-1 p-1",
                        i % 7 !== 0 && "border-l border-border",
                        i >= 7 && "border-t border-border",
                        !inMonth && "bg-bg-subtle",
                        dragId && dropDay === day && "bg-bg-hover",
                      )}
                    >
                      <div className="flex h-6 items-center justify-between">
                        {canAdd ? (
                          <button
                            type="button"
                            aria-label={t("calendar.addOnDay", { date: dayLabel })}
                            title={t("calendar.addOnDay", { date: dayLabel })}
                            onClick={() => addOn(day)}
                            className="invisible inline-flex h-6 w-6 items-center justify-center rounded text-fg-muted group-hover:visible hover:bg-bg-active hover:text-fg focus-visible:visible"
                          >
                            <Plus className="h-3.5 w-3.5" />
                          </button>
                        ) : (
                          <span />
                        )}
                        <span
                          className={cn(
                            "inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-xs tabular-nums",
                            day === today ? "bg-accent font-medium text-accent-fg" : inMonth ? "text-fg" : "text-fg-faint",
                          )}
                        >
                          {d.getUTCDate()}
                        </span>
                      </div>
                      {entries.map(entry)}
                    </section>
                  );
                })}
              </div>
            </div>
          </div>
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
                onDrop={(e) => onDrop(e, null)}
                className="mt-1 grid grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-1.5"
              >
                {undated.map(entry)}
              </section>
            )}
          </div>
        )}
      </div>
    </QuickAddContext>
  );
}

/**
 * The month on a phone: every day fits the width, with a dot for each of its rows (up to three),
 * and the rows of the picked day listed below, where a row can be added on that day too. Rows
 * aren't dragged between days here; their date is changed on the row.
 */
function PhoneMonth({
  days,
  month,
  today,
  selected,
  byDay,
  canAdd,
  entry,
  onPick,
  onAdd,
}: {
  days: Date[];
  month: number;
  today: string;
  selected: string;
  byDay: Map<string, Row[]>;
  canAdd: boolean;
  entry: (row: Row) => React.ReactNode;
  onPick: (day: Date) => void;
  onAdd: (day: string) => void;
}) {
  const t = useTranslations("database");
  const format = useFormatter();
  const label = (d: Date) => format.dateTime(d, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  const selectedDate = new Date(`${selected}T00:00:00Z`);
  const selectedLabel = format.dateTime(selectedDate, { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  const entries = byDay.get(selected) ?? [];
  return (
    <>
      <div className="overflow-hidden rounded-lg border border-border">
        <div className="grid grid-cols-7 border-b border-border bg-bg-subtle">
          {days.slice(0, 7).map((d) => (
            <div key={isoDay(d)} className="py-1.5 text-center text-xs text-fg-muted">
              {format.dateTime(d, { weekday: "narrow", timeZone: "UTC" })}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {days.map((d, i) => {
            const day = isoDay(d);
            const inMonth = d.getUTCMonth() === month;
            const count = byDay.get(day)?.length ?? 0;
            return (
              <button
                key={day}
                type="button"
                aria-pressed={day === selected}
                aria-label={t("calendar.dayRows", { date: label(d), count })}
                onClick={() => onPick(d)}
                className={cn(
                  "flex h-12 min-w-0 flex-col items-center justify-start gap-1 pt-1",
                  i >= 7 && "border-t border-border",
                  !inMonth && "bg-bg-subtle",
                  day === selected && "bg-bg-active",
                )}
              >
                <span
                  className={cn(
                    "inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-xs tabular-nums",
                    day === today ? "bg-accent font-medium text-accent-fg" : inMonth ? "text-fg" : "text-fg-faint",
                  )}
                >
                  {d.getUTCDate()}
                </span>
                {count > 0 && (
                  <span aria-hidden className="flex gap-0.5">
                    {Array.from({ length: Math.min(count, 3) }, (_, n) => (
                      <span key={n} className="h-1 w-1 rounded-full bg-fg-muted" />
                    ))}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
      <section aria-label={label(selectedDate)} className="mt-3">
        <div className="flex h-8 items-center justify-between">
          <h4 className="text-sm font-medium first-letter:uppercase">{selectedLabel}</h4>
          {canAdd && (
            <button
              type="button"
              aria-label={t("calendar.addOnDay", { date: label(selectedDate) })}
              title={t("calendar.addOnDay", { date: label(selectedDate) })}
              onClick={() => onAdd(selected)}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg"
            >
              <Plus className="h-4 w-4" />
            </button>
          )}
        </div>
        {entries.length > 0 ? (
          <div className="mt-1 flex flex-col gap-1.5">{entries.map(entry)}</div>
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
        dragging && "opacity-40",
      )}
    >
      {editTitle ? (
        <CardTitleInput initial={typed || row.title} onDone={onTitle} />
      ) : (
        <div className="flex min-w-0 items-center gap-1">
          {row.icon && <PageIcon icon={row.icon} className="shrink-0 text-xs" />}
          <span className={cn("truncate font-medium", !row.title && "text-fg-faint")}>{pageLabel(row.title, tc("untitled"))}</span>
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

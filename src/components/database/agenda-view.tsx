"use client";

import { cellMarkClass, colorMarkClass, type RowColors } from "@/lib/color-rules";
import { CalendarClock, CalendarDays, Check, ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { Button, cn, IconButton, PageIcon } from "@/components/ui";
import {
  agendaDateProperty,
  agendaDoneValue,
  agendaPriorityProperty,
  agendaSections,
  agendaStatusProperty,
  isAgendaDone,
  openRowsPerDay,
  postponedDate,
  showsUndated,
  stripDays,
} from "@/lib/agenda";
import { dateDays, parseDateValue } from "@/lib/date-value";
import { pageLabel } from "@/lib/labels";
import { isHiddenInView, optionOf } from "@/lib/properties";
import { dayNumber, dayString } from "@/lib/time-zone";
import { CardTitleInput } from "./card-title-input";
import { RowMenu } from "./gallery-view";
import { uploadToPage } from "./files-cell";
import { usePropertyAccess } from "./property-access";
import { DateEditor, OptionChip, PropertyCell, shownValues } from "./property-cell";
import { QuickAddContext } from "./quick-add";
import { openRowProps, useIsOpenRow, useRowOpener } from "./row-panel-context";
import type { Property, Row, View } from "./types";
import { useNewRow } from "./use-new-row";
import { useToday, useViewerTimeZone } from "./use-today";
import type { DatabaseApi } from "./use-database";

/** A day number as a Date at its midnight in UTC: days are formatted in UTC so zones never shift them. */
const utcDay = (day: number) => new Date(day * 86_400_000);

/**
 * One database's rows for a day (lib/agenda): a strip of days to pick from, then what is overdue
 * (on today), the day's rows by time and the rows without a date. Each row is ticked off with its
 * status property, moved to tomorrow or given another date in place. The rows are the view's, so
 * its filters, sorts and search apply as in any other view.
 */
export function AgendaView({
  workspaceId,
  view,
  properties,
  rows,
  api,
  readOnly,
  locked,
  onCreateDateProperty,
  colors,
}: {
  workspaceId: string;
  view: View;
  properties: Property[];
  rows: Row[];
  api: DatabaseApi;
  readOnly?: boolean;
  locked?: boolean;
  onCreateDateProperty: () => void;
  /** What the view's color rules color, by row id (see lib/color-rules). */
  colors?: ReadonlyMap<string, RowColors>;
}) {
  const t = useTranslations("database");
  const format = useFormatter();
  const today = useToday();
  const timeZone = useViewerTimeZone();
  // The day shown, and the first day of the strip: viewers pick their own, never saved.
  const [day, setDay] = useState(today);
  const [first, setFirst] = useState(today);
  const { editTitleOf, typed, create: createNew, stopEditing, quick } = useNewRow(api, view, properties);
  const access = usePropertyAccess();

  const date = agendaDateProperty(view.config, properties);
  const status = agendaStatusProperty(view.config, properties);
  const priority = agendaPriorityProperty(view.config, properties);
  const undatedShown = showsUndated(view.config);
  const sections = useMemo(
    () => agendaSections(rows, { date, status, priority, day, today, timeZone, undated: undatedShown }),
    [rows, date, status, priority, day, today, timeZone, undatedShown],
  );
  const days = useMemo(() => stripDays(first), [first]);
  const counts = useMemo(() => openRowsPerDay(rows, days, date, status, timeZone), [rows, days, date, status, timeZone]);

  if (!date) {
    return (
      <div className="page-gutter">
        <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed border-border px-6 py-10">
          <div>
            <p className="text-sm font-medium">{t("agenda.needsDateTitle")}</p>
            <p className="mt-1 text-sm text-fg-muted">{t("calendar.needsDateBody")}</p>
          </div>
          {!readOnly && !locked && (
            <Button size="sm" onClick={onCreateDateProperty}>
              <Plus className="h-3.5 w-3.5" />
              {t("calendar.addDateProperty", { name: t("calendar.defaultDateProperty") })}
            </Button>
          )}
        </div>
      </div>
    );
  }

  const dayNum = dayNumber(day);
  const todayNum = dayNumber(today);
  const longDay = (d: number) => format.dateTime(utcDay(d), { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  const pick = (next: string) => {
    setDay(next);
    const n = dayNumber(next);
    const start = dayNumber(first);
    if (n < start || n >= start + days.length) setFirst(next);
  };
  const shiftStrip = (weeks: number) => {
    const start = dayNumber(first) + weeks * 7;
    setFirst(dayString(start));
    // The day shown stays in sight: it follows the strip when it would leave it.
    if (dayNum < start || dayNum >= start + days.length) setDay(dayString(weeks > 0 ? start : start + days.length - 1));
  };

  const canAdd = !readOnly && access.canEditValues(date.id);
  const add = () => void createNew(() => api.createRow({ properties: { [date.id]: day } }));
  // Chips show the values the view shows, but those the agenda draws itself.
  const shownProps = properties.filter((p) => p.id !== date.id && p.id !== status?.id && p.id !== priority?.id);

  const rowList = (list: Row[], kind: "overdue" | "day" | "undated") =>
    list.map((row) => (
      <AgendaRow
        key={row.id}
        workspaceId={workspaceId}
        view={view}
        row={row}
        kind={kind}
        date={date}
        status={status}
        priority={priority}
        props={shownProps}
        today={today}
        timeZone={timeZone}
        color={colors?.get(row.id)}
        readOnly={readOnly}
        api={api}
        editTitle={editTitleOf === row.id}
        typed={typed}
        onTitle={(title) => {
          stopEditing();
          if (title !== row.title) quick.save(row.id, title);
        }}
      />
    ));

  return (
    <QuickAddContext value={quick}>
      <div className="page-gutter pb-6">
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <h2 className="text-base font-semibold" aria-live="polite">
            {dayNum === todayNum ? t("agenda.today") : format.dateTime(utcDay(dayNum), { weekday: "long", timeZone: "UTC" })}
            <span className="ms-2 text-sm font-normal text-fg-muted">
              {format.dateTime(utcDay(dayNum), { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })}
            </span>
          </h2>
          <div className="flex items-center gap-1">
            <Button size="sm" variant="secondary" onClick={() => pick(today)} disabled={day === today && first === today}>
              {t("agenda.today")}
            </Button>
            <IconButton label={t("agenda.previousWeek")} onClick={() => shiftStrip(-1)} className="h-7 w-7">
              <ChevronLeft className="h-4 w-4 rtl:-scale-x-100" />
            </IconButton>
            <IconButton label={t("agenda.nextWeek")} onClick={() => shiftStrip(1)} className="h-7 w-7">
              <ChevronRight className="h-4 w-4 rtl:-scale-x-100" />
            </IconButton>
          </div>
        </div>

        <div role="group" aria-label={t("agenda.days")} className="-mx-1 mt-2 flex gap-1 overflow-x-auto px-1 pb-1">
          {days.map((d) => {
            const n = dayNumber(d);
            const open = counts.get(d) ?? 0;
            const selected = d === day;
            return (
              <button
                key={d}
                type="button"
                aria-pressed={selected}
                aria-label={open ? t("agenda.dayWithOpen", { day: longDay(n), count: open }) : longDay(n)}
                title={open ? t("agenda.openCount", { count: open }) : undefined}
                onClick={() => pick(d)}
                className={cn(
                  "relative flex w-12 shrink-0 flex-col items-center rounded-lg border py-1.5 transition-colors",
                  selected ? "border-border bg-bg shadow-[0_1px_2px_rgb(0_0_0/0.06)]" : "border-transparent hover:bg-bg-hover",
                )}
              >
                <span className={cn("text-base leading-6 font-semibold", n === todayNum ? "text-danger" : selected ? "text-fg" : "text-fg-muted")}>
                  {format.dateTime(utcDay(n), { day: "numeric", timeZone: "UTC" })}
                </span>
                <span className={cn("text-xs", n === todayNum ? "text-danger" : "text-fg-faint")}>
                  {format.dateTime(utcDay(n), { weekday: "short", timeZone: "UTC" })}
                </span>
                <span aria-hidden className={cn("mt-0.5 h-1 w-1 rounded-full", open ? "bg-accent" : "bg-transparent")} />
              </button>
            );
          })}
        </div>

        {!status && <p className="mt-2 text-xs text-fg-faint">{t("agenda.needsStatus")}</p>}

        {sections.overdue.length > 0 && (
          <Section title={t("agenda.overdue")} count={sections.overdue.length} danger>
            {rowList(sections.overdue, "overdue")}
          </Section>
        )}
        <Section title={dayNum === todayNum ? t("agenda.today") : longDay(dayNum)} count={sections.day.length}>
          {rowList(sections.day, "day")}
          {!sections.day.length && !canAdd && <p className="px-2 py-3 text-sm text-fg-muted">{t("agenda.nothingPlanned")}</p>}
        </Section>
        {canAdd && (
          <button
            type="button"
            onClick={add}
            className="mt-0.5 flex h-8 w-full items-center gap-1.5 rounded-md px-2 text-sm text-fg-muted hover:bg-bg-hover hover:text-fg"
          >
            <Plus className="h-3.5 w-3.5" />
            {sections.day.length ? t("list.new") : t("agenda.nothingPlannedAdd")}
          </button>
        )}
        {undatedShown && sections.undated.length > 0 && (
          <Section title={t("agenda.undated")} count={sections.undated.length}>
            {rowList(sections.undated, "undated")}
          </Section>
        )}
      </div>
    </QuickAddContext>
  );
}

function Section({ title, count, danger, children }: { title: string; count: number; danger?: boolean; children: ReactNode }) {
  return (
    <section className="mt-4">
      <h3 className={cn("flex items-center gap-1.5 px-2 pb-1 text-xs font-medium", danger ? "text-danger" : "text-fg-muted")}>
        {title}
        {count > 0 && <span className="text-fg-faint">{count}</span>}
      </h3>
      <div role="list" aria-label={title} className="flex flex-col">
        {children}
      </div>
    </section>
  );
}

function AgendaRow({
  workspaceId,
  view,
  row,
  kind,
  date,
  status,
  priority,
  props,
  today,
  timeZone,
  color,
  readOnly,
  api,
  editTitle,
  typed,
  onTitle,
}: {
  workspaceId: string;
  view: View;
  row: Row;
  kind: "overdue" | "day" | "undated";
  date: Property;
  status: Property | undefined;
  priority: Property | undefined;
  props: Property[];
  today: string;
  timeZone: string;
  color?: RowColors;
  readOnly?: boolean;
  api: DatabaseApi;
  editTitle: boolean;
  typed?: string;
  onTitle: (title: string) => void;
}) {
  const t = useTranslations("database");
  const tc = useTranslations("common");
  const format = useFormatter();
  const opener = useRowOpener(workspaceId);
  const access = usePropertyAccess();
  const isOpen = useIsOpenRow(opener, row.id);
  const [dateAnchor, setDateAnchor] = useState<HTMLElement | null>(null);
  const changeButton = useRef<HTMLButtonElement>(null);
  const label = pageLabel(row.title, tc("untitled"));

  const value = row.properties[date.id];
  const canDate = !readOnly && access.valueAccess(row, date.id) === "edit";
  const statusValue = status ? row.properties[status.id] : undefined;
  const done = isAgendaDone(status, statusValue);
  const doneNext = status ? agendaDoneValue(status, !done) : undefined;
  const canTick = !readOnly && !!status && access.valueAccess(row, status.id) === "edit" && doneNext !== undefined;
  const option = priority ? optionOf(priority, row.properties[priority.id]) : undefined;
  const priorityHidden = priority ? access.valueAccess(row, priority.id) === "hidden" : true;
  const shown = shownValues(
    props.filter((p) => !isHiddenInView(view, p)),
    row,
    { buttons: true },
  );

  const when = whenLabel(value, kind, timeZone, today, format, t("agenda.allDay"));

  return (
    <div
      role="listitem"
      className={cn(
        "group relative flex min-h-11 items-start gap-2.5 border-b border-border px-2 py-2 hover:bg-bg-hover",
        isOpen && "bg-bg-hover",
        color?.row && `${colorMarkClass(color.row)} mark-hover`,
      )}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={done}
        aria-label={t(done ? "agenda.reopen" : "agenda.complete", { title: label })}
        title={status ? (status.type === "status" ? optionOf(status, statusValue)?.name : status.name) : t("agenda.needsStatus")}
        disabled={!canTick}
        onClick={() => status && doneNext !== undefined && void api.setCell(row.id, status.id, doneNext)}
        className={cn(
          "mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border-[1.5px] transition-colors disabled:cursor-default",
          done ? "border-fg bg-fg text-bg" : "border-fg-faint enabled:hover:border-fg-muted",
        )}
      >
        {done && <Check className="h-3 w-3" strokeWidth={3} />}
      </button>
      <div className="min-w-0 flex-1">
        <div
          role="link"
          tabIndex={0}
          {...openRowProps(opener, row.id, !editTitle)}
          onClick={(e) => !editTitle && opener.open(row.id, e)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !editTitle && e.target === e.currentTarget) opener.open(row.id, e);
          }}
          className="flex min-w-0 cursor-pointer items-center gap-2 rounded-sm"
        >
          {view.config.showIcons !== false && <PageIcon icon={row.icon} className="shrink-0" />}
          {editTitle ? (
            <CardTitleInput initial={typed || row.title} onDone={onTitle} />
          ) : (
            <span
              className={cn(
                "min-w-0 truncate text-sm font-medium",
                !row.title && "text-fg-faint",
                done && "text-fg-muted line-through",
                cellMarkClass(color, "title"),
              )}
            >
              {label}
            </span>
          )}
        </div>
        {(when || (option && !priorityHidden) || shown.length > 0) && (
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-fg-muted">
            {when && <span className={cn("shrink-0 tabular-nums", kind === "overdue" && "text-danger")}>{when}</span>}
            {option && !priorityHidden && <OptionChip option={option} className="shrink-0" />}
            {shown.map((p) => {
              const valueAccess = access.valueAccess(row, p.id);
              return (
                <span key={p.id} className={cn("flex min-w-0 items-center", cellMarkClass(color, p.id))} title={p.name}>
                  <PropertyCell
                    variant="list"
                    prop={p}
                    value={row.properties[p.id]}
                    style={row.styles?.[p.id]}
                    hidden={valueAccess === "hidden"}
                    readOnly={readOnly || valueAccess === "readOnly"}
                    onChange={(v) => void api.setCell(row.id, p.id, v)}
                    onCreateOption={api.createOption}
                    rowValues={row.properties}
                    upload={p.type === "files" ? uploadToPage(row.id) : undefined}
                    rowId={row.id}
                  />
                </span>
              );
            })}
          </div>
        )}
      </div>
      {canDate && !editTitle && (
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100">
          {!done && (
            <IconButton label={t("agenda.postpone")} onClick={() => void api.setCell(row.id, date.id, postponedDate(value, today, timeZone))}>
              <CalendarClock className="h-3.5 w-3.5" />
            </IconButton>
          )}
          <IconButton ref={changeButton} label={t("agenda.changeDate")} onClick={() => setDateAnchor(changeButton.current)}>
            <CalendarDays className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      )}
      {!readOnly && !editTitle && <RowMenu opener={opener} rowId={row.id} onDelete={() => api.deleteRow(row.id)} className="shrink-0" />}
      {dateAnchor && (
        <DateEditor
          value={value}
          anchor={dateAnchor}
          format={date.options.date?.format}
          onChange={(next) => void api.setCell(row.id, date.id, next)}
          onClose={() => {
            setDateAnchor(null);
            changeButton.current?.focus({ preventScroll: true });
          }}
        />
      )}
    </div>
  );
}

type Format = ReturnType<typeof useFormatter>;

/**
 * When a row is, as its line says: the time (or "all day") on the day shown, the days of a date
 * over several days, and the date itself for overdue rows. Nothing for rows without a date.
 */
function whenLabel(value: unknown, kind: "overdue" | "day" | "undated", timeZone: string, today: string, format: Format, allDay: string): string | null {
  const parts = parseDateValue(value);
  const days = dateDays(value, timeZone);
  if (!parts || !days) return null;
  const time = (iso: string) => format.dateTime(new Date(iso), { hour: "numeric", minute: "2-digit", timeZone });
  const dayText = (d: number) =>
    format.dateTime(utcDay(d), {
      weekday: "short",
      day: "numeric",
      month: "short",
      ...(String(utcDay(d).getUTCFullYear()) !== today.slice(0, 4) ? { year: "numeric" } : {}),
      timeZone: "UTC",
    });
  const range = days.end > days.start ? `${dayText(days.start)} – ${dayText(days.end)}` : null;
  if (kind === "overdue") return range ?? (parts.time ? `${dayText(days.start)} ${time(parts.start)}` : dayText(days.start));
  if (range) return parts.time ? `${range} · ${time(parts.start)}` : range;
  if (!parts.time) return allDay;
  return parts.end ? `${time(parts.start)} – ${time(parts.end)}` : time(parts.start);
}

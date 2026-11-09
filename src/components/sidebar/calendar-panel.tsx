"use client";

import { AlarmClock, CalendarClock, CalendarDays, ChevronLeft, ChevronRight, CircleCheck, NotebookPen } from "lucide-react";
import Link from "next/link";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { IconGlyph } from "@/components/builtin-icon";
import { ItemLink } from "@/components/calendar/item-link";
import { useCalendarItems } from "@/components/calendar/use-calendar-items";
import { useViewerTimeZone } from "@/components/database/use-today";
import { PanelEmpty, panelHeading, panelMeta, panelRow, panelRowActive, panelSection } from "@/components/sidebar/panel";
import { cn } from "@/components/ui";
import { firstDayOfWeek, monthWeeks } from "@/lib/calendar";
import { agendaDays, CALENDAR_MAX_DAYS, CALENDAR_PANEL_DAYS, placeItems, type CalendarItemKind, type PlacedItem } from "@/lib/calendar-items";
import { dayString, localDay } from "@/lib/time-zone";

const KIND_ICONS: Record<CalendarItemKind, typeof CalendarDays> = { event: CalendarDays, meeting: NotebookPen, task: CircleCheck, reminder: AlarmClock, block: CalendarClock };

/** A day number as a Date at its midnight in UTC: days are formatted in UTC so zones never shift them. */
const utcDay = (day: number) => new Date(day * 86_400_000);

export type CalendarPanelProps = {
  workspaceId: string;
  /** The page shown, to mark the item that is open and read again as it changes. */
  pathname: string;
  offline: boolean;
  /** The pages the panel lists, so the tab stays while one of them is open. */
  onPages: (ids: Set<string>) => void;
};

/**
 * The sidebar's Calendar tab: a month to pick a day from (opening the Calendar page on its week),
 * its days with something on them dotted, then what the person has from today on for a week
 * (server/calendar.ts), each item opening its page.
 */
export function CalendarPanel({ workspaceId, pathname, offline, onPages }: CalendarPanelProps) {
  const t = useTranslations("calendar");
  const format = useFormatter();
  const locale = useLocale();
  const timeZone = useViewerTimeZone();
  const today = localDay(Date.now(), timeZone);
  const weekStart = firstDayOfWeek(locale);
  const todayDate = utcDay(today);
  const [month, setMonth] = useState(todayDate.getUTCFullYear() * 12 + todayDate.getUTCMonth());
  const weeks = useMemo(() => monthWeeks(Math.floor(month / 12), month % 12, weekStart), [month, weekStart]);
  const gridFirst = weeks[0];
  const gridLast = weeks[weeks.length - 1] + 6;
  const agendaLast = today + CALENDAR_PANEL_DAYS - 1;
  // One read for the month and the week from today while they fit in one, else one for each.
  const together = Math.max(gridLast, agendaLast) - Math.min(gridFirst, today) < CALENDAR_MAX_DAYS;
  const from = together ? Math.min(gridFirst, today) : gridFirst;
  const to = together ? Math.max(gridLast, agendaLast) : gridLast;
  const shown = useCalendarItems(workspaceId, dayString(from), dayString(to), { offline, again: pathname });
  const apart = useCalendarItems(workspaceId, dayString(today), dayString(agendaLast), { offline: offline || together, again: pathname });

  const placed = useMemo(() => placeItems(shown.items ?? [], timeZone), [shown.items, timeZone]);
  const agendaPlaced = useMemo(() => (together ? placed : placeItems(apart.items ?? [], timeZone)), [together, placed, apart.items, timeZone]);
  const busyDays = useMemo(() => {
    const days = new Set<number>();
    for (const p of placed) for (let d = Math.max(p.start, gridFirst); d <= Math.min(p.end, gridLast); d++) days.add(d);
    return days;
  }, [placed, gridFirst, gridLast]);
  const agendaLoaded = together ? shown.items !== null : apart.items !== null;
  const agenda = agendaDays(agendaPlaced, dayString(today), CALENDAR_PANEL_DAYS).filter((d, i) => i === 0 || d.items.length > 0);
  const pageIds = agenda.flatMap((d) => d.items.flatMap((p) => /\/p\/([^/?#]+)/.exec(p.item.href ?? "")?.[1] ?? [])).join(" ");
  useEffect(() => {
    onPages(new Set(pageIds ? pageIds.split(" ") : []));
  }, [pageIds, onPages]);

  const calendarPath = `/w/${workspaceId}/calendar`;
  const monthLabel = format.dateTime(utcDay(weeks[0] + 7), { month: "long", year: "numeric", timeZone: "UTC" });
  const dayHeading = (day: string) => {
    const n = Math.round(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
    if (n === today) return t("today");
    if (n === today + 1) return t("tomorrow");
    return format.dateTime(utcDay(n), { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" });
  };
  const timeOf = (p: PlacedItem, day: number) =>
    p.time && p.start === day && p.end === p.start ? format.dateTime(new Date(p.startMinutes * 60_000), { hour: "numeric", minute: "2-digit", timeZone: "UTC" }) : null;

  return (
    <div className="flex flex-col">
      <section aria-label={monthLabel}>
        <div className="flex h-7 items-center gap-1 ps-2">
          <Link href={calendarPath} className="min-w-0 flex-1 truncate text-xs font-medium text-fg hover:underline">
            {monthLabel}
          </Link>
          <button
            type="button"
            aria-label={t("previousMonth")}
            title={t("previousMonth")}
            onClick={() => setMonth((m) => m - 1)}
            className="flex h-6 w-6 items-center justify-center rounded-md text-fg-icon hover:bg-bg-hover hover:text-fg"
          >
            <ChevronLeft className="h-3.5 w-3.5 rtl:rotate-180" />
          </button>
          <button
            type="button"
            aria-label={t("nextMonth")}
            title={t("nextMonth")}
            onClick={() => setMonth((m) => m + 1)}
            className="flex h-6 w-6 items-center justify-center rounded-md text-fg-icon hover:bg-bg-hover hover:text-fg"
          >
            <ChevronRight className="h-3.5 w-3.5 rtl:rotate-180" />
          </button>
        </div>
        <div role="grid" aria-label={monthLabel} className="mt-1 grid grid-cols-7 px-1 text-center">
          <div role="row" className="contents">
            {[0, 1, 2, 3, 4, 5, 6].map((i) => (
              <span key={i} role="columnheader" className="flex h-6 items-center justify-center text-[11px] text-fg-faint">
                {format.dateTime(utcDay(weeks[0] + i), { weekday: "narrow", timeZone: "UTC" })}
              </span>
            ))}
          </div>
          {weeks.map((start) => (
            <div key={start} role="row" className="contents">
              {[0, 1, 2, 3, 4, 5, 6].map((i) => {
                const day = start + i;
                const date = utcDay(day);
                const inMonth = date.getUTCFullYear() * 12 + date.getUTCMonth() === month;
                const label = format.dateTime(date, { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
                return (
                  <span key={day} role="gridcell" className="flex h-7 items-center justify-center">
                    <Link
                      href={`${calendarPath}?d=${dayString(day)}`}
                      aria-label={busyDays.has(day) ? t("dayBusy", { date: label }) : label}
                      aria-current={day === today ? "date" : undefined}
                      className={cn(
                        "relative flex h-6 w-6 items-center justify-center rounded-full text-xs tabular-nums hover:bg-bg-hover",
                        day === today ? "bg-accent font-medium text-accent-fg hover:bg-accent" : inMonth ? "text-fg" : "text-fg-faint",
                      )}
                    >
                      {date.getUTCDate()}
                      {busyDays.has(day) && day !== today && <span aria-hidden className="absolute bottom-0.5 h-1 w-1 rounded-full bg-fg-muted" />}
                    </Link>
                  </span>
                );
              })}
            </div>
          ))}
        </div>
      </section>
      {agendaLoaded &&
        agenda.map(({ day, items }) => {
          const n = Math.round(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
          const id = `calendar-panel-${day}`;
          return (
            <section key={day} aria-labelledby={id} className={panelSection}>
              <h3 id={id} className={panelHeading}>
                {dayHeading(day)}
              </h3>
              {items.length === 0 ? (
                <PanelEmpty>{t("nothingToday")}</PanelEmpty>
              ) : (
                <ul className="space-y-px">
                  {items.map((p) => {
                    const Icon = KIND_ICONS[p.item.kind];
                    const current = pathname === p.item.href;
                    const time = timeOf(p, n);
                    return (
                      <li key={p.item.id}>
                        <ItemLink href={p.item.href} aria-current={current ? "page" : undefined} title={p.item.detail ?? undefined} className={cn(panelRow, current && panelRowActive)}>
                          <span className="flex h-4 w-4 shrink-0 items-center justify-center text-fg-icon">
                            {p.item.icon ? <IconGlyph icon={p.item.icon} className="text-sm" /> : <Icon className="h-4 w-4" aria-hidden />}
                          </span>
                          <span className={cn("min-w-0 flex-1 truncate", p.item.done && "text-fg-muted line-through")}>{p.item.title.trim() || t("untitled")}</span>
                          {time && <span className={cn("shrink-0", panelMeta)}>{time}</span>}
                        </ItemLink>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          );
        })}
    </div>
  );
}

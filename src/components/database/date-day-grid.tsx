"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { cn } from "@/components/ui";
import { firstDayOfWeek, monthWeeks, weekDays } from "@/lib/calendar";
import { dayNumber, dayString, monthDay } from "@/lib/time-zone";

const utcDay = (day: number) => new Date(day * 86_400_000);
/** The month a day is in, counted from January of year 0 (see lib/time-zone monthDay). */
const monthIndexOf = (day: string) => Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7)) - 1;

/**
 * The days of a month to pick a date from in the date editor. A click picks the day; a click with
 * Shift held picks the other end of a range (`extend`). The days from `start` to `end` are marked.
 * Loaded with the editor only (see DateEditor), so the first load doesn't carry it.
 */
export function DayGrid({
  start,
  end,
  today,
  onPick,
}: {
  start: string | null;
  end: string | null;
  today: string;
  onPick: (day: string, extend: boolean) => void;
}) {
  const t = useTranslations("database");
  const format = useFormatter();
  const locale = useLocale();
  // Follows the picked day to its month (typed into the field, or "Today"); the arrows move on from there.
  const shownFor = start ?? today;
  const [month, setMonth] = useState({ for: shownFor, index: monthIndexOf(shownFor) });
  if (month.for !== shownFor) setMonth({ for: shownFor, index: monthIndexOf(shownFor) });
  const index = month.index;
  const weekStart = firstDayOfWeek(locale);
  const weeks = monthWeeks(Math.floor(index / 12), index % 12, weekStart);
  const from = start ? dayNumber(start) : null;
  const to = end && start && end > start ? dayNumber(end) : from;
  const todayNumber = dayNumber(today);
  const nav = "inline-flex h-6 w-6 items-center justify-center rounded text-fg-muted hover:bg-bg-hover hover:text-fg";
  const turn = (by: number) => setMonth({ for: shownFor, index: index + by });

  return (
    <div>
      <div className="flex items-center justify-between ps-1 pb-1">
        <span className="text-sm font-medium">
          {format.dateTime(utcDay(monthDay(index, 1)), { month: "long", year: "numeric", timeZone: "UTC" })}
        </span>
        <span className="flex gap-0.5">
          <button type="button" aria-label={t("calendar.previous")} title={t("calendar.previous")} onClick={() => turn(-1)} className={nav}>
            <ChevronLeft className="h-3.5 w-3.5 rtl:-scale-x-100" />
          </button>
          <button type="button" aria-label={t("calendar.next")} title={t("calendar.next")} onClick={() => turn(1)} className={nav}>
            <ChevronRight className="h-3.5 w-3.5 rtl:-scale-x-100" />
          </button>
        </span>
      </div>
      <div className="grid grid-cols-7 text-center text-xs">
        {weekDays(weeks[0], weekStart).map((day) => (
          <span key={day} aria-hidden className="py-1 text-fg-faint">
            {format.dateTime(utcDay(day), { weekday: "narrow", timeZone: "UTC" })}
          </span>
        ))}
        {weeks.flatMap((week) =>
          weekDays(week, weekStart).map((day) => {
            const picked = day === from || day === to;
            const range = from !== null && to !== null && to > from;
            const inRange = range && day >= from && day <= to;
            const outside = monthIndexOf(dayString(day)) !== index;
            return (
              <span
                key={day}
                className={cn(
                  "py-px",
                  inRange && "bg-accent/10",
                  inRange && day === from && "rounded-s-md",
                  inRange && day === to && "rounded-e-md",
                )}
              >
                <button
                  type="button"
                  aria-pressed={picked}
                  aria-label={format.dateTime(utcDay(day), { dateStyle: "full", timeZone: "UTC" })}
                  onClick={(e) => onPick(dayString(day), e.shiftKey)}
                  className={cn(
                    "mx-auto flex h-7 w-7 items-center justify-center rounded-md tabular-nums",
                    picked ? "bg-accent text-accent-fg" : "hover:bg-bg-hover",
                    !picked && outside && "text-fg-faint",
                    !picked && day === todayNumber && "font-semibold text-accent",
                  )}
                >
                  {format.dateTime(utcDay(day), { day: "numeric", timeZone: "UTC" })}
                </button>
              </span>
            );
          }),
        )}
      </div>
      <p className="px-1 pt-1.5 text-xs text-fg-faint">{t("cell.rangeHint")}</p>
    </div>
  );
}

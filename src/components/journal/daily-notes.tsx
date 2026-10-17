"use client";

import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState, useTransition, type ReactNode } from "react";
import {
  dailyNoteDaysAction,
  journalSettingsAction,
  openDailyNoteAction,
  setJournalStartAction,
  type JournalStartChoice,
} from "@/app/actions/journal";
import { cn, Popover, selectClass } from "@/components/ui";
import type { JournalStart } from "@/db/schema";
import { firstDayOfWeek, monthWeeks } from "@/lib/calendar";
import { addDays, today } from "@/lib/journal";
import { pageLabel } from "@/lib/labels";
import { dayNumber, dayString } from "@/lib/time-zone";

/**
 * Opens the user's note for a day (today in the browser's time zone when none is given), making it
 * when there is none, then goes to it. One way in for the sidebar, the home page, the calendar and
 * date mentions.
 */
export function useOpenDailyNote(workspaceId: string, onOpened?: () => void) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const open = useCallback(
    (day: string = today()) => {
      setError(null);
      startTransition(async () => {
        const result = await openDailyNoteAction(workspaceId, day);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        router.push(`/w/${workspaceId}/p/${result.data.pageId}`);
        if (result.data.created) router.refresh();
        onOpened?.();
      });
    },
    [router, workspaceId, onOpened],
  );
  return { open, pending, error };
}

/** A button that opens today's note (or `day`'s). */
export function OpenDailyNoteButton({
  workspaceId,
  day,
  className,
  children,
}: {
  workspaceId: string;
  day?: string;
  className?: string;
  children: ReactNode;
}) {
  const { open, pending, error } = useOpenDailyNote(workspaceId);
  return (
    <>
      <button type="button" onClick={() => open(day)} disabled={pending} className={className}>
        {children}
      </button>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </>
  );
}

/** A day number as a Date at its midnight in UTC: days are formatted in UTC so zones never shift them. */
const utcDay = (day: number) => new Date(day * 86_400_000);

/**
 * The calendar button beside "Today" in the sidebar: a month of days, those with a note marked,
 * any of them a click away from its note; and how new notes start. `leading` (the "Today" button)
 * comes before it on the same line, which the calendar opens under, from its start.
 */
export function DailyNotesCalendarButton({
  workspaceId,
  disabled,
  title,
  leading,
}: {
  workspaceId: string;
  disabled?: boolean;
  title?: string;
  leading?: ReactNode;
}) {
  const t = useTranslations("journal");
  const [open, setOpen] = useState(false);
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      className="w-72 p-3"
      wrapperClassName="w-full items-center gap-0.5"
      trigger={({ toggle }) => (
        <>
          {leading}
          <button
            type="button"
            onClick={toggle}
            disabled={disabled}
            aria-label={t("calendar")}
            aria-expanded={open}
            title={title ?? t("calendar")}
            className={cn(
              "flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg disabled:opacity-50",
              open && "bg-bg-active text-fg",
            )}
          >
            <CalendarDays className="h-4 w-4" />
          </button>
        </>
      )}
    >
      {(close) => <DailyNotesCalendar workspaceId={workspaceId} onOpened={close} />}
    </Popover>
  );
}

export function DailyNotesCalendar({ workspaceId, onOpened }: { workspaceId: string; onOpened?: () => void }) {
  const t = useTranslations("journal");
  const format = useFormatter();
  const locale = useLocale();
  const [now] = useState(() => today());
  const [month, setMonth] = useState(() => now.slice(0, 8) + "01");
  const [noted, setNoted] = useState<Set<string>>(new Set());
  const { open, pending, error } = useOpenDailyNote(workspaceId, onOpened);

  useEffect(() => {
    let live = true;
    dailyNoteDaysAction(workspaceId, month).then((result) => {
      if (live && result.ok) setNoted(new Set(result.data.map((n) => n.day)));
    });
    return () => {
      live = false;
    };
  }, [workspaceId, month]);

  const [year, monthIndex] = month.split("-").map(Number);
  const weekStart = firstDayOfWeek(locale);
  const weeks = monthWeeks(year, monthIndex - 1, weekStart);
  const shiftMonth = (by: number) => {
    const index = year * 12 + monthIndex - 1 + by;
    setMonth(`${String(Math.floor(index / 12)).padStart(4, "0")}-${String((index % 12) + 1).padStart(2, "0")}-01`);
  };
  const weekdays = Array.from({ length: 7 }, (_, i) => weeks[0] + i);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => shiftMonth(-1)}
          aria-label={t("previousMonth")}
          className="flex h-7 w-7 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg"
        >
          <ChevronLeft className="h-4 w-4 rtl:-scale-x-100" />
        </button>
        <span className="text-sm font-medium" aria-live="polite">
          {format.dateTime(utcDay(dayNumber(month)), { month: "long", year: "numeric", timeZone: "UTC" })}
        </span>
        <button
          type="button"
          onClick={() => shiftMonth(1)}
          aria-label={t("nextMonth")}
          className="flex h-7 w-7 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg"
        >
          <ChevronRight className="h-4 w-4 rtl:-scale-x-100" />
        </button>
      </div>
      <div role="grid" aria-label={t("calendar")} aria-busy={pending || undefined} className="space-y-0.5">
        <div role="row" className="grid grid-cols-7 text-center text-[11px] text-fg-faint">
          {weekdays.map((day) => (
            <span key={day} role="columnheader">
              {format.dateTime(utcDay(day), { weekday: "narrow", timeZone: "UTC" })}
            </span>
          ))}
        </div>
        {weeks.map((start) => (
          <div key={start} role="row" className="grid grid-cols-7">
            {Array.from({ length: 7 }, (_, i) => {
              const day = dayString(start + i);
              const inMonth = day.slice(0, 7) === month.slice(0, 7);
              const hasNote = noted.has(day);
              const label = format.dateTime(utcDay(start + i), { dateStyle: "long", timeZone: "UTC" });
              return (
                <button
                  key={day}
                  type="button"
                  role="gridcell"
                  disabled={pending}
                  data-day={day}
                  aria-current={day === now ? "date" : undefined}
                  aria-label={hasNote ? t("hasNote", { day: label }) : label}
                  onClick={() => open(day)}
                  className={cn(
                    "relative mx-auto flex h-8 w-8 flex-col items-center justify-center rounded-md text-xs tabular-nums hover:bg-bg-hover",
                    inMonth ? "text-fg" : "text-fg-faint",
                    day === now && "font-semibold text-accent ring-1 ring-accent ring-inset",
                  )}
                >
                  {Number(day.slice(8))}
                  {hasNote && <span aria-hidden className="absolute bottom-1 h-1 w-1 rounded-full bg-accent" />}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <div className="flex justify-between gap-2 text-xs">
        <button
          type="button"
          onClick={() => open(now)}
          className="rounded-md px-1.5 py-1 text-fg-muted hover:bg-bg-hover hover:text-fg"
        >
          {t("openToday")}
        </button>
        <button
          type="button"
          onClick={() => open(addDays(now, -1))}
          className="rounded-md px-1.5 py-1 text-fg-muted hover:bg-bg-hover hover:text-fg"
        >
          {t("yesterday")}
        </button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      <JournalStartPicker workspaceId={workspaceId} />
    </div>
  );
}

/** How the user's new notes start: a few headings, blank, or one of the workspace's page templates. */
function JournalStartPicker({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations("journal");
  const tc = useTranslations("common");
  const [choice, setChoice] = useState<JournalStartChoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();

  useEffect(() => {
    let live = true;
    journalSettingsAction(workspaceId).then((result) => {
      if (live && result.ok) setChoice(result.data);
    });
    return () => {
      live = false;
    };
  }, [workspaceId]);

  if (!choice) return null;
  const value = choice.start === "template" && choice.templateId ? `template:${choice.templateId}` : choice.start;
  const change = (next: string) => {
    const [start, templateId] = next.startsWith("template:")
      ? (["template", next.slice("template:".length)] as const)
      : ([next as JournalStart, null] as const);
    const before = choice;
    setChoice({ ...choice, start, templateId });
    setError(null);
    startSaving(async () => {
      const result = await setJournalStartAction(workspaceId, start, templateId);
      if (!result.ok) {
        setChoice(before);
        setError(result.error);
      }
    });
  };

  return (
    <label className="block space-y-1 border-t border-border pt-3 text-xs text-fg-muted">
      <span>{t("startWith")}</span>
      <select value={value} disabled={saving} onChange={(e) => change(e.target.value)} className={cn(selectClass, "w-full")}>
        <option value="default">{t("startDefault")}</option>
        <option value="blank">{t("startBlank")}</option>
        {choice.templates.length > 0 && (
          <optgroup label={t("startTemplates")}>
            {choice.templates.map((template) => (
              <option key={template.id} value={`template:${template.id}`}>
                {template.icon ? `${template.icon} ` : ""}
                {pageLabel(template.title, tc("untitled"))}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      {error && (
        <span role="alert" className="block text-danger">
          {error}
        </span>
      )}
    </label>
  );
}

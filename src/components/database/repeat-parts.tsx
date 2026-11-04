"use client";

import { Repeat } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useState } from "react";
import { lazyPart } from "@/components/lazy-part";
import { agendaStatusProperty, isAgendaDone } from "@/lib/agenda";
import { dateStartDay } from "@/lib/date-value";
import { nextRepeatValue, presetOf, type RowRepeatRule, type RowRepeatView } from "@/lib/row-repeat";
import { dayNumber, dayString, localDay } from "@/lib/time-zone";
import { useRowRepeats } from "./row-repeat";
import type { Property } from "./types";

/**
 * The parts of rows that repeat (row-repeat.tsx) loaded the first time one shows: a rule in words,
 * the date's ↻ with it, the Repeat row of a date's editor, and where a row marked done goes next.
 */

const RepeatMenu = lazyPart(() => import("./repeat-menu").then((m) => m.RepeatMenu));

/** A rule in words: "Every 2 weeks on Monday and Wednesday", "Every month, after it's done". */
export function useRepeatSummary() {
  const t = useTranslations("database.repeat");
  const locale = useLocale();
  return useCallback(
    (rule: RowRepeatRule) => {
      const preset = presetOf(rule);
      let text: string;
      if (preset === "workdays") text = t("preset.workdays");
      else {
        text = t(`every.${rule.frequency}`, { interval: rule.interval });
        if (rule.weekdays.length) text = t("onDays", { every: text, days: weekdayList(locale, rule.weekdays) });
      }
      if (rule.from === "done") text = t("afterDone", { every: text });
      if (rule.until) text = t("until", { rule: text, date: dayText(locale, rule.until) });
      return text;
    },
    [t, locale],
  );
}

/** Weekdays (0 Sunday … 6 Saturday) by name, Monday first, joined as the language joins a list. */
export function weekdayList(locale: string, weekdays: number[]): string {
  const names = [...weekdays].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => weekdayName(locale, d));
  return new Intl.ListFormat(locale, { type: "conjunction" }).format(names);
}

/** A weekday's name (0 Sunday … 6 Saturday). */
export function weekdayName(locale: string, weekday: number, width: "long" | "short" = "long"): string {
  // 2026-11-01 is a Sunday.
  return new Intl.DateTimeFormat(locale, { weekday: width, timeZone: "UTC" }).format(new Date(Date.UTC(2026, 10, 1 + weekday)));
}

/** A day (YYYY-MM-DD) as the language writes it. */
export function dayText(locale: string, day: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`));
}

/** The ↻ of a date that comes round again, its rule in words on hover; red when the rule couldn't open its last copy. */
export function RepeatMarkPart({ repeat }: { repeat: RowRepeatView }) {
  const t = useTranslations("database.repeat");
  const summary = useRepeatSummary();
  const label = repeat.lastError ? `${summary(repeat.rule)} · ${t(`error.${repeat.lastError}`)}` : summary(repeat.rule);
  return (
    <span title={label} className={repeat.lastError ? "ms-1 inline-flex shrink-0 text-danger" : "ms-1 inline-flex shrink-0 text-fg-faint"}>
      <Repeat className="h-3 w-3" aria-hidden />
      <span className="sr-only">{label}</span>
    </span>
  );
}

/**
 * The Repeat row of a date's editor: the row's rule in words, opening the choices below it. Shows
 * only where rows may repeat; a rule on another of the row's dates moves here when one is picked.
 */
export function RepeatRowPart({ rowId, propertyId, value }: { rowId: string; propertyId: string; value: unknown }) {
  const repeats = useRowRepeats();
  const t = useTranslations("database.repeat");
  const summary = useRepeatSummary();
  const [open, setOpen] = useState(false);
  if (!repeats) return null;
  const repeat = repeats.repeats[rowId];
  const here = repeat?.propertyId === propertyId ? repeat : undefined;
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="-mx-1 flex items-center justify-between gap-2 rounded-md px-1 py-0.5 text-start text-sm hover:bg-bg-hover"
      >
        <span className="flex items-center gap-1.5">
          <Repeat className="h-3.5 w-3.5 text-fg-muted" aria-hidden />
          {t("label")}
        </span>
        <span className={here?.lastError ? "truncate text-danger" : "truncate text-fg-muted"}>{here ? summary(here.rule) : t("off")}</span>
      </button>
      {open && (
        <RepeatMenu
          rowId={rowId}
          propertyId={propertyId}
          value={value}
          repeat={here}
          onDone={() => {
            setOpen(false);
            repeats.reload();
          }}
        />
      )}
    </>
  );
}

/**
 * Where the copy of a row this write marks done will be dated, as the server will work it out
 * (server/row-repeat.ts `openNext`), as the note saying so words it; null when the write doesn't
 * mark a repeating row done.
 */
export function nextRepeatNote(
  locale: string,
  ...args: Parameters<typeof nextRepeatDay>
): ((t: (key: "next", values: { date: string }) => string) => string) | null {
  const next = nextRepeatDay(...args);
  return next ? (t) => t("next", { date: dayText(locale, next) }) : null;
}

function nextRepeatDay(
  repeat: RowRepeatView | undefined,
  properties: Pick<Property, "id" | "type" | "options">[],
  before: Record<string, unknown>,
  changes: Record<string, unknown>,
): string | null {
  if (!repeat) return null;
  const done = agendaStatusProperty({}, properties);
  if (!done || !(done.id in changes)) return null;
  if (isAgendaDone(done, before[done.id]) || !isAgendaDone(done, changes[done.id])) return null;
  const today = dayString(localDay(Date.now(), repeat.timeZone));
  const value = repeat.propertyId in changes ? changes[repeat.propertyId] : before[repeat.propertyId];
  const next = nextRepeatValue(repeat.rule, value, today, today, repeat.timeZone);
  return next === null ? null : (dateStartDay(next, repeat.timeZone) ?? dayString(dayNumber(today)));
}

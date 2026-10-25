import { firstDayOfWeek } from "@/lib/calendar";
import { fold, readDay, timeWords, type ReadRules } from "@/lib/date-words";
import { dayNumber, dayString, localDay, monthDay, zonedInstant, zoneOffset } from "@/lib/time-zone";

/**
 * A date typed as a phrase, the one grammar of every box where a date is typed (the @ menu, a date
 * property's editor, a date mention, date filters): "tomorrow", "next friday", "aug 31 2027",
 * "10/28", "fri 5pm", "in 30m", "2w", "+3d", and the words of lib/date-words in the interface
 * language. Without a clock in it a phrase names a **day** (YYYY-MM-DD, the same day everywhere);
 * with one, or as minutes or hours from now, a **moment** in the person's time zone. Anything
 * unclear (a bare number, a two-digit year, a date that doesn't exist, "in +2w") is refused rather
 * than guessed at. Pure and client-safe; callers load it when someone starts typing.
 */

export type DatePhrase =
  | { kind: "day"; day: string }
  /** `day` and `minutes` past its midnight in the time zone; `at` the instant, as UTC ISO. */
  | { kind: "moment"; day: string; minutes: number; at: string };

export type DatePhraseContext = {
  /** The interface language: its words are read besides English ones. */
  locale: string;
  /** The person's time zone: what "today" and "5pm" mean. */
  timeZone: string;
  /** Now, in milliseconds; the clock's when missing. */
  now?: number;
  /** The day `+2w` and `-3d` count from (YYYY-MM-DD), the one a picker shows; today when missing. */
  reference?: string | null;
  /** The day weeks start on (0 is Sunday), for "next friday" and "next week"; the locale's when missing. */
  weekStart?: number;
  /** Which number of "10/11" is the month (a date property's format); the language's order when missing. */
  order?: ReadRules["order"];
};

const MINUTES_PER_DAY = 24 * 60;
const MINUTE_MS = 60_000;

type Unit = "minute" | "hour" | "day" | "week" | "month";
const UNITS: Record<string, Unit> = {};
for (const [unit, names] of [
  ["minute", ["m", "min", "mins", "minute", "minutes"]],
  ["hour", ["h", "hr", "hrs", "hour", "hours"]],
  ["day", ["d", "day", "days"]],
  ["week", ["w", "wk", "wks", "week", "weeks"]],
  ["month", ["mo", "mos", "month", "months"]],
] as const) {
  for (const name of names) UNITS[name] = unit;
}

type Duration = { sign: 1 | -1; count: number; unit: Unit; fromReference: boolean };

/**
 * "30m", "in 4h", "2 weeks", "+3d", "-1w": a sign counts from the reference day, none (or "in")
 * from now. Null when the text is no duration; "refused" for one that contradicts itself ("in +2w")
 * or counts in a unit there is none of ("+2x").
 */
function durationOf(text: string): Duration | "refused" | null {
  if (/^in [+-]/.test(text)) return "refused";
  const signed = /^([+-]) ?(\d{1,4}) ?([a-z]+)$/.exec(text);
  if (signed) {
    const unit = UNITS[signed[3]];
    return unit ? { sign: signed[1] === "-" ? -1 : 1, count: Number(signed[2]), unit, fromReference: true } : "refused";
  }
  const plain = /^(?:in )?(\d{1,4}) ?([a-z]+)$/.exec(text);
  const unit = plain ? UNITS[plain[2]] : undefined;
  return plain && unit ? { sign: 1, count: Number(plain[1]), unit, fromReference: false } : null;
}

/** The day `count` days, weeks or months after `from` (a day number); months keep the day of the month where it exists. */
function addDays(from: number, unit: "day" | "week" | "month", count: number): number {
  if (unit === "day") return from + count;
  if (unit === "week") return from + 7 * count;
  const [y, m, d] = dayString(from).split("-").map(Number);
  return monthDay(y * 12 + m - 1 + count, d);
}

/** A clock written "9am", "9:30 pm", "12am" or "17:30": minutes past midnight, null when it is none. */
function clockOf(hourText: string, minuteText: string | undefined, meridiem: string | undefined): number | null {
  const hour = Number(hourText);
  const minute = minuteText === undefined ? 0 : Number(minuteText);
  if (minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    return ((hour % 12) + (meridiem.startsWith("p") ? 12 : 0)) * 60 + minute;
  }
  return hour > 23 ? null : hour * 60 + minute;
}

const CLOCK = String.raw`(\d{1,2})(?::(\d{2}))? ?([ap])\.?m\.?|(\d{1,2}):(\d{2})`;
/** A clock at the end, not glued to a number before it ("31 5pm" keeps its space). */
const CLOCK_LAST = new RegExp(String.raw`(?<![\d:/.-])(?:${CLOCK})$`);
const CLOCK_FIRST = new RegExp(String.raw`^(?:${CLOCK}) `);

/** The text without a word for "at" at its end ("friday at", "yarın saat"). */
function withoutAt(text: string, locale: string): string {
  const trimmed = text.replace(/\.$/, "");
  for (const word of timeWords(locale).sort((a, b) => b.length - a.length)) {
    if (trimmed === word) return "";
    if (trimmed.endsWith(` ${word}`)) return trimmed.slice(0, -word.length - 1);
  }
  return text;
}

/** The phrase as a day or a moment, or null when it isn't one or isn't clear. */
export function parseDatePhrase(input: string, context: DatePhraseContext): DatePhrase | null {
  const { locale, timeZone } = context;
  const now = Math.floor((context.now ?? Date.now()) / MINUTE_MS) * MINUTE_MS;
  const today = localDay(now, timeZone);
  const nowMinutes = Math.floor((now + zoneOffset(now, timeZone)) / MINUTE_MS) - today * MINUTES_PER_DAY;
  const reference = context.reference && /^\d{4}-\d{2}-\d{2}$/.test(context.reference) ? dayNumber(context.reference) : today;
  const rules: ReadRules = { phrase: true, weekStart: context.weekStart ?? firstDayOfWeek(locale), order: context.order };
  const text = fold(input)
    .replace(/[,،、，]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    // 2026-10-15T17:30
    .replace(/^(\d{4}-\d{1,2}-\d{1,2})t(?=\d)/, "$1 ");
  if (!text) return null;

  const moment = (day: number, minutes: number): DatePhrase => {
    const days = Math.floor(minutes / MINUTES_PER_DAY);
    const at = zonedInstant(day + days, minutes - days * MINUTES_PER_DAY, timeZone);
    return { kind: "moment", day: dayString(day + days), minutes: minutes - days * MINUTES_PER_DAY, at: new Date(at).toISOString() };
  };
  const dayOf = (part: string): number | null => {
    const duration = durationOf(part);
    if (duration === "refused") return null;
    if (duration) {
      if (duration.unit === "minute" || duration.unit === "hour") return null;
      return addDays(duration.fromReference ? reference : today, duration.unit, duration.sign * duration.count);
    }
    return readDay(part, locale, today, rules);
  };

  // Minutes and hours from now (or from the reference day at this time of day) are a moment.
  const duration = durationOf(text);
  if (duration === "refused") return null;
  if (duration && (duration.unit === "minute" || duration.unit === "hour")) {
    const minutes = duration.sign * duration.count * (duration.unit === "hour" ? 60 : 1);
    if (!duration.fromReference || reference === today) {
      const at = now + minutes * MINUTE_MS;
      const day = localDay(at, timeZone);
      return { kind: "moment", day: dayString(day), minutes: Math.floor((at + zoneOffset(at, timeZone)) / MINUTE_MS) - day * MINUTES_PER_DAY, at: new Date(at).toISOString() };
    }
    return moment(reference, nowMinutes + minutes);
  }

  // A clock after the date ("friday 5pm", "aug 31 at 9 pm") or before it ("17:30 tomorrow").
  const last = CLOCK_LAST.exec(text);
  const first = last ? null : CLOCK_FIRST.exec(text);
  const clock = last ?? first;
  if (clock) {
    const minutes = clockOf(clock[1] ?? clock[4], clock[2] ?? clock[5], clock[3]);
    if (minutes === null) return null;
    const rest = withoutAt((last ? text.slice(0, last.index) : text.slice(clock[0].length)).trim(), locale).trim();
    if (!rest) return moment(minutes > nowMinutes ? today : today + 1, minutes);
    const day = dayOf(rest);
    return day === null ? null : moment(day, minutes);
  }

  const day = dayOf(text);
  return day === null ? null : { kind: "day", day: dayString(day) };
}

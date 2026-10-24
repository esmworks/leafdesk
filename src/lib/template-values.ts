// Client-safe: the row page's editors and chips, the server's row writes and template use.

import { PERSON_ME } from "./property-types";
import { dayString, isTimeZone, localDay } from "./time-zone";

/**
 * Values a row template keeps that are worked out when a row is made from it (server/templates.ts
 * createFromTemplate), however the row is made: by hand, by a button, by the template repeating,
 * by an automation, MCP or the API.
 *
 * - A person property may name `"me"` (PERSON_ME) among its people: whoever adds the row (for a
 *   repeating template, whoever set it to repeat; agents aren't people, so for them it names no one).
 * - A date property may be `"today"` (the day the row is made, in its maker's time zone) or `"now"`
 *   (that moment, a time).
 *
 * - The title may name `@today`, `@now` and `@me`: the day, the moment and the person's name.
 *
 * Only a database's row templates keep them; anywhere else "me" is the writer and dates are dates.
 */

export const DATE_TODAY = "today";
export const DATE_NOW = "now";
export const DATE_MARKERS = [DATE_TODAY, DATE_NOW] as const;
export type DateMarker = (typeof DATE_MARKERS)[number];

/** A date value that is one of the markers (as written: any case, spaces around). */
export function dateMarker(value: unknown): DateMarker | null {
  if (typeof value !== "string") return null;
  const word = value.trim().toLowerCase();
  return word === DATE_TODAY || word === DATE_NOW ? word : null;
}

/** Whether a person value names whoever adds the row. */
export const namesMe = (value: unknown): boolean => Array.isArray(value) && value.includes(PERSON_ME);

/** Who and when a row is made by, for the markers. */
export type MarkerContext = {
  /** The person the row is made as; null when that is no person (an agent). */
  userId: string | null;
  now: Date;
  /** Their time zone (an IANA name); UTC when it isn't one. */
  timeZone?: string | null;
};

/**
 * A template's values with its markers worked out: "me" becomes the person (dropped when there is
 * none, the property cleared when nobody is left), "today" their day and "now" the moment.
 * `types` gives each property's type by id. Values without markers are kept as they are (the same
 * object when there are none).
 */
export function resolveMarkers(values: Record<string, unknown>, types: Record<string, string>, ctx: MarkerContext): Record<string, unknown> {
  let out: Record<string, unknown> | null = null;
  const set = (id: string, value: unknown) => {
    out ??= { ...values };
    if (value === null) delete out[id];
    else out[id] = value;
  };
  const zone = isTimeZone(ctx.timeZone) ? ctx.timeZone : "UTC";
  for (const [id, value] of Object.entries(values)) {
    const type = types[id];
    if (type === "date") {
      const marker = dateMarker(value);
      if (marker === DATE_NOW) set(id, ctx.now.toISOString());
      else if (marker === DATE_TODAY) set(id, dayString(localDay(ctx.now.getTime(), zone)));
    } else if (type === "person" && namesMe(value)) {
      const people = (value as unknown[]).flatMap((v) => (v === PERSON_ME ? (ctx.userId ? [ctx.userId] : []) : typeof v === "string" ? [v] : []));
      const unique = [...new Set(people)];
      set(id, unique.length ? unique : null);
    }
  }
  return out ?? values;
}

/** The words a row template's title may hold that become the day, the moment and the maker's name. */
export const TITLE_MARKERS = ["@today", "@now", "@me"] as const;
const TITLE_MARKER = /(?<![\p{L}\p{N}_.])@(today|now|me)(?![\p{L}\p{N}_])/giu;

/** Whether a title holds any of the markers. */
export const titleHasMarkers = (title: string) => new RegExp(TITLE_MARKER.source, "iu").test(title);

/**
 * A row template's title with its markers worked out: `@today` the day (in the maker's time zone),
 * `@now` the day and time, `@me` the maker's name (nothing for no one: an agent). In `locale` when
 * given ("Oct 24, 2026", "Oct 24, 2026, 14:30"); as ISO otherwise ("2026-10-24", "2026-10-24 14:30"),
 * for writes that come without a language (MCP, the API, automations, repeating templates).
 */
export function resolveTitleMarkers(title: string, ctx: MarkerContext & { name?: string | null; locale?: string | null }): string {
  if (!titleHasMarkers(title)) return title;
  const timeZone = isTimeZone(ctx.timeZone) ? ctx.timeZone : "UTC";
  let formatter: ((options: Intl.DateTimeFormatOptions) => string) | null = null;
  if (ctx.locale) {
    try {
      const locale = ctx.locale;
      new Intl.DateTimeFormat(locale);
      formatter = (options) => new Intl.DateTimeFormat(locale, { ...options, timeZone }).format(ctx.now);
    } catch {
      formatter = null;
    }
  }
  const day = dayString(localDay(ctx.now.getTime(), timeZone));
  const time = () => {
    const parts = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(ctx.now);
    return `${day} ${parts}`;
  };
  const out = title.replace(TITLE_MARKER, (_, word: string) => {
    const marker = word.toLowerCase();
    if (marker === "me") return ctx.userId && ctx.name ? ctx.name : "";
    if (marker === "today") return formatter ? formatter({ dateStyle: "medium" }) : day;
    return formatter ? formatter({ dateStyle: "medium", timeStyle: "short" }) : time();
  });
  return out.replace(/\s{2,}/g, " ").trim();
}

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

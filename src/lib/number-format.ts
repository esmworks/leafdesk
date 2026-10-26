import type { NumberFormat } from "@/db/schema/app";

/**
 * Number formats of number properties (and formulas giving a number): plain numbers, percentages,
 * amounts of money, durations and ratings. Only
 * how values show and how typed text is read; stored values stay plain numbers, so sorting,
 * calculations, CSV and MCP see them as they are. A percentage stores the fraction (0.15) and
 * shows, is typed and is filtered in percent points (15). A duration stores minutes and shows as
 * hours and minutes ("1:30"); a rating stores whole stars. Pure and client-safe.
 */

export type { NumberFormat };

export const NUMBER_FORMATS = ["number", "percent", "currency", "duration", "rating"] as const;
export type NumberFormatKind = (typeof NUMBER_FORMATS)[number];

/** Currencies the property menu offers first; any other ISO 4217 code works too (MCP). */
export const COMMON_CURRENCIES = [
  "TRY", "EUR", "USD", "GBP", "CHF", "JPY", "CAD", "AUD", "CNY", "SEK", "NOK", "DKK", "PLN", "INR",
  "AED", "ARS", "BRL", "CLP", "COP", "CZK", "EGP", "HKD", "HUF", "IDR", "ILS", "KRW", "MAD", "MXN",
  "MYR", "NGN", "NZD", "PEN", "PHP", "RON", "RUB", "SAR", "SGD", "THB", "TWD", "UAH", "VND", "ZAR",
];

/** The Intl options a number format sets. */
export type NumberFormatOptions = Pick<Intl.NumberFormatOptions, "style" | "currency" | "minimumFractionDigits" | "maximumFractionDigits">;

/** Stars a rating has when its format doesn't say, and the most it can have. */
export const DEFAULT_RATING_MAX = 5;
export const MAX_RATING = 10;

/** Decimal places a format can fix; the property menu offers 0 to 4. */
export const MAX_DECIMALS = 8;

/** Fraction digits a plain number keeps when nothing fixes them (more than anyone types). */
const AUTO_DIGITS = 10;

function knownCurrency(code: string) {
  try {
    return Intl.supportedValuesOf("currency").includes(code);
  } catch {
    // An engine without supportedValuesOf: a well-formed code is as far as we can check.
    return true;
  }
}

/**
 * Checks a number format given by the app or MCP. `format` null or "number" without decimals is
 * a plain number (`null`, nothing to store). Returns the format as stored, or what is wrong.
 */
export function checkNumberFormat(input: unknown): { ok: true; format: NumberFormat | null } | { ok: false; message: string } {
  if (input === null || input === undefined) return { ok: true, format: null };
  if (typeof input !== "object" || Array.isArray(input)) return { ok: false, message: "A number format is an object {format, currency, decimals}" };
  const { format, currency, decimals, seconds, max } = input as Record<string, unknown>;
  if (!(NUMBER_FORMATS as readonly unknown[]).includes(format)) {
    return { ok: false, message: `Number format must be one of: ${NUMBER_FORMATS.join(", ")}` };
  }
  if (format === "duration" || format === "rating") {
    if (currency !== undefined && currency !== null) return { ok: false, message: "Only the currency format takes a currency" };
    if (decimals !== undefined && decimals !== null) return { ok: false, message: `A ${format} has no decimal places` };
  }
  if (format === "duration") {
    if (seconds !== undefined && seconds !== null && typeof seconds !== "boolean") return { ok: false, message: "seconds is true or false" };
    return { ok: true, format: { format: "duration", ...(seconds === true ? { seconds: true } : {}) } };
  }
  if (format === "rating") {
    if (max !== undefined && max !== null && !(Number.isInteger(max) && (max as number) >= 1 && (max as number) <= MAX_RATING)) {
      return { ok: false, message: `A rating's max is a whole number from 1 to ${MAX_RATING}` };
    }
    return { ok: true, format: { format: "rating", max: typeof max === "number" ? max : DEFAULT_RATING_MAX } };
  }
  if (decimals !== undefined && decimals !== null && !(Number.isInteger(decimals) && (decimals as number) >= 0 && (decimals as number) <= MAX_DECIMALS)) {
    return { ok: false, message: `Decimals must be a whole number from 0 to ${MAX_DECIMALS}` };
  }
  const places = typeof decimals === "number" ? { decimals } : {};
  if (format !== "currency") {
    if (currency !== undefined && currency !== null) return { ok: false, message: "Only the currency format takes a currency" };
    return { ok: true, format: format === "number" && !("decimals" in places) ? null : { format: format as NumberFormatKind, ...places } };
  }
  const code = typeof currency === "string" ? currency.trim().toUpperCase() : "";
  if (!/^[A-Z]{3}$/.test(code) || !knownCurrency(code)) {
    return { ok: false, message: `The currency format needs a currency, an ISO 4217 code such as TRY, EUR or USD${currency ? ` (got "${String(currency)}")` : ""}` };
  }
  return { ok: true, format: { format: "currency", currency: code, ...places } };
}

/**
 * Intl options for showing a value in `format`. `auto`: the most fraction digits a value keeps
 * when the format doesn't fix them (fewer for averages); a currency then keeps its own.
 */
export function numberFormatOptions(format: NumberFormat | null | undefined, auto = AUTO_DIGITS): NumberFormatOptions {
  // Both bounds when fixed: a currency's default minimum would otherwise clash with a lower maximum.
  const fixed = format?.decimals !== undefined ? { minimumFractionDigits: format.decimals, maximumFractionDigits: format.decimals } : null;
  switch (format?.format) {
    case "percent":
      // In percent points: two places of a fraction's are gone once it is multiplied by 100.
      return { style: "percent", ...(fixed ?? { maximumFractionDigits: Math.min(auto, AUTO_DIGITS - 2) }) };
    case "currency":
      if (format.currency) return { style: "currency", currency: format.currency, ...fixed };
      return fixed ?? { maximumFractionDigits: auto };
    default:
      return fixed ?? { maximumFractionDigits: auto };
  }
}

export function isPercent(format: NumberFormat | null | undefined) {
  return format?.format === "percent";
}

export function isDuration(format: NumberFormat | null | undefined) {
  return format?.format === "duration";
}

export function isRating(format: NumberFormat | null | undefined) {
  return format?.format === "rating";
}

/** How many stars a rating has. */
export function ratingMax(format: NumberFormat | null | undefined) {
  const max = format?.max;
  return typeof max === "number" && Number.isInteger(max) && max >= 1 && max <= MAX_RATING ? max : DEFAULT_RATING_MAX;
}

/**
 * A value in its format as text: `number` formats with Intl (the UI's formatter, or one for a
 * locale), durations show as hours and minutes and ratings as "4/5".
 */
export function formatInFormat(
  value: number,
  format: NumberFormat | null | undefined,
  number: (value: number, options: NumberFormatOptions) => string,
  auto?: number,
): string {
  if (isDuration(format)) return durationText(value, format);
  if (isRating(format)) return `${number(value, { maximumFractionDigits: 1 })}/${ratingMax(format)}`;
  return number(value, numberFormatOptions(format, auto));
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * Minutes as a duration shows them: hours (any number of them) and minutes, "1:30", or with
 * seconds, "1:30:15", when the format shows them. Rounded to what shows.
 */
export function durationText(minutes: number, format?: NumberFormat | null): string {
  if (!Number.isFinite(minutes)) return String(minutes);
  const sign = minutes < 0 ? "-" : "";
  if (format?.seconds) {
    const total = Math.round(Math.abs(minutes) * 60);
    return `${sign}${Math.floor(total / 3600)}:${pad2(Math.floor(total / 60) % 60)}:${pad2(total % 60)}`;
  }
  const total = Math.round(Math.abs(minutes));
  return `${sign}${Math.floor(total / 60)}:${pad2(total % 60)}`;
}

/** Duration units people type after a number, in minutes ("2h 15m", "1 saat 30 dk"). */
const DURATION_UNITS: Record<string, number> = {
  d: 1440, day: 1440, days: 1440, g: 1440, "gün": 1440,
  h: 60, hr: 60, hrs: 60, hour: 60, hours: 60, sa: 60, saat: 60,
  m: 1, min: 1, mins: 1, minute: 1, minutes: 1, dk: 1, dakika: 1,
  s: 1 / 60, sec: 1 / 60, secs: 1 / 60, second: 1 / 60, seconds: 1 / 60, sn: 1 / 60, saniye: 1 / 60,
};

/**
 * Reads a typed duration as minutes: "1:30" (hours and minutes), "1:30:15" (and seconds), numbers
 * with units ("1h 30m", "2d", "45 min", "1.5h") or a plain number of minutes ("90"). Undefined when
 * it is none of these.
 */
export function parseDuration(raw: string, locale?: string): number | undefined {
  let text = raw.trim().toLowerCase();
  if (!text) return undefined;
  const negative = text.startsWith("-");
  if (negative) text = text.slice(1).trim();
  const signed = (n: number) => clean(negative ? -n : n);
  const clock = /^(\d+):([0-5]?\d)(?::([0-5]?\d(?:[.,]\d+)?))?$/.exec(text);
  if (clock) return signed(Number(clock[1]) * 60 + Number(clock[2]) + (clock[3] ? Number(clock[3].replace(",", ".")) / 60 : 0));
  const parts = [...text.matchAll(/(\d+(?:[.,]\d+)?)\s*([\p{L}]+)\.?\s*/gu)];
  if (parts.length && parts.map((p) => p[0]).join("").trim() === text) {
    let total = 0;
    for (const [, amount, unit] of parts) {
      const factor = DURATION_UNITS[unit];
      if (factor === undefined) return undefined;
      total += Number(amount.replace(",", ".")) * factor;
    }
    return signed(total);
  }
  const plain = parseTypedNumber(text, locale);
  return plain === undefined ? undefined : signed(plain);
}

/** Rounds away binary noise (0.07 * 100 is 7.000000000000001). */
function clean(n: number) {
  return Number(n.toPrecision(12));
}

/** A stored fraction in percent points, as percentages are typed and filtered (0.15 → 15). */
export function toPercentPoints(value: number) {
  return clean(value * 100);
}

/** Percent points as the stored fraction (15 → 0.15). */
export function fromPercentPoints(points: number) {
  return clean(points / 100);
}

/**
 * Whether a property of `type` takes a number format: numbers, and formulas while they give a
 * number (`formulaType`, the formula's result type). Formulas giving text, a date or a checkbox don't.
 */
export function takesNumberFormat(type: string, formulaType?: string) {
  return type === "number" || (type === "formula" && formulaType === "number");
}

/**
 * The format a property's own values show in: a number property's, or that of a formula giving a
 * number (with its result type filled in); none for other properties. Rollups have theirs on the
 * rollup (RollupConfig.number).
 */
export function valueFormat(prop: { type: string; options?: { number?: NumberFormat; formula?: { type?: string } } }): NumberFormat | undefined {
  return takesNumberFormat(prop.type, prop.options?.formula?.type) ? prop.options?.number : undefined;
}

/** Calculations whose result is in the unit of the values (a sum of amounts is an amount); counts and shares are not. */
const IN_UNIT = new Set(["sum", "average", "median", "min", "max", "range"]);

/** Calculations whose result is still a rating (a sum of stars is not). */
const IN_STARS = new Set(["average", "median", "min", "max"]);

/** The format a calculation over a number property's values shows in: the property's, or none for counts. */
export function calculationFormat(fn: string, options: { number?: NumberFormat } | undefined): NumberFormat | undefined {
  if (isRating(options?.number)) return IN_STARS.has(fn) ? options?.number : undefined;
  return IN_UNIT.has(fn) ? options?.number : undefined;
}

/** Names people write after an amount besides its code ("100 TL"). */
const CURRENCY_WORDS: Record<string, string[]> = { TRY: ["TL"] };

/**
 * Typed text without what a format puts around a number: a percent sign, a currency symbol, or
 * the property's currency code, so "15 %", "%15", "₺1.234,50" and "1,234.50 EUR" read as numbers.
 * Returns the rest and whether a percent sign was there.
 */
export function stripNumberDecor(raw: string, currency?: string): { text: string; percent: boolean } {
  let text = raw.trim();
  const percent = /^%|%$/.test(text);
  // What ends the text is found without the white space before it, which is then trimmed off:
  // `/\s*%$/` would read on from each space of a long run that ends in something else.
  text = text.replace(/^%\s*/, "");
  if (text.endsWith("%")) text = text.slice(0, -1).trimEnd();
  const words = currency ? [currency, ...(CURRENCY_WORDS[currency] ?? [])].join("|") : null;
  const unit = words ? `\\p{Sc}|(?:${words})(?![\\p{L}])` : "\\p{Sc}";
  const before = new RegExp(`^([+-]?)\\s*(?:${unit})\\s*`, "iu");
  const after = new RegExp(`(?:\\p{Sc}|${words ? `(?<![\\p{L}])(?:${words})` : "\\p{Sc}"})$`, "iu");
  text = text.replace(before, "$1");
  const end = after.exec(text);
  if (end) text = text.slice(0, end.index).trimEnd();
  return { text: text.trim(), percent };
}

/**
 * Parses a typed number in either "1234.5" or "1234,5" style, so it works for input in every UI
 * language. A single separator kind is a decimal point unless it repeats ("1.234.567"); with both
 * kinds, the last one is the decimal point and the other groups thousands ("1.234,5",
 * "1,234.5").
 */
export function parseTypedNumber(raw: string, locale?: string): number | undefined {
  let s = raw.replace(/[\s  ']/g, "");
  if (!s) return undefined;
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma !== -1 && lastDot !== -1) {
    const decimal = lastComma > lastDot ? "," : ".";
    const group = decimal === "," ? "." : ",";
    s = s.split(group).join("").replace(decimal, ".");
  } else {
    const sep = lastComma !== -1 ? "," : lastDot !== -1 ? "." : null;
    // "1,000" in English or "1.000" in Turkish or German: the locale's group separator before exactly three
    // digits groups thousands rather than marking decimals.
    const grouping = sep !== null && locale !== undefined && sep !== decimalSeparator(locale) && /^-?\d{1,3}[.,]\d{3}$/.test(s);
    if (sep) s = s.split(sep).length > 2 || grouping ? s.split(sep).join("") : s.replace(sep, ".");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

export function decimalSeparator(locale: string) {
  return new Intl.NumberFormat(locale).formatToParts(1.5).find((p) => p.type === "decimal")?.value ?? ".";
}

/**
 * Reads typed text as a number property's value: a percent sign or currency symbol around it is
 * fine, and in a percent property the text is in percent points (15 is stored as 0.15), as a
 * percent sign makes it in any number property. Undefined when it isn't a number.
 */
export function readNumber(raw: string, format: NumberFormat | null | undefined, locale?: string): number | undefined {
  if (isDuration(format)) return parseDuration(raw, locale);
  const { text, percent } = stripNumberDecor(raw, format?.format === "currency" ? format.currency : undefined);
  const n = parseTypedNumber(text, locale);
  if (n === undefined) return undefined;
  return percent || isPercent(format) ? fromPercentPoints(n) : n;
}

/**
 * A stored number as an editor shows it: the locale's decimal separator, no grouping, and a
 * percentage in percent points, so what the user sees is what `readNumber` reads back.
 */
export function numberText(value: number, locale: string, format?: NumberFormat | null) {
  if (isDuration(format)) return durationText(value, format);
  const s = String(isPercent(format) ? toPercentPoints(value) : value);
  return decimalSeparator(locale) === "," && !s.includes("e") ? s.replace(".", ",") : s;
}

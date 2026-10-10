import type { PropertyOptions } from "@/db/schema/app";
import { dateMillis, parseDateValue } from "./date-value";
import { isErrorValue } from "./derived";
import { asFiles } from "./files";
import { asChecklist, CREATED_KEY, TITLE_KEY, UPDATED_KEY, type RowLike } from "./properties";

/**
 * Column calculations (table footers today; rollups and charts later). Pure: no React, no
 * database. Values are the stored row values: select values are option ids, people and relations
 * lists of ids, dates `YYYY-MM-DD` strings, times or ranges (see lib/date-value), ISO timestamps
 * for the row's own times.
 */

export const AGGREGATE_FNS = [
  "count_all",
  "count_values",
  "count_unique",
  "count_empty",
  "count_not_empty",
  "percent_empty",
  "percent_not_empty",
  "sum",
  "average",
  "median",
  "min",
  "max",
  "range",
  "earliest_date",
  "latest_date",
  "date_range",
  "count_checked",
  "count_unchecked",
  "percent_checked",
  "percent_unchecked",
] as const;
export type AggregateFn = (typeof AGGREGATE_FNS)[number];

export function isAggregateFn(fn: unknown): fn is AggregateFn {
  return typeof fn === "string" && (AGGREGATE_FNS as readonly string[]).includes(fn);
}

/**
 * How a property's values are read for calculations. `options` values are option ids (deleted
 * options don't count), `people` and `relation` values are lists of ids, `checklist` values lists
 * of items (counted by their text), `files` lists of uploaded files (counted by URL); `other` only gets the generic counts.
 */
export type ValueKind =
  | "text"
  | "number"
  | "date"
  | "checkbox"
  | "options"
  | "people"
  | "relation"
  | "checklist"
  | "files"
  | "other";

/**
 * Property type (or special column key) → value kind. A new property type only needs a line
 * here; types missing from the map get the generic counts. Some entries name types other
 * branches add (status, email, …): an entry for a type that doesn't exist is harmless.
 */
const VALUE_KINDS: Record<string, ValueKind> = {
  [TITLE_KEY]: "text",
  text: "text",
  url: "text",
  email: "text",
  phone: "text",
  number: "number",
  date: "date",
  [CREATED_KEY]: "date",
  [UPDATED_KEY]: "date",
  created_time: "date",
  last_edited_time: "date",
  checkbox: "checkbox",
  select: "options",
  multi_select: "options",
  status: "options",
  person: "people",
  created_by: "people",
  last_edited_by: "people",
  relation: "relation",
  checklist: "checklist",
  files: "files",
};

export function valueKind(type: string): ValueKind {
  return Object.hasOwn(VALUE_KINDS, type) ? VALUE_KINDS[type] : "other";
}

const GENERIC: AggregateFn[] = [
  "count_all",
  "count_values",
  "count_unique",
  "count_empty",
  "count_not_empty",
  "percent_empty",
  "percent_not_empty",
];

/** Calculations offered per kind, in menu order. Checkboxes are never empty, just unchecked. */
const BY_KIND: Record<ValueKind, AggregateFn[]> = {
  text: GENERIC,
  other: GENERIC,
  options: GENERIC,
  people: GENERIC,
  relation: GENERIC,
  checklist: GENERIC,
  files: GENERIC,
  number: [...GENERIC, "sum", "average", "median", "min", "max", "range"],
  date: [...GENERIC, "earliest_date", "latest_date", "date_range"],
  checkbox: ["count_all", "count_checked", "count_unchecked", "percent_checked", "percent_unchecked"],
};

/** The calculations a column of this property type (or special key such as "title") offers. */
export function aggregateFunctions(type: string): AggregateFn[] {
  return BY_KIND[valueKind(type)];
}

export function isApplicable(fn: AggregateFn, type: string) {
  return aggregateFunctions(type).includes(fn);
}

/** Menu sections: generic counts, percentages, then the kind's own calculations. */
export function aggregateGroup(fn: AggregateFn): "count" | "percent" | "kind" {
  if (fn === "count_all" || fn === "count_values" || fn === "count_unique" || fn === "count_empty" || fn === "count_not_empty") {
    return "count";
  }
  if (fn === "percent_empty" || fn === "percent_not_empty") return "percent";
  return "kind";
}

/**
 * A calculation's value and how to show it: `number` in the locale's number format, `percent` a
 * fraction (0.25 = 25%), `date` a stored date string, `days` a length of time in days.
 */
export type AggregateResult =
  | { format: "number"; value: number }
  | { format: "percent"; value: number }
  | { format: "date"; value: string }
  | { format: "days"; value: number };

/** The property a column shows; special columns (title, created/updated time) need none. */
export type AggregateColumn = { type: string; options?: PropertyOptions };

/** The items a value holds: one for plain values, several for lists, none when empty. */
function items(value: unknown, kind: ValueKind, options: PropertyOptions | undefined): unknown[] {
  // A formula that failed on a row has no value there.
  if (value === null || value === undefined || value === "" || isErrorValue(value)) return [];
  switch (kind) {
    case "options": {
      // Ids of deleted options display as empty, so they count as empty.
      const known = new Set((options?.options ?? []).map((o) => o.id));
      return (Array.isArray(value) ? value : [value]).filter((id) => typeof id === "string" && known.has(id));
    }
    case "people":
    case "relation":
      return (Array.isArray(value) ? value : [value]).filter((id) => typeof id === "string" && id !== "");
    case "checklist":
      return asChecklist(value).map((item) => item.text);
    case "files":
      // Each file once, by its URL: "count values" counts files, "count unique" distinct files.
      return asFiles(value).map((file) => file.url);
    case "checkbox":
      return value === true ? [true] : [];
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? [value] : [];
    case "date":
      return dateBounds(value) ? [value] : [];
    case "text":
      return [String(value)];
    case "other":
      return Array.isArray(value) ? value : [value];
  }
}

const key = (item: unknown) => (typeof item === "string" ? item : JSON.stringify(item));
const DAY = 24 * 60 * 60 * 1000;

type DatePoint = { value: string; ms: number };

/**
 * Where a date value starts and ends: a date property's day, time or range of either (see
 * lib/date-value), or a timestamp (created and edited times). Null for anything else.
 */
function dateBounds(value: unknown): { start: DatePoint; end: DatePoint } | null {
  const parts = parseDateValue(value);
  const millis = dateMillis(value);
  if (parts && millis) {
    return { start: { value: parts.start, ms: millis.start }, end: { value: parts.end ?? parts.start, ms: millis.end } };
  }
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : { start: { value, ms }, end: { value, ms } };
}

/**
 * Calculates `fn` over one column's values. Returns null when there is nothing to show (no rows
 * for a percentage, no numbers for an average, no dates for the earliest date) or when `fn`
 * doesn't apply to the column's type.
 */
export function aggregateValues(values: unknown[], fn: AggregateFn, column: AggregateColumn): AggregateResult | null {
  if (!isApplicable(fn, column.type)) return null;
  const kind = valueKind(column.type);
  const perRow = values.map((v) => items(v, kind, column.options));
  const total = perRow.length;
  const filled = perRow.filter((list) => list.length > 0).length;
  const count = (value: number): AggregateResult => ({ format: "number", value });
  const percent = (part: number): AggregateResult | null => (total ? { format: "percent", value: part / total } : null);

  switch (fn) {
    case "count_all":
      return count(total);
    case "count_values":
      return count(perRow.reduce((sum, list) => sum + list.length, 0));
    case "count_unique":
      return count(new Set(perRow.flat().map(key)).size);
    case "count_empty":
    case "count_unchecked":
      return count(total - filled);
    case "count_not_empty":
    case "count_checked":
      return count(filled);
    case "percent_empty":
    case "percent_unchecked":
      return percent(total - filled);
    case "percent_not_empty":
    case "percent_checked":
      return percent(filled);
  }

  if (kind === "number") {
    const numbers = perRow.flat() as number[];
    if (fn === "sum") return count(numbers.reduce((a, b) => a + b, 0));
    if (!numbers.length) return null;
    const sorted = [...numbers].sort((a, b) => a - b);
    switch (fn) {
      case "average":
        return count(numbers.reduce((a, b) => a + b, 0) / numbers.length);
      case "median": {
        const mid = sorted.length >> 1;
        return count(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
      }
      case "min":
        return count(sorted[0]);
      case "max":
        return count(sorted[sorted.length - 1]);
      case "range":
        return count(sorted[sorted.length - 1] - sorted[0]);
    }
  }

  if (kind === "date") {
    // Ranges count by both ends: the earliest date is the first start, the latest the last end.
    const bounds = perRow.flat().flatMap((v) => dateBounds(v) ?? []);
    if (!bounds.length) return null;
    const earliest = bounds.reduce((a, b) => (b.start.ms < a.ms ? b.start : a), bounds[0].start);
    const latest = bounds.reduce((a, b) => (b.end.ms > a.ms ? b.end : a), bounds[0].end);
    switch (fn) {
      case "earliest_date":
        return { format: "date", value: earliest.value };
      case "latest_date":
        return { format: "date", value: latest.value };
      case "date_range":
        return { format: "days", value: Math.round((latest.ms - earliest.ms) / DAY) };
    }
  }
  return null;
}

/**
 * What a rollup does with the values of the rows a row links to: any calculation a column of
 * the target property offers, or "show_original" to list the values themselves.
 */
export type RollupFn = AggregateFn | "show_original";
export const ROLLUP_DISPLAYS = ["number", "bar", "ring"] as const;
/** How a rollup shows a percentage. */
export type RollupDisplay = (typeof ROLLUP_DISPLAYS)[number];

export function isRollupFn(fn: unknown): fn is RollupFn {
  return fn === "show_original" || isAggregateFn(fn);
}

/** The rollup functions a target property type (or "title") offers, "show_original" first. */
export function rollupFunctions(type: string): RollupFn[] {
  return ["show_original", ...aggregateFunctions(type)];
}

export type RollupResult = AggregateResult | { format: "list"; value: string[] };

/**
 * A rollup over the related rows' values of one column: the calculation, or for "show_original"
 * every value as text, in row order (lists such as tags or people flattened, empty values left
 * out). `label` turns a value into its texts (option names, people names, titles…).
 */
export function rollupValues(
  values: unknown[],
  fn: RollupFn,
  column: AggregateColumn,
  label: (value: unknown) => string[],
): RollupResult | null {
  if (fn !== "show_original") return aggregateValues(values, fn, column);
  return { format: "list", value: values.flatMap((v) => label(v)).filter((text) => text !== "") };
}

/** A row's value in a column: a property id or one of the special keys (title, created/updated time). */
export function columnValue(row: RowLike, columnKey: string): unknown {
  if (columnKey === TITLE_KEY) return row.title;
  if (columnKey === CREATED_KEY) return row.createdAt.toISOString();
  if (columnKey === UPDATED_KEY) return row.updatedAt.toISOString();
  return row.properties[columnKey];
}

/**
 * Calculates `fn` over a column of rows (pass the rows the view shows, so filters apply).
 * `column` is the property; special keys (title, created/updated time) don't need one.
 */
export function aggregate(
  rows: RowLike[],
  columnKey: string,
  fn: AggregateFn,
  column: AggregateColumn = { type: columnKey },
): AggregateResult | null {
  return aggregateValues(
    rows.map((row) => columnValue(row, columnKey)),
    fn,
    column,
  );
}

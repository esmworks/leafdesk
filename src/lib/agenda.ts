import type { PropertyOptions, PropertyType, ViewConfig } from "@/db/schema/app";
import { dateDays, dateSortKey, parseDateValue, shiftDateValue } from "./date-value";
import { isDoneStatus, sortStatusOptions, statusFromCheckbox } from "./properties";
import { dayNumber, dayString } from "./time-zone";
import { viewDateProperty } from "./views";

/**
 * Agenda views (pure, client-safe): the rows of one database laid out for a day, picked on a strip
 * of days. Three sections: what is overdue (shown on today only), the day's rows by time, and rows
 * without a date (unless the view hides them). A row is done by its status property (a status in
 * the "done" group, or a ticked checkbox); its priority, when the view names one, is the order of
 * a select's or status's options, the first one highest.
 */

/** What tells an agenda that a row is done. */
export const AGENDA_STATUS_TYPES = ["status", "checkbox"] as const satisfies readonly PropertyType[];
/** What may order an agenda's rows by priority. */
export const AGENDA_PRIORITY_TYPES = ["select", "status"] as const satisfies readonly PropertyType[];
/** Days the strip shows at once; its arrows move it by a week. */
export const AGENDA_STRIP_DAYS = 14;

type Prop = { id: string; type: PropertyType; options: PropertyOptions };
type AgendaRow = { id: string; properties: Record<string, unknown> };

const isStatusType = (type: PropertyType) => (AGENDA_STATUS_TYPES as readonly PropertyType[]).includes(type);
const isPriorityType = (type: PropertyType) => (AGENDA_PRIORITY_TYPES as readonly PropertyType[]).includes(type);

/** The date property an agenda places rows by: the one it names while it is a date, else the first date. */
export function agendaDateProperty<P extends Prop>(config: Pick<ViewConfig, "dateBy">, properties: P[]): P | undefined {
  return viewDateProperty(config, properties);
}

/**
 * The property telling an agenda which rows are done: the one it names while it is a status or a
 * checkbox, else the first status, else the first checkbox.
 */
export function agendaStatusProperty<P extends Prop>(config: Pick<ViewConfig, "statusBy">, properties: P[]): P | undefined {
  return (
    properties.find((p) => p.id === config.statusBy && isStatusType(p.type)) ??
    properties.find((p) => p.type === "status") ??
    properties.find((p) => p.type === "checkbox")
  );
}

/** The property ordering an agenda's rows by priority, while the view names one that still fits; none otherwise. */
export function agendaPriorityProperty<P extends Prop>(config: Pick<ViewConfig, "priorityBy">, properties: P[]): P | undefined {
  return properties.find((p) => p.id === config.priorityBy && isPriorityType(p.type));
}

/** Whether the agenda shows rows without a date (shown unless the view hides them). */
export function showsUndated(config: Pick<ViewConfig, "showUndated">): boolean {
  return config.showUndated !== false;
}

/** Whether `value`, a row's value of the agenda's status property, says the row is done. */
export function isAgendaDone(status: Prop | undefined, value: unknown): boolean {
  if (!status) return false;
  return status.type === "checkbox" ? value === true : isDoneStatus(status, value);
}

/**
 * The value marking a row done (or not done again) on the status property: a tick, or the first
 * option of the status's "done" (or "to do") group. Undefined when the status has no such option.
 */
export function agendaDoneValue(status: Prop, done: boolean): unknown {
  return status.type === "checkbox" ? done : statusFromCheckbox(status, done);
}

/** A priority's rank: its option's place, the first one 0; rows without one come after all of them. */
function priorityRank(priority: Prop | undefined): (row: AgendaRow) => number {
  if (!priority) return () => 0;
  const options = priority.type === "status" ? sortStatusOptions(priority.options.options ?? []) : (priority.options.options ?? []);
  const ranks = new Map(options.map((o, i) => [o.id, i]));
  return (row) => {
    const value = row.properties[priority.id];
    return (typeof value === "string" ? ranks.get(value) : undefined) ?? options.length;
  };
}

export type AgendaSections<R> = {
  /** Rows not done whose date ended before today, oldest first; only when the day shown is today. */
  overdue: R[];
  /** Rows whose date covers the day, by time (whole days first), then by priority. */
  day: R[];
  /** Rows not done without a date, by priority; empty when the view hides them. */
  undated: R[];
};

/**
 * The agenda's sections for `day` (YYYY-MM-DD) as of `today`, from rows already filtered and
 * sorted as the view says: rows equal in the agenda's own order keep the view's order.
 */
export function agendaSections<R extends AgendaRow>(
  rows: readonly R[],
  {
    date,
    status,
    priority,
    day,
    today,
    timeZone,
    undated: withUndated = true,
  }: { date: Prop | undefined; status: Prop | undefined; priority?: Prop; day: string; today: string; timeZone: string; undated?: boolean },
): AgendaSections<R> {
  const rank = priorityRank(priority);
  const shown = dayNumber(day);
  const now = dayNumber(today);
  const overdue: { row: R; key: number }[] = [];
  const onDay: { row: R; key: number }[] = [];
  const undated: R[] = [];
  for (const row of rows) {
    const value = date ? row.properties[date.id] : undefined;
    const days = date ? dateDays(value, timeZone) : null;
    const done = isAgendaDone(status, status ? row.properties[status.id] : undefined);
    if (!days) {
      if (withUndated && !done) undated.push(row);
      continue;
    }
    const key = dateSortKey(value, timeZone) ?? 0;
    if (days.start <= shown && days.end >= shown) onDay.push({ row, key });
    else if (shown === now && days.end < now && !done) overdue.push({ row, key });
  }
  const byKey = (a: { row: R; key: number }, b: { row: R; key: number }) => a.key - b.key || rank(a.row) - rank(b.row);
  return {
    overdue: overdue.sort(byKey).map((e) => e.row),
    day: onDay.sort(byKey).map((e) => e.row),
    undated: undated.map((row, i) => ({ row, i })).sort((a, b) => rank(a.row) - rank(b.row) || a.i - b.i).map((e) => e.row),
  };
}

/**
 * A date moved so it starts the day after `today`, keeping its kind, its length and its time on
 * the clock in `timeZone`; a row without a date gets that day.
 */
export function postponedDate(value: unknown, today: string, timeZone: string): string {
  const tomorrow = dayNumber(today) + 1;
  const days = dateDays(value, timeZone);
  if (!days || !parseDateValue(value)) return dayString(tomorrow);
  return shiftDateValue(value, tomorrow - days.start, timeZone) ?? dayString(tomorrow);
}

/** A date moved to start on `day` (YYYY-MM-DD) the same way; a row without a date gets the day. */
export function movedDate(value: unknown, day: string, timeZone: string): string {
  return postponedDate(value, dayString(dayNumber(day) - 1), timeZone);
}

/** The strip's days from `first` (YYYY-MM-DD): AGENDA_STRIP_DAYS of them. */
export function stripDays(first: string, count = AGENDA_STRIP_DAYS): string[] {
  const start = dayNumber(first);
  return Array.from({ length: count }, (_, i) => dayString(start + i));
}

/** How many rows not done each of `days` holds, for the dots on the strip. */
export function openRowsPerDay(rows: readonly AgendaRow[], days: readonly string[], date: Prop | undefined, status: Prop | undefined, timeZone: string) {
  const counts = new Map<string, number>(days.map((d) => [d, 0]));
  if (!date || !days.length) return counts;
  const first = dayNumber(days[0]);
  const last = dayNumber(days[days.length - 1]);
  for (const row of rows) {
    const span = dateDays(row.properties[date.id], timeZone);
    if (!span || span.end < first || span.start > last) continue;
    if (isAgendaDone(status, status ? row.properties[status.id] : undefined)) continue;
    for (let d = Math.max(span.start, first); d <= Math.min(span.end, last); d++) {
      const key = dayString(d);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * An agenda's settings from the properties it may use, for those `config` doesn't have yet: the
 * first date, and the first status or else checkbox. Priority stays unset until picked.
 */
export function agendaDefaults(properties: readonly Prop[], config: ViewConfig): ViewConfig {
  const out: ViewConfig = {};
  if (!config.dateBy) {
    const date = properties.find((p) => p.type === "date");
    if (date) out.dateBy = date.id;
  }
  if (!config.statusBy) {
    const status = agendaStatusProperty({}, [...properties]);
    if (status) out.statusBy = status.id;
  }
  return out;
}

import type { GroupDateBy, GroupTextBy, NumberFormat, PropertyOptions, PropertyType, SelectOption, ViewConfig } from "@/db/schema/app";
import type { FormulaResultType } from "./formula/types";
import {
  groupedType,
  groupRows,
  groupRowsByPerson,
  isGroupableProperty,
  localDay,
  movePersonValue,
  orderGroups,
  sortStatusOptions,
  statusGroupOf,
  TEXT_GROUP_TYPES,
  type GroupPerson,
  type RowGroup,
} from "./properties";
import { holdsPeople, holdsTimestamp, isComputed, isDerived, STATUS_GROUPS, type StatusGroup } from "./property-types";
import { isErrorValue, rollupFormat } from "./derived";
import { formatInFormat, valueFormat, type NumberFormatOptions } from "./number-format";
import { dateDays, isDay, parseDateValue, shiftDateValue } from "./date-value";
import { dayNumber } from "./time-zone";

// The board-era helpers live in lib/properties; they are re-exported so grouping has one home.
export { boardGroupProperty, groupedType, groupRows, groupRowsByPerson, isGroupable, isGroupableProperty, movePersonValue, orderGroups } from "./properties";
export type { GroupPerson, RowGroup };

export const GROUP_DATE_BY = ["day", "week", "month", "quarter", "year"] as const satisfies readonly GroupDateBy[];
export const DEFAULT_GROUP_DATE_BY: GroupDateBy = "month";
export const GROUP_TEXT_BY = ["value", "letter"] as const satisfies readonly GroupTextBy[];
/** Ranges a number grouping makes at most when it works out their size itself. */
const AUTO_NUMBER_GROUPS = 10;
/** The group of texts that don't start with a letter (digits, symbols) when grouping by first letter. */
export const OTHER_LETTER = "#";

export type GroupedProperty = { id: string; type: PropertyType; options: PropertyOptions };
/** What naming a property's groups needs of it (published pages send no more). */
export type GroupLabelProperty = {
  type: PropertyType;
  options: Pick<PropertyOptions, "number" | "rollup"> & { formula?: { type?: FormulaResultType } };
};
export type GroupRelationRow = { id: string; title: string; icon: string | null };

/** What a group stands for; the UI labels groups from this. */
export type GroupValue =
  | { kind: "none" }
  | { kind: "option"; option: SelectOption }
  | { kind: "status_group"; group: StatusGroup }
  | { kind: "person"; person: GroupPerson }
  | { kind: "checkbox"; checked: boolean }
  /** `start` and `end` are the bucket's first and last day (`YYYY-MM-DD`). */
  | { kind: "date"; by: GroupDateBy; start: string; end: string }
  | { kind: "relation"; row: GroupRelationRow }
  /** Text, url, email and phone values (and text formulas and rollups) as they are. */
  | { kind: "text"; text: string }
  /** Texts by their first letter (upper case), or OTHER_LETTER for anything else. */
  | { kind: "letter"; letter: string }
  /** Numbers from `start` up to, not including, `end`. */
  | { kind: "number"; start: number; end: number };

/**
 * A group of rows. `key` is stable for as long as the grouping settings stay the same (option,
 * person or related row id; `true` / `false` for checkboxes; the first day of a date bucket; a
 * status stage; "" for no value), so `groupOrder`, `hiddenGroups` and `collapsedGroups` can refer
 * to it. `option` is kept for board-era callers: the option, a person stand-in, else null.
 */
export type Group<T> = RowGroup<T> & { value: GroupValue };

export type GroupSettings = Pick<ViewConfig, "groupDateBy" | "groupStatusBy" | "groupTextBy" | "groupNumberBy">;

/** The view types that group their rows into sections when `groupBy` names a groupable property. */
export const SECTIONED_VIEWS = new Set(["table", "list", "gallery"]);

/**
 * A board's sub-group property (ViewConfig subGroupBy): groupable, still there and not the
 * property the columns stand for; null otherwise.
 */
export function subGroupProperty<P extends { id: string; type: PropertyType; options: PropertyOptions }>(
  properties: P[],
  config: Pick<ViewConfig, "subGroupBy">,
  columns: { id: string } | undefined,
): P | null {
  const id = config.subGroupBy;
  if (!id || id === columns?.id) return null;
  return properties.find((p) => p.id === id && isGroupableProperty(p)) ?? null;
}

export type GroupContext = {
  /** People person-like properties can hold (see groupRowsByPerson). */
  people?: GroupPerson[];
  /** Rows of the related database the viewer can see, in its order: relation groups and titles. */
  relationRows?: GroupRelationRow[];
  /** The calendar day of a created or last edited time; the local day when left out. */
  dayOf?: (value: unknown) => string | null;
};

const NONE: GroupValue = { kind: "none" };

function parseDay(day: string) {
  const d = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The day a date value groups under: its start, a time on its day where `timestampDay` puts it
 * (the viewer's), or null for anything that isn't a date.
 */
function dateDay(value: unknown, timestampDay: (value: unknown) => string | null) {
  const parts = parseDateValue(value);
  if (!parts) return null;
  return parts.time ? timestampDay(parts.start) : parts.start;
}

/** The first and last day of the bucket `day` falls in. Weeks run Monday to Sunday. */
export function dateBucket(day: string, by: GroupDateBy): { start: string; end: string } {
  const d = parseDay(day);
  if (!d) return { start: day, end: day };
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  switch (by) {
    case "day":
      return { start: day, end: day };
    case "week": {
      const start = new Date(Date.UTC(y, m, d.getUTCDate() - ((d.getUTCDay() + 6) % 7)));
      const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + 6));
      return { start: isoDay(start), end: isoDay(end) };
    }
    case "month":
      return { start: isoDay(new Date(Date.UTC(y, m, 1))), end: isoDay(new Date(Date.UTC(y, m + 1, 0))) };
    case "quarter": {
      const first = m - (m % 3);
      return { start: isoDay(new Date(Date.UTC(y, first, 1))), end: isoDay(new Date(Date.UTC(y, first + 3, 0))) };
    }
    case "year":
      return { start: `${String(y).padStart(4, "0")}-01-01`, end: `${String(y).padStart(4, "0")}-12-31` };
  }
}

export function groupDateByOf(settings: GroupSettings): GroupDateBy {
  return GROUP_DATE_BY.includes(settings.groupDateBy as GroupDateBy) ? settings.groupDateBy! : DEFAULT_GROUP_DATE_BY;
}

export function groupTextByOf(settings: GroupSettings): GroupTextBy {
  return settings.groupTextBy === "letter" ? "letter" : "value";
}

/** Whether `size` can be a number grouping's range size: a finite number above zero. */
export function isNumberGroupSize(size: unknown): size is number {
  return typeof size === "number" && Number.isFinite(size) && size > 0;
}

/** Rounds away what floating point adds (0.1 * 3 = 0.30000000000000004). */
const tidy = (n: number) => Number(n.toPrecision(12));

/**
 * A range size for `values` when the view sets none: 1, 2 or 5 times a power of ten, making at
 * most AUTO_NUMBER_GROUPS ranges between the smallest and largest value. Whole numbers get whole
 * ranges. 1 when there is nothing to go by.
 */
export function autoNumberGroupSize(values: number[]): number {
  if (!values.length) return 1;
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min || Math.abs(max) || 1;
  const raw = span / AUTO_NUMBER_GROUPS;
  const power = 10 ** Math.floor(Math.log10(raw));
  let size = [1, 2, 5, 10].map((m) => tidy(m * power)).find((s) => s >= raw) ?? tidy(10 * power);
  // Ranges start at multiples of the size, so the values can straddle one range more than their span.
  while (Math.floor(tidy(max / size)) - Math.floor(tidy(min / size)) + 1 > AUTO_NUMBER_GROUPS) size = nextNiceSize(size);
  return values.every(Number.isInteger) ? Math.max(1, Math.round(size)) : size;
}

/** The next of 1, 2, 5, 10, 20, 50… after `size`. */
function nextNiceSize(size: number) {
  const power = 10 ** Math.floor(Math.log10(size));
  const m = Math.round(size / power);
  return tidy((m === 1 ? 2 : m === 2 ? 5 : 10) * power);
}

/** The range `value` falls in for ranges of `size` (from zero, below it as well). */
export function numberRange(value: number, size: number): { start: number; end: number } {
  const start = tidy(Math.floor(tidy(value / size)) * size);
  return { start, end: tidy(start + size) };
}

/** The texts a value groups under: a text, a number as text, or each text of a list (a rollup listing values). */
function textsOf(value: unknown): string[] {
  if (typeof value === "string" || typeof value === "number") {
    const text = String(value).trim();
    return text ? [text] : [];
  }
  if (Array.isArray(value)) return [...new Set(value.flatMap((v) => (typeof v === "string" || typeof v === "number" ? textsOf(v) : [])))];
  return [];
}

/** A text's group when grouping by first letter: the letter in upper case, or OTHER_LETTER. */
export function firstLetter(text: string): string {
  const first = [...text][0] ?? "";
  return /\p{L}/u.test(first) ? first.toLocaleUpperCase() : OTHER_LETTER;
}

/**
 * The format a number group's ends show in: the property's number format; a rollup's own (a
 * percentage for shares, none for counts of days).
 */
export function groupNumberFormat(prop: GroupLabelProperty): NumberFormat | undefined {
  if (prop.type !== "rollup") return valueFormat(prop);
  const kind = rollupFormat(prop.options.rollup?.function);
  if (kind === "percent") return { format: "percent" };
  return kind === "number" ? (prop.options.rollup?.number ?? valueFormat(prop)) : undefined;
}

/**
 * A number group's name, its ends in the property's format: "₺1,000 – ₺2,000". `number` formats
 * with Intl in the reader's locale.
 */
export function numberGroupName(
  value: Extract<GroupValue, { kind: "number" }>,
  prop: GroupLabelProperty,
  number: (value: number, options: NumberFormatOptions) => string,
): string {
  const format = groupNumberFormat(prop);
  return `${formatInFormat(value.start, format, number)} – ${formatInFormat(value.end, format, number)}`;
}

const textCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Status properties group by stage only when the view asks for it. */
export function groupsByStatusStage(prop: { type: PropertyType }, settings: GroupSettings) {
  return prop.type === "status" && settings.groupStatusBy === "group";
}

const ids = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

/**
 * Buckets rows by any groupable property. The no-value group comes first (checkboxes have none:
 * an unset checkbox is unchecked), then:
 * - select, status: one group per option in option order (status options by stage); with
 *   `groupStatusBy: "group"` one group per stage instead;
 * - multi_select: one group per option; a row shows in the group of each of its options;
 * - person, created_by, last_edited_by: one group per person (see groupRowsByPerson);
 * - checkbox: unchecked, then checked;
 * - date, created_time, last_edited_time: one group per day, week (from Monday), month, quarter or year
 *   that has rows, oldest first; timestamps count by `context.dayOf`;
 * - relation: one group per related row linked from any row, in the related database's order; a
 *   row shows under each row it links to. Links to rows the viewer can't see count as no value;
 * - text, url, email, phone: one group per value (trimmed), or with `groupTextBy: "letter"` per
 *   first letter, in alphabetical order (OTHER_LETTER first); a rollup listing values puts a row
 *   under each of them;
 * - number: ranges of `groupNumberBy` (from zero; worked out from the values when unset) that have
 *   rows, smallest first;
 * - formula, rollup: as their result type (text, number, date or checkbox); errors count as no value.
 * Row order within each group is kept.
 */
export function groupRowsBy<T extends { properties: Record<string, unknown> }>(
  rows: T[],
  prop: GroupedProperty,
  settings: GroupSettings = {},
  context: GroupContext = {},
): Group<T>[] {
  const none = (): Group<T> => ({ key: "", option: null, value: NONE, rows: [] });
  if (isDerived(prop.type)) {
    // Errors are no value: a checkbox counts them unchecked, other types put them in the no-value group.
    const type = groupedType(prop);
    const cleared = rows.map((row) => (isErrorValue(row.properties[prop.id]) ? { row, values: { ...row.properties, [prop.id]: null } } : null));
    if (!cleared.some(Boolean)) return groupRowsBy(rows, { ...prop, type }, settings, context);
    const stand = rows.map((row, i) => (cleared[i] ? { ...row, properties: cleared[i]!.values } : row));
    const original = new Map(stand.map((s, i) => [s, rows[i]]));
    return groupRowsBy(stand, { ...prop, type }, settings, context).map((g) => ({ ...g, rows: g.rows.map((r) => original.get(r)!) }));
  }
  if (TEXT_GROUP_TYPES.has(prop.type)) {
    const letters = groupTextByOf(settings) === "letter";
    const byText = new Map<string, Group<T>>();
    const empty = none();
    for (const row of rows) {
      const keys = [...new Set(textsOf(row.properties[prop.id]).map((text) => (letters ? firstLetter(text) : text)))];
      if (!keys.length) empty.rows.push(row);
      for (const key of keys) {
        let group = byText.get(key);
        if (!group) {
          const value: GroupValue = letters ? { kind: "letter", letter: key } : { kind: "text", text: key };
          byText.set(key, (group = { key, option: null, value, rows: [] }));
        }
        group.rows.push(row);
      }
    }
    const rank = (g: Group<T>) => (letters && g.key === OTHER_LETTER ? 0 : 1);
    return [empty, ...[...byText.values()].sort((a, b) => rank(a) - rank(b) || textCollator.compare(a.key, b.key))];
  }
  if (prop.type === "number") {
    const numbers = rows.map((row) => {
      const value = row.properties[prop.id];
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    });
    const size = isNumberGroupSize(settings.groupNumberBy)
      ? settings.groupNumberBy
      : autoNumberGroupSize(numbers.filter((n): n is number => n !== null));
    const buckets = new Map<number, Group<T> & { value: { kind: "number" } }>();
    const empty = none();
    rows.forEach((row, i) => {
      const n = numbers[i];
      if (n === null) {
        empty.rows.push(row);
        return;
      }
      const { start, end } = numberRange(n, size);
      let bucket = buckets.get(start);
      if (!bucket) buckets.set(start, (bucket = { key: String(start), option: null, value: { kind: "number", start, end }, rows: [] }));
      bucket.rows.push(row);
    });
    return [empty, ...[...buckets.values()].sort((a, b) => a.value.start - b.value.start)];
  }
  if (prop.type === "select" || (prop.type === "status" && !groupsByStatusStage(prop, settings))) {
    return groupRows(rows, prop).map((g) => ({ ...g, value: g.option ? { kind: "option", option: g.option } : NONE }));
  }
  if (holdsPeople(prop.type)) {
    return groupRowsByPerson(rows, prop, context.people ?? []).map((g) => ({
      ...g,
      value: g.person ? { kind: "person", person: g.person } : NONE,
    }));
  }
  if (prop.type === "status") {
    const stageOf = new Map(sortStatusOptions(prop.options.options ?? []).map((o) => [o.id, statusGroupOf(o)]));
    const stages = STATUS_GROUPS.map((group): Group<T> => ({ key: group, option: null, value: { kind: "status_group", group }, rows: [] }));
    const empty = none();
    for (const row of rows) {
      const value = row.properties[prop.id];
      const stage = typeof value === "string" ? stageOf.get(value) : undefined;
      (stage ? stages[STATUS_GROUPS.indexOf(stage)] : empty).rows.push(row);
    }
    return [empty, ...stages];
  }
  if (prop.type === "multi_select") {
    const options = prop.options.options ?? [];
    const groups = options.map((option): Group<T> => ({ key: option.id, option, value: { kind: "option", option }, rows: [] }));
    const index = new Map(options.map((o, i) => [o.id, i]));
    const empty = none();
    for (const row of rows) {
      const hits = [...new Set(ids(row.properties[prop.id]).flatMap((id) => (index.has(id) ? [index.get(id)!] : [])))];
      if (!hits.length) empty.rows.push(row);
      for (const i of hits) groups[i].rows.push(row);
    }
    return [empty, ...groups];
  }
  if (prop.type === "checkbox") {
    const group = (checked: boolean): Group<T> => ({ key: String(checked), option: null, value: { kind: "checkbox", checked }, rows: [] });
    const unchecked = group(false);
    const checked = group(true);
    for (const row of rows) (row.properties[prop.id] === true ? checked : unchecked).rows.push(row);
    return [unchecked, checked];
  }
  if (prop.type === "date" || holdsTimestamp(prop.type)) {
    const by = groupDateByOf(settings);
    const timestampDay = context.dayOf ?? localDay;
    const dayOf = prop.type === "date" ? (value: unknown) => dateDay(value, timestampDay) : timestampDay;
    const buckets = new Map<string, Group<T>>();
    const empty = none();
    for (const row of rows) {
      const day = dayOf(row.properties[prop.id]);
      if (!day) {
        empty.rows.push(row);
        continue;
      }
      const { start, end } = dateBucket(day, by);
      let bucket = buckets.get(start);
      if (!bucket) buckets.set(start, (bucket = { key: start, option: null, value: { kind: "date", by, start, end }, rows: [] }));
      bucket.rows.push(row);
    }
    return [empty, ...[...buckets.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))];
  }
  if (prop.type === "relation") {
    const targets = context.relationRows ?? [];
    const groups = targets.map((row): Group<T> => ({ key: row.id, option: null, value: { kind: "relation", row }, rows: [] }));
    const index = new Map(targets.map((r, i) => [r.id, i]));
    const empty = none();
    for (const row of rows) {
      const hits = [...new Set(ids(row.properties[prop.id]).flatMap((id) => (index.has(id) ? [index.get(id)!] : [])))];
      if (!hits.length) empty.rows.push(row);
      for (const i of hits) groups[i].rows.push(row);
    }
    return [empty, ...groups.filter((g) => g.rows.length)];
  }
  // Not groupable: everything is "no value".
  return [{ ...none(), rows: [...rows] }];
}

/**
 * The view's groups in its saved order, split into the ones it shows and the ones the user hid.
 * The no-value group only shows while it has rows; with `hideEmptyGroups` no empty group does.
 */
export function arrangeGroups<G extends Group<unknown>>(
  groups: G[],
  config: Pick<ViewConfig, "groupOrder" | "hiddenGroups" | "hideEmptyGroups">,
): { ordered: G[]; shown: G[]; hidden: G[] } {
  const ordered = orderGroups(groups, config.groupOrder);
  const hiddenKeys = new Set(config.hiddenGroups ?? []);
  const present = (g: G) => g.rows.length > 0 || g.value.kind !== "none";
  const shown = ordered.filter((g) => !hiddenKeys.has(g.key) && present(g) && (g.rows.length > 0 || !config.hideEmptyGroups));
  const hidden = ordered.filter((g) => hiddenKeys.has(g.key) && present(g));
  return { ordered, shown, hidden };
}

/**
 * What `moveRow` takes as `groupValue` to put a row into `group`: an option, person or related row
 * id, `true` / `false`, the bucket's first day, null for no value. Undefined when rows can't be
 * moved there: who created or edited a row, and when, never change, and a status stage without
 * options has nothing to set.
 */
export function groupTarget(prop: GroupedProperty, group: Pick<Group<unknown>, "value">): string | null | undefined {
  if (isComputed(prop.type) || isDerived(prop.type)) return undefined;
  const value = group.value;
  switch (value.kind) {
    case "none":
      return null;
    case "option":
      return value.option.id;
    case "status_group":
      // A card dropped on a stage takes the stage's first option.
      return sortStatusOptions(prop.options.options ?? []).find((o) => statusGroupOf(o) === value.group)?.id;
    case "person":
      return value.person.id;
    case "checkbox":
      return String(value.checked);
    case "date":
      return value.start;
    case "relation":
      return value.row.id;
    case "text":
      return value.text;
    case "letter":
    case "number":
      // A letter or a range stands for many values: none of them is the one to give.
      return undefined;
  }
}

/**
 * A row's grouping value after dragging it from group `from` to group `to` (group targets, see
 * groupTarget). Lists (multi-select, people, relations) swap `from` for `to` and keep the rest,
 * like movePersonValue; moving to no value clears them. Checkboxes take `to === "true"`, other
 * types `to` itself. An empty list or null means cleared.
 */
export function moveGroupValue(
  prop: GroupedProperty,
  current: unknown,
  from: string | null | undefined,
  to: string | null | undefined,
): unknown {
  if (prop.type === "checkbox") return to === "true";
  if (prop.type === "multi_select") {
    // Ids of deleted options would fail validation; they don't show anyway.
    const known = new Set((prop.options.options ?? []).map((o) => o.id));
    return movePersonValue(ids(current).filter((id) => known.has(id)), from, to);
  }
  if (prop.type === "relation" || holdsPeople(prop.type)) return movePersonValue(current, from, to);
  // A date moves to the bucket's first day as a whole: a range keeps its length, a time its time.
  if (prop.type === "date" && to && isDay(to)) {
    const days = dateDays(current);
    if (days) return shiftDateValue(current, dayNumber(to) - days.start);
  }
  return to ?? null;
}

/**
 * Whether a row created inside `group` would show there. Rows can't be given who created them or
 * when: new rows are the viewer's (`viewerId`) and made today (`today`, the viewer's local day).
 * A status stage without options has no value to give.
 */
export function canAddToGroup(
  prop: GroupedProperty,
  group: Pick<Group<unknown>, "key" | "value">,
  { viewerId, today }: { viewerId?: string | null; today?: string | null } = {},
) {
  // A formula or rollup is worked out: a new row has no result yet.
  if (isDerived(prop.type)) return group.value.kind === "none";
  if (!isComputed(prop.type)) return groupTarget(prop, group) !== undefined;
  const value = group.value;
  if (holdsTimestamp(prop.type)) return value.kind === "date" && !!today && value.start <= today && today <= value.end;
  return value.kind === "person" && group.key === viewerId;
}

/** Values for a row created inside `group`, so that it shows there; empty when there is nothing to set. */
export function groupDefaults(prop: GroupedProperty, group: Pick<Group<unknown>, "value">): Record<string, unknown> {
  const target = groupTarget(prop, group);
  if (target === undefined || target === null) return {};
  return { [prop.id]: moveGroupValue(prop, undefined, null, target) };
}

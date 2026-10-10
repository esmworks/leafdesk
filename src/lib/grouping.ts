import type { GroupDateBy, PropertyOptions, PropertyType, SelectOption, ViewConfig } from "@/db/schema/app";
import {
  groupRows,
  groupRowsByPerson,
  localDay,
  movePersonValue,
  orderGroups,
  sortStatusOptions,
  statusGroupOf,
  type GroupPerson,
  type RowGroup,
} from "./properties";
import { holdsPeople, holdsTimestamp, isComputed, STATUS_GROUPS, type StatusGroup } from "./property-types";
import { dateDays, isDay, parseDateValue, shiftDateValue } from "./date-value";
import { dayNumber } from "./time-zone";

// The board-era helpers live in lib/properties; they are re-exported so grouping has one home.
export { boardGroupProperty, groupRows, groupRowsByPerson, isGroupable, movePersonValue, orderGroups } from "./properties";
export type { GroupPerson, RowGroup };

export const GROUP_DATE_BY = ["day", "week", "month", "year"] as const satisfies readonly GroupDateBy[];
export const DEFAULT_GROUP_DATE_BY: GroupDateBy = "month";

export type GroupedProperty = { id: string; type: PropertyType; options: PropertyOptions };
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
  | { kind: "relation"; row: GroupRelationRow };

/**
 * A group of rows. `key` is stable for as long as the grouping settings stay the same (option,
 * person or related row id; `true` / `false` for checkboxes; the first day of a date bucket; a
 * status stage; "" for no value), so `groupOrder`, `hiddenGroups` and `collapsedGroups` can refer
 * to it. `option` is kept for board-era callers: the option, a person stand-in, else null.
 */
export type Group<T> = RowGroup<T> & { value: GroupValue };

export type GroupSettings = Pick<ViewConfig, "groupDateBy" | "groupStatusBy">;

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
    case "year":
      return { start: `${String(y).padStart(4, "0")}-01-01`, end: `${String(y).padStart(4, "0")}-12-31` };
  }
}

export function groupDateByOf(settings: GroupSettings): GroupDateBy {
  return GROUP_DATE_BY.includes(settings.groupDateBy as GroupDateBy) ? settings.groupDateBy! : DEFAULT_GROUP_DATE_BY;
}

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
 * - date, created_time, last_edited_time: one group per day, week (from Monday), month or year
 *   that has rows, oldest first; timestamps count by `context.dayOf`;
 * - relation: one group per related row linked from any row, in the related database's order; a
 *   row shows under each row it links to. Links to rows the viewer can't see count as no value.
 * Row order within each group is kept.
 */
export function groupRowsBy<T extends { properties: Record<string, unknown> }>(
  rows: T[],
  prop: GroupedProperty,
  settings: GroupSettings = {},
  context: GroupContext = {},
): Group<T>[] {
  const none = (): Group<T> => ({ key: "", option: null, value: NONE, rows: [] });
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
  if (isComputed(prop.type)) return undefined;
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
  if (!isComputed(prop.type)) return group.value.kind !== "status_group" || groupTarget(prop, group) !== undefined;
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

/**
 * A database's history: who added, changed, deleted or restored its properties and its shared
 * views, and who put rows in the trash or took them out, each change from what to what, newest
 * first and each one undoable. Row values have their own record (lib/row-activity), which the
 * history reads in groups. Pure and client-safe: server/database-history.ts records and lists the
 * entries and undoes them.
 */

import type { PropertyOptions, SelectOption, ViewConfig, ViewType } from "@/db/schema";
import type { DateOptionsInput } from "./date-options";
import type { PropertyType } from "./property-types";
import type { RelationOptionsInput } from "./relation-options";
import type { RowActivityActor } from "./row-activity";

export const DATABASE_CHANGE_KINDS = [
  "property_added",
  "property_changed",
  "property_deleted",
  "property_restored",
  "view_added",
  "view_changed",
  "view_deleted",
  "view_restored",
  "rows_trashed",
  "rows_restored",
] as const;
export type DatabaseChangeKind = (typeof DATABASE_CHANGE_KINDS)[number];

export const isPropertyKind = (kind: DatabaseChangeKind) => kind.startsWith("property_");
export const isViewKind = (kind: DatabaseChangeKind) => kind.startsWith("view_");

/** A property as the history keeps it: what people set, never what is worked out when it is read. */
export type PropertySnapshot = { name: string; type: PropertyType; options: PropertyOptions };
/** A shared view as the history keeps it. */
export type ViewSnapshot = { name: string; type: ViewType; config: ViewConfig; published: boolean };
/** The rows a `rows_*` entry is about, by their titles then. */
export type RowsSnapshot = { rows: { id: string; title: string }[] };

/**
 * Row values a property change rewrote (a type change converting them, options taken away
 * clearing them), by row: [before, after]. Kept so that undoing the change puts them back where
 * the row still holds what the change left. A change rewriting more rows than this keeps none.
 */
export type ChangedValues = Record<string, [unknown, unknown]>;
export const MAX_KEPT_VALUES = 5000;

/**
 * Changes by the same actor to the same property or view this close together are one entry:
 * renaming saves as people type, and a new property is usually set up right after it is added.
 */
export const CHANGE_WINDOW_MS = 5 * 60_000;

/** The most entries one read returns. */
export const MAX_HISTORY_PAGE = 50;

/** Settings worked out whenever properties are read, or that say only where a property sits. */
export function propertySnapshot(p: { name: string; type: PropertyType; options: PropertyOptions }): PropertySnapshot {
  const { pinned: _pinned, formula, rollup, ...options } = p.options;
  const kept: PropertyOptions = { ...options };
  if (formula) kept.formula = { expression: formula.expression };
  if (rollup) {
    const { number: _number, ...rest } = rollup as typeof rollup & Record<string, unknown>;
    const stored: Record<string, unknown> = {};
    for (const key of ["relationPropertyId", "targetPropertyId", "function", "display"] as const) {
      if (rest[key] !== undefined) stored[key] = rest[key];
    }
    kept.rollup = stored as typeof rollup;
  }
  return { name: p.name, type: p.type, options: kept };
}

/**
 * How a view looks to everyone. Column widths and groups folded open or shut change as people
 * look around; they are left out, and a change of nothing else isn't recorded.
 */
export const UNRECORDED_VIEW_KEYS = ["columnWidths", "collapsedGroups", "collapsedSubGroups"] as const;

export function viewSnapshot(v: { name: string; type: ViewType; config: ViewConfig; published: boolean }): ViewSnapshot {
  const config: Record<string, unknown> = { ...v.config };
  for (const key of UNRECORDED_VIEW_KEYS) delete config[key];
  return { name: v.name, type: v.type, config: config as ViewConfig, published: v.published };
}

const json = (value: unknown) => JSON.stringify(value ?? null);

/** Whether two snapshots are the same, keys in any order. */
export function sameSnapshot(a: unknown, b: unknown): boolean {
  return json(sorted(a)) === json(sorted(b));
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => [k, sorted((value as Record<string, unknown>)[k])]),
  );
}

// ------------------------------------------------------------------------------- what changed

type Option = { id: string; name: string; color: string };

/**
 * One line of what a property change did, for the history to word in the viewer's language.
 * `setting` names a setting that changed without its values (the number format, the date's
 * reminder…), which the line names only.
 */
export type PropertyField =
  | { field: "name"; from: string; to: string }
  | { field: "type"; from: PropertyType; to: PropertyType }
  | { field: "options"; added: Option[]; removed: Option[]; renamed: { from: string; to: Option }[]; recolored: Option[] }
  | { field: "formula"; from: string | null; to: string | null }
  | { field: "description"; from: string | null; to: string | null }
  | { field: "setting"; setting: PropertySetting };

/** Property settings the history names when they change. */
export const PROPERTY_SETTINGS = [
  "icon",
  "number",
  "numberDisplay",
  "date",
  "unique",
  "prefix",
  "urlPreview",
  "onePerson",
  "oneRow",
  "statusDisplay",
  "pageVisibility",
  "dependsOn",
  "relation",
  "rollup",
  "ai",
  "other",
] as const;
export type PropertySetting = (typeof PROPERTY_SETTINGS)[number];

const SETTING_OF: Partial<Record<keyof PropertyOptions, PropertySetting>> = {
  icon: "icon",
  number: "number",
  numberDisplay: "numberDisplay",
  date: "date",
  unique: "unique",
  uniqueId: "prefix",
  url: "urlPreview",
  person: "onePerson",
  statusDisplay: "statusDisplay",
  pageVisibility: "pageVisibility",
  dependsOn: "dependsOn",
  rollup: "rollup",
  ai: "ai",
};

function optionList(options: PropertyOptions | undefined): Option[] {
  return (options?.options ?? []).map((o) => ({ id: o.id, name: o.name, color: o.color }));
}

/** What changed between two snapshots of a property, in a fixed order. */
export function propertyFields(before: PropertySnapshot, after: PropertySnapshot): PropertyField[] {
  const fields: PropertyField[] = [];
  if (before.name !== after.name) fields.push({ field: "name", from: before.name, to: after.name });
  if (before.type !== after.type) fields.push({ field: "type", from: before.type, to: after.type });
  const [was, now] = [optionList(before.options), optionList(after.options)];
  if (json(was) !== json(now)) {
    const wasById = new Map(was.map((o) => [o.id, o]));
    const nowIds = new Set(now.map((o) => o.id));
    const added = now.filter((o) => !wasById.has(o.id));
    const removed = was.filter((o) => !nowIds.has(o.id));
    const renamed = now.flatMap((o) => {
      const old = wasById.get(o.id);
      return old && old.name !== o.name ? [{ from: old.name, to: o }] : [];
    });
    const recolored = now.filter((o) => {
      const old = wasById.get(o.id);
      return old && old.name === o.name && old.color !== o.color;
    });
    // Options moved about or given another group: still a change of the options.
    fields.push({ field: "options", added, removed, renamed, recolored });
  }
  const formula = (s: PropertySnapshot) => s.options.formula?.expression ?? null;
  if (formula(before) !== formula(after)) fields.push({ field: "formula", from: formula(before), to: formula(after) });
  const description = (s: PropertySnapshot) => s.options.description ?? null;
  if (description(before) !== description(after)) fields.push({ field: "description", from: description(before), to: description(after) });
  const settings = new Set<PropertySetting>();
  const keys = new Set([...Object.keys(before.options), ...Object.keys(after.options)]) as Set<keyof PropertyOptions>;
  for (const key of keys) {
    if (key === "options" || key === "formula" || key === "description") continue;
    const [a, b] = [before.options[key], after.options[key]];
    if (sameSnapshot(a, b)) continue;
    if (key === "relation") {
      const relation = (s: unknown) => (s ?? {}) as { single?: true; display?: unknown; show?: unknown };
      if (relation(a).single !== relation(b).single) settings.add("oneRow");
      const { single: _a, ...restA } = relation(a);
      const { single: _b, ...restB } = relation(b);
      if (!sameSnapshot(restA, restB)) settings.add("relation");
      continue;
    }
    settings.add(SETTING_OF[key] ?? "other");
  }
  for (const setting of PROPERTY_SETTINGS) if (settings.has(setting)) fields.push({ field: "setting", setting });
  return fields;
}

/** Parts of a view's settings the history names when they change. */
export const VIEW_PARTS = [
  "name",
  "layout",
  "filters",
  "sorts",
  "groups",
  "properties",
  "colors",
  "calculations",
  "form",
  "widgets",
  "published",
  "other",
] as const;
export type ViewPart = (typeof VIEW_PARTS)[number];

const PART_OF: Partial<Record<keyof ViewConfig, ViewPart>> = {
  filters: "filters",
  filterCombinator: "filters",
  sorts: "sorts",
  groupBy: "groups",
  subGroupBy: "groups",
  groupDateBy: "groups",
  groupStatusBy: "groups",
  groupTextBy: "groups",
  groupNumberBy: "groups",
  groupOrder: "groups",
  hiddenGroups: "groups",
  hideEmptyGroups: "groups",
  hidden: "properties",
  shown: "properties",
  propertyOrder: "properties",
  wrapped: "properties",
  frozenThrough: "properties",
  columnAlign: "properties",
  colorRules: "colors",
  colorColumns: "colors",
  calculations: "calculations",
  showTotals: "calculations",
  form: "form",
  widgets: "widgets",
};

/** Which parts of a view changed between two snapshots, in a fixed order. */
export function viewParts(before: ViewSnapshot, after: ViewSnapshot): ViewPart[] {
  const parts = new Set<ViewPart>();
  if (before.name !== after.name) parts.add("name");
  if (before.type !== after.type) parts.add("layout");
  if (before.published !== after.published) parts.add("published");
  const keys = new Set([...Object.keys(before.config), ...Object.keys(after.config)]) as Set<keyof ViewConfig>;
  for (const key of keys) {
    if (sameSnapshot(before.config[key], after.config[key])) continue;
    parts.add(PART_OF[key] ?? "other");
  }
  return VIEW_PARTS.filter((p) => parts.has(p));
}

// ---------------------------------------------------------------------------------- merging

/** The newest entry about the same property or view, as far as merging goes. */
export type OpenChange = { id: string; kind: DatabaseChangeKind; actorUserId: string | null; actorKind: RowActivityActor; before: unknown; at: Date };

export type MergeDecision = { action: "insert" } | { action: "update"; id: string } | { action: "drop"; id: string };

/**
 * Whether a change of a property or view starts a new entry or merges into `latest`, the newest
 * entry about it: a change merges into a change or an addition by the same named actor within the
 * window. The merged entry keeps its kind and its first `before`, and takes the new `after`; a
 * change that brings things back to that `before` drops it.
 */
export function mergeChange(
  latest: OpenChange | null,
  change: { kind: DatabaseChangeKind; actorUserId: string | null; actorKind: RowActivityActor; after: unknown },
  now: Date,
  windowMs = CHANGE_WINDOW_MS,
): MergeDecision {
  if (
    !latest ||
    (change.kind !== "property_changed" && change.kind !== "view_changed") ||
    !(latest.kind === change.kind || latest.kind === (change.kind === "property_changed" ? "property_added" : "view_added")) ||
    !change.actorUserId ||
    latest.actorUserId !== change.actorUserId ||
    latest.actorKind !== change.actorKind ||
    now.getTime() - latest.at.getTime() > windowMs
  ) {
    return { action: "insert" };
  }
  // An addition stays one, whatever it was set up as afterwards.
  if (latest.kind !== change.kind) return { action: "update", id: latest.id };
  return sameSnapshot(latest.before, change.after) ? { action: "drop", id: latest.id } : { action: "update", id: latest.id };
}

/** Row values a merged entry keeps: each row's first `before` and newest `after`; rows back where they were go. */
export function mergeValues(older: ChangedValues | null, newer: ChangedValues | null): ChangedValues | null {
  if (!older && !newer) return null;
  const merged: ChangedValues = { ...(older ?? {}) };
  for (const [rowId, [before, after]] of Object.entries(newer ?? {})) {
    const first = merged[rowId]?.[0] ?? before;
    if (json(first) === json(after)) delete merged[rowId];
    else merged[rowId] = [first, after];
  }
  return Object.keys(merged).length > MAX_KEPT_VALUES ? null : merged;
}

// -------------------------------------------------------------------------------- undoing

/** A property change's settings, as updateProperty (server/databases.ts) takes them. */
export type PropertyPatch = {
  name?: string;
  options?: SelectOption[];
  formula?: { expression: string };
  rollup?: { relationPropertyId: string; targetPropertyId: string; function: string; display?: string };
  number?: PropertyOptions["number"] | null;
  date?: DateOptionsInput;
  pageVisibility?: "show" | "hide_empty" | "hide";
  numberDisplay?: PropertyOptions["numberDisplay"] | null;
  description?: string | null;
  dependsOn?: string | null;
  prefix?: string | null;
  urlPreview?: boolean;
  icon?: string | null;
  relation?: RelationOptionsInput;
  onePerson?: boolean;
  oneRow?: boolean;
  statusDisplay?: "checkbox" | "option";
  unique?: boolean;
};

/**
 * What to write to bring a property from `current` back to `target`, its settings before a change:
 * the settings that differ, as updateProperty takes them, so every check of a change applies to
 * an undo too. `type` when the type differs (changed first, by changePropertyType). `kept` lists
 * the settings an undo can't bring back (an AI autofill's setup), which stay as they are.
 */
export function restorePatch(current: PropertySnapshot, target: PropertySnapshot): { type?: PropertyType; patch: PropertyPatch; kept: PropertySetting[] } {
  const patch: PropertyPatch = {};
  const kept: PropertySetting[] = [];
  const [now, then] = [current.options, target.options];
  const differs = (key: keyof PropertyOptions) => !sameSnapshot(now[key], then[key]);
  if (current.name !== target.name) patch.name = target.name;
  if (differs("options") && then.options) patch.options = then.options;
  if (differs("formula") && then.formula) patch.formula = { expression: then.formula.expression };
  if (differs("rollup") && then.rollup) {
    const r = then.rollup;
    patch.rollup = { relationPropertyId: r.relationPropertyId, targetPropertyId: r.targetPropertyId, function: r.function, ...(r.display ? { display: r.display } : {}) };
  }
  if (differs("number")) patch.number = then.number ?? null;
  if (differs("numberDisplay")) patch.numberDisplay = then.numberDisplay ?? null;
  if (differs("date")) {
    const d = then.date;
    patch.date = {
      display: d?.display ?? "date",
      format: d?.format ?? "default",
      clock: d?.clock ?? "default",
      reminderDays: d?.reminder ? d.reminder.daysBefore : null,
      ...(d?.reminder?.timeZone ? { timeZone: d.reminder.timeZone } : {}),
    };
  }
  if (differs("pageVisibility")) patch.pageVisibility = then.pageVisibility ?? "show";
  if (differs("description")) patch.description = then.description ?? null;
  if (differs("dependsOn")) patch.dependsOn = then.dependsOn ?? null;
  if (differs("uniqueId")) patch.prefix = then.uniqueId?.prefix ?? null;
  if (differs("url")) patch.urlPreview = !!then.url?.preview;
  if (differs("icon")) patch.icon = then.icon ?? null;
  if (differs("person")) patch.onePerson = !!then.person?.single;
  if (differs("statusDisplay")) patch.statusDisplay = then.statusDisplay ?? "option";
  if (differs("unique")) patch.unique = !!then.unique;
  if (differs("relation") && now.relation && then.relation) {
    if (!!now.relation.single !== !!then.relation.single) patch.oneRow = !!then.relation.single;
    const { show, display } = then.relation;
    if (!sameSnapshot(now.relation.show, show) || now.relation.display !== display) {
      patch.relation = { display: display ?? null, show: show ?? null };
    }
  }
  if (differs("ai")) kept.push("ai");
  return { ...(current.type !== target.type ? { type: target.type } : {}), patch, kept };
}

/** Who made a change, as the history shows it; see lib/row-activity ActivityPerson. */
export type HistoryActor = { kind: RowActivityActor; person: { id: string; name: string; image: string | null; isAgent?: true; agentIcon?: string | null } | null };

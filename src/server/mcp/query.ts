import type {
  FilterCombinator,
  FilterEntry,
  FilterOp,
  FilterRule,
  PropertyOptions,
  PropertyType,
  SortRule,
  ViewConfig,
  ViewType,
} from "@/db/schema/app";
import type { AggregateResult } from "@/lib/aggregate";
import { AUTOFILL_BODY, AUTOFILL_TITLE, type AiAutofillConfig } from "@/lib/ai";
import { canStack, chartAccumulateOf, chartData, chartGroupProperty, chartMeasure, chartSortOf, chartTypeOf, OTHER_KEY } from "@/lib/chart";
import {
  isDayCount,
  isFilterGroup,
  isRelativeDateRange,
  MAX_FILTER_DEPTH,
  MAX_FILTER_RULES,
  MAX_RELATIVE_DAYS,
  RELATIVE_DATE_RANGES,
  rangeNeedsDays,
} from "@/lib/filters";
import { asFiles } from "@/lib/files";
import { formDefaults, formQuestions, isPublicAskable } from "@/lib/forms";
import { groupDateByOf, type GroupContext, type GroupValue } from "@/lib/grouping";
import { pageLabel } from "@/lib/labels";
import {
  CREATED_KEY,
  displayValue,
  isGroupable,
  isSortable,
  PropertyValueError,
  sortStatusOptions,
  TITLE_KEY,
  UPDATED_KEY,
} from "@/lib/properties";
import { derivedType, formulaForEditing, rollupFormat, TITLE_FIELD, valueType } from "@/lib/derived";
import { formulaReferences, type PropertyLevel } from "@/lib/property-access";
import { holdsOptions, holdsPeople, holdsTimestamp, isDerived, isReadOnlyType, PERSON_ME, STATUS_GROUPS } from "@/lib/property-types";

export type PropertyDef = { id: string; name: string; type: PropertyType; options: PropertyOptions };

/** Related database and its live rows per relation property id (see databases.getRelationTargets). */
export type RelationTargets = Record<
  string,
  {
    database: { id: string; title: string } | null;
    pairedName?: string | null;
    rows: { id: string; title: string }[];
    /** The related database's properties (rollups name the one they read). */
    properties?: PropertyDef[];
  }
>;

/** People person properties can show and hold (see databases.getPeople). */
export type PersonLookup = { id: string; name: string; email: string | null; active?: boolean };

/** Everything needed to show linked rows and people by name (see databases.getLookups). */
export type Lookups = { relations: RelationTargets; people: PersonLookup[] };

const NO_LOOKUPS: Lookups = { relations: {}, people: [] };

/** A related row by id or (case-insensitive, unique) title. */
function relatedRowId(prop: PropertyDef, targets: RelationTargets, value: unknown): string {
  const rows = targets[prop.id]?.rows ?? [];
  const raw = String(value ?? "").trim();
  const byId = rows.find((r) => r.id === raw);
  if (byId) return byId.id;
  const matches = rows.filter((r) => r.title.trim().toLowerCase() === raw.toLowerCase());
  if (matches.length === 1) return matches[0].id;
  throw new PropertyValueError(
    matches.length
      ? `"${raw}" matches ${matches.length} rows related to "${prop.name}"; use a row id`
      : `"${raw}" is not a row of the database related to "${prop.name}"`,
  );
}

/**
 * A person filter value: "me" stays "me" (it means whoever looks at the view), anything else is a
 * user id, email or (unique, case-insensitive) name of someone the caller can see.
 */
function personId(prop: PropertyDef, people: PersonLookup[], value: unknown): string {
  const raw = String(value ?? "").trim();
  if (raw.toLowerCase() === PERSON_ME) return PERSON_ME;
  const needle = raw.toLowerCase();
  const found =
    people.find((p) => p.id === raw) ??
    people.find((p) => p.email?.toLowerCase() === needle) ??
    (() => {
      const byName = people.filter((p) => p.name.trim().toLowerCase() === needle);
      if (byName.length > 1) {
        throw new PropertyValueError(`"${raw}" matches ${byName.length} people for "${prop.name}"; use an email or user id`);
      }
      return byName[0];
    })();
  if (!found) throw new PropertyValueError(`"${raw}" is not a person in this workspace (filter on "${prop.name}")`);
  return found.id;
}

export { FILTER_OPS } from "@/lib/filters";

const SPECIAL_KEYS: Record<string, string> = {
  title: TITLE_KEY,
  created_at: CREATED_KEY,
  updated_at: UPDATED_KEY,
};

const VALUE_OPS = new Set<FilterOp>(["contains", "equals", "not_equals", "gt", "lt", "is_within"]);

/** Whether a property (or built-in key) holds dates or timestamps that relative date filters apply to. */
function holdsDates(key: string, prop: PropertyDef | undefined) {
  return prop ? valueType(prop) === "date" || holdsTimestamp(prop.type) : key === CREATED_KEY || key === UPDATED_KEY;
}

/** Timestamps and dates worked out by formulas: filtered by day, with a YYYY-MM-DD value. */
function filtersByDay(prop: PropertyDef) {
  return holdsTimestamp(prop.type) || (isDerived(prop.type) && derivedType(prop) === "date");
}

const PEOPLE_LABELS: Record<string, string> = { person: "Person", created_by: "Created by", last_edited_by: "Last edited by" };

function available(props: PropertyDef[]) {
  return ["title", "created_at", "updated_at", ...props.map((p) => `${p.name} (${p.type})`)].join(", ");
}

/** Resolves a property reference (id, case-insensitive name, or a special key) to its storage key. */
export function resolvePropertyKey(props: PropertyDef[], key: string): { key: string; prop?: PropertyDef } {
  const byId = props.find((p) => p.id === key);
  if (byId) return { key: byId.id, prop: byId };
  const needle = key.trim().toLowerCase();
  const byName = props.find((p) => p.name.trim().toLowerCase() === needle);
  if (byName) return { key: byName.id, prop: byName };
  const special = SPECIAL_KEYS[needle];
  if (special) return { key: special };
  throw new PropertyValueError(`Unknown property "${key}". Available: ${available(props)}`);
}

function optionId(prop: PropertyDef, value: unknown): string {
  const options = prop.options.options ?? [];
  const needle = String(value ?? "").trim().toLowerCase();
  const option = options.find((o) => o.id === value || o.name.trim().toLowerCase() === needle);
  if (!option) {
    throw new PropertyValueError(
      `"${String(value)}" is not an option of "${prop.name}". Options: ${options.map((o) => o.name).join(", ") || "none"}`,
    );
  }
  return option.id;
}

export type FilterInput = { property: string; op: FilterOp; value?: unknown; days?: number };
export type FilterGroupInput = { type: "group"; combinator?: FilterCombinator; rules: FilterEntryInput[] };
export type FilterEntryInput = FilterInput | FilterGroupInput;
export type SortInput = { property: string; direction?: "asc" | "desc" };

/** Converts an agent-facing filter (names, option names) to a stored FilterRule (ids). */
export function toFilterRule(props: PropertyDef[], input: FilterInput, lookups: Lookups = NO_LOOKUPS): FilterRule {
  const { key, prop } = resolvePropertyKey(props, input.property);
  if (input.days !== undefined && input.op !== "is_within") {
    throw new PropertyValueError(`"days" only applies to is_within filters (on "${input.property}")`);
  }
  if (!VALUE_OPS.has(input.op)) return { propertyId: key, op: input.op };
  if (input.value === undefined || input.value === null || input.value === "") {
    throw new PropertyValueError(`Filter "${input.op}" on "${input.property}" needs a value`);
  }
  if (input.op === "is_within") return relativeDateRule(key, prop, input);
  let value: unknown = input.value;
  // A formula filters like a property of its result type.
  const type = prop && valueType(prop);
  if (prop?.type === "checklist") {
    throw new PropertyValueError(`Checklist "${prop.name}" supports is_empty and is_not_empty`);
  } else if (prop?.type === "files") {
    throw new PropertyValueError(`Files "${prop.name}" supports is_empty and is_not_empty`);
  } else if (prop && filtersByDay(prop)) {
    if (input.op !== "equals" && input.op !== "gt" && input.op !== "lt") {
      throw new PropertyValueError(`"${prop.name}" supports equals (on the day), gt (after), lt (before), is_within, is_empty and is_not_empty`);
    }
    const day = String(value);
    if (!/^\d{4}-\d{2}-\d{2}/.test(day) || Number.isNaN(Date.parse(day.slice(0, 10)))) {
      throw new PropertyValueError(`"${prop.name}" filter value must be a date (YYYY-MM-DD)`);
    }
    value = day.slice(0, 10);
  } else if (prop?.type === "relation") {
    if (input.op !== "contains" && input.op !== "not_equals") {
      throw new PropertyValueError(
        `Relation "${prop.name}" supports contains, not_equals (does not contain), is_empty and is_not_empty`,
      );
    }
    value = relatedRowId(prop, lookups.relations, value);
  } else if (prop && holdsPeople(prop.type)) {
    if (input.op !== "contains" && input.op !== "not_equals") {
      throw new PropertyValueError(
        `${PEOPLE_LABELS[prop.type]} "${prop.name}" supports contains, not_equals (does not contain), is_empty and is_not_empty`,
      );
    }
    value = personId(prop, lookups.people, value);
  } else if (prop && holdsOptions(prop.type)) {
    if (input.op === "gt" || input.op === "lt") {
      throw new PropertyValueError(`"${input.op}" is not supported on select property "${prop.name}"`);
    }
    value = optionId(prop, value);
  } else if (type === "checkbox") {
    if (value === "true") value = true;
    else if (value === "false") value = false;
  } else if (prop && type === "number" && (input.op === "gt" || input.op === "lt" || input.op === "equals" || input.op === "not_equals")) {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) throw new PropertyValueError(`"${prop.name}" filter value must be a number`);
    value = n;
  }
  return { propertyId: key, op: input.op, value };
}

/** An is_within rule: a relative range on a date, plus a day count for past / next N days. */
function relativeDateRule(key: string, prop: PropertyDef | undefined, input: FilterInput): FilterRule {
  if (!holdsDates(key, prop)) {
    throw new PropertyValueError(
      `is_within only applies to date, created_time and last_edited_time properties and created_at / updated_at; "${input.property}" is ${prop?.type ?? "text"}`,
    );
  }
  const range = String(input.value).trim().toLowerCase();
  if (!isRelativeDateRange(range)) {
    throw new PropertyValueError(`is_within takes one of: ${RELATIVE_DATE_RANGES.join(", ")} (got "${String(input.value)}")`);
  }
  if (!rangeNeedsDays(range)) {
    if (input.days !== undefined) throw new PropertyValueError(`"days" only applies to past_n_days and next_n_days`);
    return { propertyId: key, op: "is_within", value: range };
  }
  if (!isDayCount(input.days)) {
    throw new PropertyValueError(`${range} needs "days", a whole number from 1 to ${MAX_RELATIVE_DAYS}`);
  }
  return { propertyId: key, op: "is_within", value: range, days: input.days };
}

/**
 * Converts agent-facing filters (rules and groups, see toFilterRule) to a stored filter tree.
 * Groups may nest MAX_FILTER_DEPTH levels; a group's combinator defaults to "and".
 */
export function toFilterEntries(props: PropertyDef[], inputs: FilterEntryInput[], lookups: Lookups = NO_LOOKUPS): FilterEntry[] {
  let count = 0;
  const convert = (entries: FilterEntryInput[], depth: number): FilterEntry[] =>
    entries.map((entry) => {
      if ("type" in entry && entry.type === "group") {
        if (depth >= MAX_FILTER_DEPTH) {
          throw new PropertyValueError(`Filter groups can be nested at most ${MAX_FILTER_DEPTH} levels deep`);
        }
        if (!entry.rules.length) throw new PropertyValueError("A filter group needs at least one rule");
        return { type: "group", combinator: entry.combinator ?? "and", rules: convert(entry.rules, depth + 1) };
      }
      if (++count > MAX_FILTER_RULES) throw new PropertyValueError(`A view can have at most ${MAX_FILTER_RULES} filter rules`);
      return toFilterRule(props, entry as FilterInput, lookups);
    });
  return convert(inputs, 0);
}

export function toSortRule(props: PropertyDef[], input: SortInput): SortRule {
  const { key, prop } = resolvePropertyKey(props, input.property);
  if (prop && !isSortable(prop.type)) {
    throw new PropertyValueError(`Relation "${prop.name}" can't be sorted`);
  }
  return { propertyId: key, direction: input.direction ?? "asc" };
}

/**
 * Row values keyed by property name with option names instead of ids, related rows as
 * `{id, title}`, people as `{id, name}` and files as `{name, url}` (absolute with `appUrl`).
 * Empty values are omitted.
 */
export function displayProperties(
  props: PropertyDef[],
  values: Record<string, unknown>,
  lookups: Lookups = NO_LOOKUPS,
  appUrl = "",
) {
  const out: Record<string, unknown> = {};
  for (const prop of props) {
    const value =
      prop.type === "files"
        ? asFiles(values[prop.id]).map((f) => ({ name: f.name, url: `${appUrl}${f.url}` }))
        : prop.type === "relation"
        ? relatedRows(prop, lookups.relations, values[prop.id])
        : holdsPeople(prop.type)
          ? assignedPeople(lookups.people, values[prop.id])
          : displayValue(prop, values[prop.id]);
    if (value === null || value === undefined || (Array.isArray(value) && value.length === 0)) continue;
    out[prop.name] = value;
  }
  return out;
}

function relatedRows(prop: PropertyDef, targets: RelationTargets, value: unknown) {
  if (!Array.isArray(value)) return null;
  const byId = new Map((targets[prop.id]?.rows ?? []).map((r) => [r.id, r]));
  return value.flatMap((id) => {
    const row = byId.get(id);
    return row ? [{ id: row.id, title: pageLabel(row.title) }] : [];
  });
}

/** People of a person value the caller can see; ids of unknown people are left out. */
function assignedPeople(people: PersonLookup[], value: unknown) {
  if (!Array.isArray(value)) return null;
  const byId = new Map(people.map((p) => [p.id, p]));
  return value.flatMap((id) => {
    const person = byId.get(id);
    return person ? [{ id: person.id, name: person.name }] : [];
  });
}

function keyName(props: PropertyDef[], key: string) {
  return props.find((p) => p.id === key)?.name ?? key;
}

/**
 * A view's stored config with property and option names, for get_database output. Chart settings
 * are described with their defaults when `type` is "chart".
 */
export function describeViewConfig(props: PropertyDef[], config: ViewConfig, lookups: Lookups = NO_LOOKUPS, type?: ViewType) {
  const byId = new Map(props.map((p) => [p.id, p]));
  const describeEntry = (f: FilterEntry): object => {
    if (isFilterGroup(f)) return { type: "group", combinator: f.combinator, rules: f.rules.map(describeEntry) };
    const prop = byId.get(f.propertyId);
    const value = prop && f.value !== undefined && f.op !== "is_within" ? filterValue(prop, f.value) : f.value;
    return {
      property: keyName(props, f.propertyId),
      op: f.op,
      ...(value !== undefined ? { value } : {}),
      ...(f.days !== undefined ? { days: f.days } : {}),
    };
  };
  const filterValue = (prop: PropertyDef, value: unknown) => {
    if (holdsPeople(prop.type)) return lookups.people.find((p) => p.id === value)?.name ?? value;
    if (prop.type !== "relation") return displayValue(prop, value) ?? value;
    const row = lookups.relations[prop.id]?.rows.find((r) => r.id === value);
    return row ? pageLabel(row.title) : value;
  };
  return {
    ...(config.groupBy ? { group_by: keyName(props, config.groupBy), ...describeGrouping(byId.get(config.groupBy), config) } : {}),
    ...(config.dateBy ? { date_by: keyName(props, config.dateBy) } : {}),
    ...(config.endDateBy ? { end_date_by: keyName(props, config.endDateBy) } : {}),
    ...(config.zoom ? { zoom: config.zoom } : {}),
    ...(config.showTable === false ? { show_table: false } : {}),
    ...(config.cardSize ? { card_size: config.cardSize } : {}),
    ...(config.cover ? { cover: config.cover.source === "property" ? keyName(props, config.cover.propertyId) : config.cover.source } : {}),
    ...(type === "chart" ? describeChart(props, config) : {}),
    ...(config.filters?.length ? { filters: config.filters.map(describeEntry) } : {}),
    ...(config.filters?.length && config.filterCombinator === "or" ? { filter_combinator: "or" } : {}),
    ...(config.sorts?.length
      ? { sorts: config.sorts.map((s) => ({ property: keyName(props, s.propertyId), direction: s.direction })) }
      : {}),
    ...(config.form ? { form: describeForm(props, config.form, lookups) } : {}),
  };
}

/** A form view's questions (skipping ones about deleted properties), texts and default values, by name. */
function describeForm(props: PropertyDef[], form: NonNullable<ViewConfig["form"]>, lookups: Lookups) {
  const defaults = formDefaults(form, props);
  return {
    ...(form.title ? { title: form.title } : {}),
    ...(form.description ? { description: form.description } : {}),
    questions: formQuestions(form, props).map((q) => ({
      property: q.prop?.name ?? "title",
      ...(q.required ? { required: true } : {}),
      ...(q.label ? { label: q.label } : {}),
      ...(q.description ? { description: q.description } : {}),
      ...(q.prop && !isPublicAskable(q.prop.type) ? { public: false } : {}),
    })),
    ...(Object.keys(defaults).length
      ? { defaults: displayProperties(props.filter((p) => p.id in defaults), defaults, lookups) }
      : {}),
    ...(form.confirmation ? { confirmation_message: form.confirmation } : {}),
    ...(form.allowAnother === false ? { allow_another: false } : {}),
  };
}

/** A chart's settings by name: what it measures (a stale calculation counts rows, like the chart does). */
function describeChart(props: PropertyDef[], config: ViewConfig) {
  const measure = chartMeasure(config, props);
  const chartType = chartTypeOf(config);
  const stackBy = config.stackBy && props.find((p) => p.id === config.stackBy);
  // Like the chart itself, a chart without a (usable) saved grouping groups the way a board would.
  const groupBy = chartGroupProperty(props, config);
  const accumulate = chartAccumulateOf(config, groupBy, measure);
  return {
    ...(groupBy ? { group_by: groupBy.name } : {}),
    chart_type: chartType,
    aggregate: measure.kind === "count" ? "count" : measure.fn,
    ...(measure.kind === "aggregate" ? { aggregate_property: keyName(props, measure.prop.id) } : {}),
    ...(accumulate ? { accumulate } : {}),
    ...(stackBy && canStack(chartType, measure) && !accumulate ? { stack_by: stackBy.name } : {}),
    // Running totals go oldest first whatever the saved sort.
    chart_sort: accumulate ? "group" : chartSortOf(config),
    ...(config.showValues ? { show_values: true } : {}),
    ...(chartType === "donut" ? { show_legend: config.showLegend !== false } : {}),
  };
}

/** A chart group's name: an option, person, related row or status group, a date bucket, checked or not. */
function chartGroupLabel(prop: PropertyDef, value: GroupValue): string {
  switch (value.kind) {
    case "none":
      return `No ${prop.name}`;
    case "option":
      return value.option.name || "Untitled";
    case "status_group":
      return value.group;
    case "person":
      return value.person.name;
    case "checkbox":
      return value.checked ? "Checked" : "Unchecked";
    case "relation":
      return pageLabel(value.row.title);
    case "date":
      switch (value.by) {
        case "day":
          return value.start;
        case "week":
          return `${value.start} to ${value.end}`;
        case "month":
          return value.start.slice(0, 7);
        case "year":
          return value.start.slice(0, 4);
      }
  }
}

/**
 * What a chart view plots over `rows` (already filtered), for query_database: one entry per bar,
 * point or slice with its label, value and row count, and stacked segments by series. Values are
 * plain numbers in `format` (percentages as fractions, date ranges in days); null when a group has
 * nothing to measure. Created and edited times count by their UTC day. With running totals each
 * point's value and row count are the running ones, and `period_value` the period's own.
 */
export function describeChartSeries(
  props: PropertyDef[],
  config: ViewConfig,
  rows: { id: string; properties: Record<string, unknown> }[],
  lookups: Lookups = NO_LOOKUPS,
) {
  const groupBy = chartGroupProperty(props, config);
  if (!groupBy) return { note: "This chart has no property to group by; add a select, status, date or other groupable property." };
  const measure = chartMeasure(config, props);
  const stackBy = props.find((p) => p.id === config.stackBy && p.id !== groupBy.id && isGroupable(p.type)) ?? null;
  const contextFor = (prop: PropertyDef): GroupContext => ({
    people: lookups.people.map((p) => ({ id: p.id, name: p.name, active: p.active !== false })),
    relationRows: prop.type === "relation" ? (lookups.relations[prop.id]?.rows ?? []).map((r) => ({ ...r, icon: null })) : undefined,
    dayOf: (value) => (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null),
  });
  const data = chartData(rows, {
    groupBy,
    stackBy,
    measure,
    config,
    context: contextFor(groupBy),
    ...(stackBy ? { stackContext: contextFor(stackBy) } : {}),
  });
  const label = (prop: PropertyDef, key: string, value: GroupValue, other?: boolean) => (other || key === OTHER_KEY ? "Other" : chartGroupLabel(prop, value));
  const valueOf = (result: AggregateResult | null) => (result && result.format !== "date" ? result.value : null);
  const accumulate = chartAccumulateOf(config, groupBy, measure);
  return {
    group_by: groupBy.name,
    format: data.format,
    ...(accumulate ? { accumulate, total: data.total } : {}),
    series: data.groups.map((g) => ({
      group: label(groupBy, g.key, g.value, g.other),
      ...(g.value.kind === "date" ? { start: g.value.start, end: g.value.end } : {}),
      value: valueOf(g.result),
      row_count: g.rows.length,
      ...(g.period ? { period_value: valueOf(g.period.result) } : {}),
      ...(data.series.length
        ? {
            segments: g.segments
              .map((s, i) => ({ series: label(stackBy!, s.key, data.series[i].value, data.series[i].other), value: valueOf(s.result), row_count: s.rows.length }))
              .filter((s) => s.row_count > 0),
          }
        : {}),
    })),
  };
}

/** How an AI autofill property is filled in, with property names instead of ids. */
function describeAutofill(config: AiAutofillConfig, props: PropertyDef[]) {
  const source =
    config.source === AUTOFILL_TITLE || config.source === AUTOFILL_BODY
      ? config.source
      : props.find((p) => p.id === config.source)?.name;
  return {
    mode: config.mode,
    ...(config.mode === "translation" ? { language: config.language, source } : {}),
    ...(config.mode === "custom" ? { prompt: config.prompt, include_body: Boolean(config.includeBody) } : {}),
    auto_update: Boolean(config.auto),
  };
}

/** The grouping settings that apply to how a view groups by `prop`. */
function describeGrouping(prop: PropertyDef | undefined, config: ViewConfig) {
  return {
    ...(prop && (prop.type === "date" || holdsTimestamp(prop.type)) ? { group_date_by: groupDateByOf(config) } : {}),
    ...(prop?.type === "status" ? { group_status_by: config.groupStatusBy === "group" ? "group" : "option" } : {}),
    ...(config.hideEmptyGroups ? { hide_empty_groups: true } : {}),
  };
}

/** The caller's level on a restricted property (see server/property-access PropertyAccessInfo). */
export type PropertyAccessNote = { level: PropertyLevel; perRow: boolean };

/**
 * How a restricted property's access reads in tool output: the caller's level, and whether rows
 * decide it (a person property exception: the level is the most any row gives).
 */
export function describeAccess(info: PropertyAccessNote | undefined) {
  if (!info) return {};
  return { access: info.level, ...(info.perRow ? { access_per_row: true } : {}) };
}

/**
 * The properties whose values a row leaves out (the caller may not see them there) and those it
 * shows read-only, by name, for row output. Empty lists are left out.
 */
export function describeRowAccess(props: PropertyDef[], row: { hidden?: string[]; readOnly?: string[] }) {
  const names = (ids: string[] | undefined) => (ids ?? []).flatMap((id) => props.find((p) => p.id === id)?.name ?? []);
  const hidden = names(row.hidden);
  const readOnly = names(row.readOnly);
  return {
    ...(hidden.length ? { hidden_properties: hidden } : {}),
    ...(readOnly.length ? { read_only_properties: readOnly } : {}),
  };
}

/** A property's access settings (server/property-access PropertyAccessSettings) for tool output. */
export type AccessSettingsInput = {
  everyone: PropertyLevel | "inherit";
  exceptions: (
    | { kind: "user"; id: string; name: string; email: string | null; level: PropertyLevel }
    | { kind: "group"; id: string; name: string; level: PropertyLevel }
    | { kind: "person"; id: string; name: string; level: PropertyLevel }
  )[];
  /** Others with full access to the database, whom the rules don't hold. */
  fullAccess?: { count: number; names: string[] };
};

export function describeAccessSettings(settings: AccessSettingsInput) {
  return {
    everyone: settings.everyone,
    exceptions: settings.exceptions.map((e) =>
      e.kind === "user"
        ? { user_id: e.id, name: e.name, ...(e.email ? { email: e.email } : {}), level: e.level }
        : e.kind === "group"
          ? { group_id: e.id, group: e.name, level: e.level }
          : { person_property: e.name, level: e.level },
    ),
    ...(settings.fullAccess?.count
      ? { not_restricted: { people_with_full_access: settings.fullAccess.count, names: settings.fullAccess.names } }
      : {}),
  };
}

/**
 * A property for get_database and friends. `props` (the database's properties the caller may
 * know of) name the properties a formula uses. `access`: the caller's level when the property is
 * restricted. `restricted`: some properties are kept from the caller, so a formula that reads one
 * of those (a property not in `props`) doesn't show its expression, which would name it by id.
 */
export function describeProperty(
  prop: PropertyDef,
  lookups: Lookups = NO_LOOKUPS,
  props: PropertyDef[] = [prop],
  { access, restricted = false }: { access?: PropertyAccessNote; restricted?: boolean } = {},
) {
  const relation = prop.type === "relation" ? prop.options.relation : undefined;
  const target = lookups.relations[prop.id];
  const expression = prop.options.formula?.expression ?? "";
  const known = new Set(props.map((p) => p.id));
  const readsUnknown = restricted && prop.type === "formula" && formulaReferences(expression).some((r) => r !== TITLE_FIELD && !known.has(r));
  return {
    id: prop.id,
    name: prop.name,
    type: prop.type,
    ...describeAccess(access),
    ...(prop.type === "formula"
      ? { formula: readsUnknown ? null : formulaForEditing(expression, props), result_type: derivedType(prop) }
      : {}),
    ...(prop.type === "rollup" ? { rollup: describeRollup(prop, lookups, props) } : {}),
    ...(holdsOptions(prop.type) ? { options: (prop.options.options ?? []).map((o) => o.name) } : {}),
    ...(prop.type === "status" ? { status_groups: statusGroups(prop) } : {}),
    ...(relation
      ? {
          // A related database they can't see isn't named, not even by id.
          ...(target && !target.database ? {} : { related_database_id: relation.databaseId }),
          ...(target?.database ? { related_database: pageLabel(target.database.title) } : {}),
          two_way: Boolean(relation.pairedPropertyId),
          ...(target?.pairedName ? { paired_property: target.pairedName } : {}),
        }
      : {}),
    ...(prop.type === "person"
      ? {
          people: lookups.people
            .filter((p) => p.active !== false)
            .map((p) => ({ id: p.id, name: p.name, ...(p.email ? { email: p.email } : {}) })),
        }
      : {}),
    ...(isReadOnlyType(prop.type) ? { read_only: true } : {}),
    // Filled in by the app's AI (values stay ordinary, editable text); see lib/ai AiAutofillConfig.
    ...(prop.type === "text" && prop.options.ai ? { ai_autofill: describeAutofill(prop.options.ai, props) } : {}),
  };
}

/**
 * What a rollup calculates, by names: its relation, the related database's property ("title"
 * for the related rows' titles; null when gone or hidden), the function and what values it gives.
 */
function describeRollup(prop: PropertyDef, lookups: Lookups, props: PropertyDef[]) {
  const config = prop.options.rollup;
  const relation = props.find((p) => p.id === config?.relationPropertyId && p.type === "relation");
  const target =
    config?.targetPropertyId === TITLE_FIELD
      ? TITLE_FIELD
      : (relation && lookups.relations[relation.id]?.properties?.find((p) => p.id === config?.targetPropertyId)?.name) || null;
  const format = rollupFormat(config?.function);
  return {
    relation: relation?.name ?? null,
    property: target,
    function: config?.function ?? null,
    result_type: derivedType(prop),
    // Percentages are fractions (0.25 = 25%) in values; filters compare percent points (25).
    format,
    ...(format === "percent" ? { display: config?.display ?? "number" } : {}),
  };
}

/** Option names of a status property per group, in order. */
function statusGroups(prop: PropertyDef) {
  const options = sortStatusOptions(prop.options.options ?? []);
  return Object.fromEntries(STATUS_GROUPS.map((group) => [group, options.filter((o) => o.group === group).map((o) => o.name)]));
}

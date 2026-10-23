// Client-safe: a plan of databases the AI drafts from what someone describes ("Build with AI", see
// server/ai-build.ts), checked here against the property and view types Leafdesk has, shown for the
// person to adjust, and created as it then stands. The same plan is what the AI chat's
// create_databases change takes.
//
// A plan names everything by name (properties, options, the databases relations point at by their
// `key`), as the model writes it; creating it turns names into ids. Checking is strict: a plan that
// names a type, option, property or database that isn't there is refused with what is wrong, never
// quietly changed, since the person creates what the preview shows.

import { parseIcon } from "./icon";
import { MAX_PROPERTY_DESCRIPTION } from "./property-description";
import { SELECT_COLORS } from "./properties";
import { holdsOptions, isReadOnlyType, PERSON_ME, STATUS_GROUPS, type StatusGroup } from "./property-types";

/** What someone may write to describe what they need. */
export const MAX_BUILD_REQUEST = 2_000;
export const MAX_PLAN_DATABASES = 4;
export const MAX_PLAN_PROPERTIES = 25;
export const MAX_PLAN_OPTIONS = 30;
export const MAX_PLAN_VIEWS = 6;
export const MAX_PLAN_ROWS = 10;
export const MAX_PLAN_FILTERS = 5;
export const MAX_PLAN_NAME = 100;
export const MAX_PLAN_TITLE = 200;
export const MAX_PLAN_INTRO = 4_000;

/**
 * The property types a plan may use: every type but formulas and rollups, whose expressions are
 * worth writing by hand once the database exists.
 */
export const PLAN_PROPERTY_TYPES = [
  "text",
  "number",
  "select",
  "multi_select",
  "status",
  "date",
  "checkbox",
  "url",
  "email",
  "phone",
  "checklist",
  "files",
  "relation",
  "person",
  "created_by",
  "created_time",
  "last_edited_by",
  "last_edited_time",
] as const;
export type PlanPropertyType = (typeof PLAN_PROPERTY_TYPES)[number];

/** The views a plan may add: those that show rows (charts, dashboards and forms are set up later). */
export const PLAN_VIEW_TYPES = ["table", "board", "calendar", "gallery", "list", "timeline"] as const;
export type PlanViewType = (typeof PLAN_VIEW_TYPES)[number];

/** Filter rules a plan's views may have, written as query_database takes them. */
export const PLAN_FILTER_OPS = ["equals", "not_equals", "contains", "does_not_contain", "is_empty", "is_not_empty", "gt", "lt"] as const;
export type PlanFilterOp = (typeof PLAN_FILTER_OPS)[number];

export type PlanColor = (typeof SELECT_COLORS)[number];
export type PlanOption = { name: string; color: PlanColor; group?: StatusGroup };
export type PlanProperty = {
  name: string;
  type: PlanPropertyType;
  description?: string;
  /** Select, multi-select and status. */
  options?: PlanOption[];
  /** Relations: the `key` of the plan's database it links to (its own key for links within it). */
  database?: string;
  /** Relations: the linked database shows the links too, in a property named `paired_name`. */
  two_way?: boolean;
  paired_name?: string;
};
export type PlanFilter = { property: string; op: PlanFilterOp; value?: string | number | boolean };
export type PlanSort = { property: string; direction: "asc" | "desc" };
export type PlanView = { name: string; type: PlanViewType; group_by?: string; date_by?: string; filters?: PlanFilter[]; sorts?: PlanSort[] };
/** An example row: values by property name, as people write them (option names, YYYY-MM-DD, "me", linked rows' titles). */
export type PlanRow = { title: string; values: Record<string, unknown> };
export type PlanDatabase = { key: string; title: string; icon: string | null; properties: PlanProperty[]; views: PlanView[]; rows: PlanRow[] };
/** A page above the databases that says what they are for; they go under it. */
export type PlanIntro = { title: string; icon: string | null; markdown: string };
export type DatabasePlan = { intro: PlanIntro | null; databases: PlanDatabase[] };

export type PlanCheck = { ok: true; plan: DatabasePlan } | { ok: false; problems: string[] };

const KEY = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_VALUE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?(\/\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?)?$/;

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const list = (value: unknown): unknown[] | null => (Array.isArray(value) ? value : value === undefined || value === null ? [] : null);
const text = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max).trim() : "");
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Groupable property types (lib/properties isGroupable), for a plan's boards and grouped tables. */
const GROUPABLE: ReadonlySet<string> = new Set(["select", "status", "multi_select", "checkbox", "date", "relation", "person", "created_by", "last_edited_by", "created_time", "last_edited_time"]);
const TEXTUAL: ReadonlySet<string> = new Set(["text", "url", "email", "phone"]);
const DAY_TYPES: ReadonlySet<string> = new Set(["date", "created_time", "last_edited_time"]);

/** The filter ops a property of `type` takes in a plan. */
export function planFilterOps(type: string): PlanFilterOp[] {
  const empty: PlanFilterOp[] = ["is_empty", "is_not_empty"];
  if (TEXTUAL.has(type)) return ["equals", "not_equals", "contains", "does_not_contain", ...empty];
  if (type === "number" || DAY_TYPES.has(type)) return ["equals", "not_equals", "gt", "lt", ...empty];
  if (holdsOptions(type)) return ["equals", "not_equals", ...empty];
  if (type === "checkbox") return ["equals"];
  if (type === "person" || type === "created_by" || type === "last_edited_by") return ["contains", "not_equals", ...empty];
  return empty;
}

/**
 * The plan in `raw` (a model's answer read as JSON, or a plan the person adjusted), checked: the
 * plan with its texts trimmed and cut to their limits, missing option colors given in order and
 * a database without views given a table, or every problem found, in words a model can fix them by.
 */
export function validateDatabasePlan(raw: unknown): PlanCheck {
  const problems: string[] = [];
  const input = record(raw);
  if (!input) return { ok: false, problems: ["The plan must be a JSON object with a databases list."] };
  const rawDatabases = list(input.databases);
  if (!rawDatabases || !rawDatabases.length) return { ok: false, problems: ["The plan needs at least one database in databases."] };
  if (rawDatabases.length > MAX_PLAN_DATABASES) problems.push(`A plan has at most ${MAX_PLAN_DATABASES} databases.`);

  let intro: PlanIntro | null = null;
  if (input.intro !== undefined && input.intro !== null) {
    const entry = record(input.intro);
    const title = text(entry?.title, MAX_PLAN_TITLE);
    if (!entry || !title) problems.push("intro needs a title (or leave intro out).");
    else intro = { title, icon: parseIcon(entry.icon), markdown: typeof entry.markdown === "string" ? entry.markdown.trim().slice(0, MAX_PLAN_INTRO) : "" };
  }

  // Keys first: relations may point at a database that comes later.
  const keys = rawDatabases.slice(0, MAX_PLAN_DATABASES).map((item, i) => {
    const key = text(record(item)?.key, 40).toLowerCase();
    return key || `database-${i + 1}`;
  });
  keys.forEach((key, i) => {
    if (!KEY.test(key)) problems.push(`Database ${i + 1}: key "${key}" must be lowercase letters, digits, - or _.`);
    if (keys.indexOf(key) !== i) problems.push(`Two databases have the key "${key}".`);
  });

  const databases: PlanDatabase[] = [];
  for (const [i, item] of rawDatabases.slice(0, MAX_PLAN_DATABASES).entries()) {
    const entry = record(item);
    const key = keys[i];
    if (!entry) {
      problems.push(`Database ${i + 1} must be an object.`);
      continue;
    }
    const title = text(entry.title, MAX_PLAN_TITLE);
    const where = `Database "${title || key}"`;
    if (!title) problems.push(`${where} needs a title.`);
    const properties = readProperties(entry.properties, where, keys, problems);
    databases.push({ key, title, icon: parseIcon(entry.icon), properties, views: [], rows: [] });
  }
  // Example rows may link to rows of a database that comes later: their titles, read first.
  const titles = new Map(
    databases.map((d, i) => [d.key, (list(record(rawDatabases[i])?.rows) ?? []).slice(0, MAX_PLAN_ROWS).map((r) => text(record(r)?.title, MAX_PLAN_TITLE)).filter(Boolean)]),
  );
  for (const [i, database] of databases.entries()) {
    const entry = record(rawDatabases[i])!;
    const where = `Database "${database.title || database.key}"`;
    database.views = readViews(entry.views, where, database, problems);
    database.rows = readRows(entry.rows, where, database, titles, problems);
  }
  return problems.length ? { ok: false, problems } : { ok: true, plan: { intro, databases } };
}

function readProperties(value: unknown, where: string, keys: string[], problems: string[]): PlanProperty[] {
  const items = list(value);
  if (!items) {
    problems.push(`${where}: properties must be a list.`);
    return [];
  }
  if (items.length > MAX_PLAN_PROPERTIES) problems.push(`${where} has more than ${MAX_PLAN_PROPERTIES} properties.`);
  const out: PlanProperty[] = [];
  for (const item of items.slice(0, MAX_PLAN_PROPERTIES)) {
    const entry = record(item);
    const name = text(entry?.name, MAX_PLAN_NAME);
    if (!entry || !name) {
      problems.push(`${where}: every property needs a name.`);
      continue;
    }
    const at = `${where}, property "${name}"`;
    // Every row has a name already: it is the page's title.
    if (same(name, "title") || same(name, "name")) {
      problems.push(`${at}: rows have their name (title) already; leave it out of the properties.`);
      continue;
    }
    if (out.some((p) => same(p.name, name))) {
      problems.push(`${where} has two properties named "${name}".`);
      continue;
    }
    const type = typeof entry.type === "string" ? entry.type.trim().toLowerCase() : "";
    if (!(PLAN_PROPERTY_TYPES as readonly string[]).includes(type)) {
      problems.push(
        type === "formula" || type === "rollup"
          ? `${at}: ${type} properties can't be part of a plan; use another type or leave it out.`
          : `${at}: unknown type "${String(entry.type)}". Use one of: ${PLAN_PROPERTY_TYPES.join(", ")}.`,
      );
      continue;
    }
    const property: PlanProperty = { name, type: type as PlanPropertyType };
    if (entry.description !== undefined && entry.description !== null && entry.description !== "") {
      const description = typeof entry.description === "string" ? entry.description.trim() : "";
      if (!description || description.length > MAX_PROPERTY_DESCRIPTION) problems.push(`${at}: the description must be text of up to ${MAX_PROPERTY_DESCRIPTION} characters.`);
      else property.description = description;
    }
    if (holdsOptions(type)) property.options = readOptions(entry.options, at, type === "status", problems);
    else if (entry.options !== undefined && entry.options !== null && !(Array.isArray(entry.options) && !entry.options.length)) {
      problems.push(`${at}: only select, multi_select and status properties have options.`);
    }
    if (type === "relation") {
      const target = text(entry.database, 40).toLowerCase();
      if (!keys.includes(target)) {
        problems.push(`${at}: a relation needs database, the key of one of the plan's databases (${keys.join(", ")}).`);
        continue;
      }
      property.database = target;
      if (entry.two_way !== undefined && typeof entry.two_way !== "boolean") problems.push(`${at}: two_way must be true or false.`);
      property.two_way = entry.two_way === true;
      const paired = text(entry.paired_name, MAX_PLAN_NAME);
      if (paired && property.two_way) property.paired_name = paired;
    } else if (entry.database !== undefined && entry.database !== null) {
      problems.push(`${at}: only relation properties name a database.`);
    }
    out.push(property);
  }
  return out;
}

/**
 * Options in their order. A status spreads options given without a group over its groups like the
 * app does (the first to do, the last done, the rest in progress), and needs one of each group.
 */
function readOptions(value: unknown, at: string, status: boolean, problems: string[]): PlanOption[] {
  const items = list(value);
  if (!items) {
    problems.push(`${at}: options must be a list.`);
    return [];
  }
  if (items.length > MAX_PLAN_OPTIONS) problems.push(`${at} has more than ${MAX_PLAN_OPTIONS} options.`);
  const kept = items.slice(0, MAX_PLAN_OPTIONS);
  const options: PlanOption[] = [];
  for (const [i, item] of kept.entries()) {
    const entry = typeof item === "string" ? { name: item } : record(item);
    const name = text(entry?.name, MAX_PLAN_NAME);
    if (!entry || !name) {
      problems.push(`${at}: every option needs a name.`);
      continue;
    }
    if (options.some((o) => same(o.name, name))) {
      problems.push(`${at} has two options named "${name}".`);
      continue;
    }
    const rawColor = typeof entry.color === "string" ? entry.color.trim().toLowerCase() : entry.color;
    let color: PlanColor;
    if (rawColor === undefined || rawColor === null || rawColor === "") color = SELECT_COLORS[i % SELECT_COLORS.length];
    else if ((SELECT_COLORS as readonly unknown[]).includes(rawColor)) color = rawColor as PlanColor;
    else {
      problems.push(`${at}, option "${name}": unknown color "${String(entry.color)}". Use one of: ${SELECT_COLORS.join(", ")}.`);
      continue;
    }
    const option: PlanOption = { name, color };
    if (status) {
      const rawGroup = typeof entry.group === "string" ? entry.group.trim().toLowerCase() : entry.group;
      if (rawGroup === undefined || rawGroup === null || rawGroup === "") option.group = i === 0 ? "todo" : i === kept.length - 1 ? "done" : "in_progress";
      else if ((STATUS_GROUPS as readonly unknown[]).includes(rawGroup)) option.group = rawGroup as StatusGroup;
      else {
        problems.push(`${at}, option "${name}": unknown group "${String(entry.group)}". Use one of: ${STATUS_GROUPS.join(", ")}.`);
        continue;
      }
    } else if (entry.group !== undefined && entry.group !== null) {
      problems.push(`${at}, option "${name}": only status options have a group.`);
    }
    options.push(option);
  }
  if (status && options.length) {
    for (const group of ["todo", "done"] as const) {
      if (!options.some((o) => o.group === group)) problems.push(`${at}: a status needs at least one option in the "${group}" group.`);
    }
  }
  return options;
}

const findProperty = (database: PlanDatabase, name: unknown) =>
  typeof name === "string" && name.trim() ? database.properties.find((p) => same(p.name, name)) : undefined;

function readViews(value: unknown, where: string, database: PlanDatabase, problems: string[]): PlanView[] {
  const items = list(value);
  if (!items) {
    problems.push(`${where}: views must be a list.`);
    return [];
  }
  if (items.length > MAX_PLAN_VIEWS) problems.push(`${where} has more than ${MAX_PLAN_VIEWS} views.`);
  const views: PlanView[] = [];
  for (const [i, item] of items.slice(0, MAX_PLAN_VIEWS).entries()) {
    const entry = record(item);
    const type = typeof entry?.type === "string" ? entry.type.trim().toLowerCase() : "";
    const name = text(entry?.name, MAX_PLAN_NAME);
    const at = `${where}, view ${name ? `"${name}"` : i + 1}`;
    if (!entry || !(PLAN_VIEW_TYPES as readonly string[]).includes(type)) {
      problems.push(`${at}: unknown view type "${String(entry?.type)}". Use one of: ${PLAN_VIEW_TYPES.join(", ")}.`);
      continue;
    }
    const view: PlanView = { name, type: type as PlanViewType };
    const groupBy = entry.group_by;
    if (groupBy !== undefined && groupBy !== null && groupBy !== "") {
      const property = findProperty(database, groupBy);
      if (type !== "board" && type !== "table" && type !== "timeline") problems.push(`${at}: only boards, tables and timelines group rows.`);
      else if (!property) problems.push(`${at}: group_by names "${String(groupBy)}", which isn't one of the database's properties.`);
      else if (!GROUPABLE.has(property.type)) problems.push(`${at}: rows can't be grouped by "${property.name}", a ${property.type} property.`);
      else view.group_by = property.name;
    } else if (type === "board") {
      // A board needs columns: the first select or status it can group by.
      const property = database.properties.find((p) => p.type === "status" || p.type === "select");
      if (property) view.group_by = property.name;
      else problems.push(`${at}: a board needs group_by, a select or status property to make its columns.`);
    }
    const dateBy = entry.date_by;
    if (type === "calendar" || type === "timeline") {
      const property = dateBy !== undefined && dateBy !== null && dateBy !== "" ? findProperty(database, dateBy) : database.properties.find((p) => p.type === "date");
      if (!property) problems.push(`${at}: a ${type} needs date_by, a date property of the database.`);
      else if (property.type !== "date" && !(type === "timeline" && DAY_TYPES.has(property.type))) problems.push(`${at}: "${property.name}" is a ${property.type} property, not a date.`);
      else view.date_by = property.name;
    } else if (dateBy !== undefined && dateBy !== null && dateBy !== "") {
      problems.push(`${at}: only calendars and timelines have date_by.`);
    }
    const filters = list(entry.filters);
    if (!filters) problems.push(`${at}: filters must be a list.`);
    else if (filters.length) {
      if (filters.length > MAX_PLAN_FILTERS) problems.push(`${at} has more than ${MAX_PLAN_FILTERS} filters.`);
      view.filters = filters.slice(0, MAX_PLAN_FILTERS).flatMap((f) => readFilter(f, at, database, problems));
    }
    const sorts = list(entry.sorts);
    if (!sorts) problems.push(`${at}: sorts must be a list.`);
    else if (sorts.length) {
      view.sorts = sorts.slice(0, 3).flatMap((s): PlanSort[] => {
        const sort = record(s);
        const property = findProperty(database, sort?.property);
        const direction = sort?.direction === undefined ? "asc" : String(sort.direction).toLowerCase();
        if (!property) problems.push(`${at}: a sort names "${String(sort?.property)}", which isn't one of the database's properties.`);
        else if (property.type === "relation") problems.push(`${at}: rows can't be sorted by the relation "${property.name}".`);
        else if (direction !== "asc" && direction !== "desc") problems.push(`${at}: a sort's direction is "asc" or "desc".`);
        else return [{ property: property.name, direction }];
        return [];
      });
    }
    views.push(view);
  }
  if (!items.length) views.push({ name: "", type: "table" });
  return views;
}

function readFilter(value: unknown, at: string, database: PlanDatabase, problems: string[]): PlanFilter[] {
  const entry = record(value);
  const property = findProperty(database, entry?.property);
  if (!entry || !property) {
    problems.push(`${at}: a filter names "${String(entry?.property)}", which isn't one of the database's properties.`);
    return [];
  }
  const op = typeof entry.op === "string" ? entry.op.trim().toLowerCase() : "";
  const ops = planFilterOps(property.type);
  if (!(ops as string[]).includes(op)) {
    problems.push(`${at}: "${property.name}" (${property.type}) filters with ${ops.join(", ")}, not "${String(entry.op)}".`);
    return [];
  }
  if (op === "is_empty" || op === "is_not_empty") return [{ property: property.name, op: op as PlanFilterOp }];
  const v = entry.value;
  const fail = (what: string) => {
    problems.push(`${at}: the filter on "${property.name}" needs ${what}.`);
    return [];
  };
  if (property.type === "checkbox") return typeof v === "boolean" ? [{ property: property.name, op: "equals", value: v }] : fail("true or false");
  if (property.type === "number") return typeof v === "number" && Number.isFinite(v) ? [{ property: property.name, op: op as PlanFilterOp, value: v }] : fail("a number");
  if (DAY_TYPES.has(property.type)) return typeof v === "string" && DAY.test(v) ? [{ property: property.name, op: op as PlanFilterOp, value: v }] : fail("a date (YYYY-MM-DD)");
  if (holdsOptions(property.type)) {
    const option = property.options?.find((o) => typeof v === "string" && same(o.name, v));
    return option ? [{ property: property.name, op: op as PlanFilterOp, value: option.name }] : fail(`one of its options (${(property.options ?? []).map((o) => o.name).join(", ")})`);
  }
  // People: the viewer ("me"), so one saved view shows each person their own rows.
  if (property.type === "person" || property.type === "created_by" || property.type === "last_edited_by") {
    return v === PERSON_ME ? [{ property: property.name, op: op as PlanFilterOp, value: PERSON_ME }] : fail(`"${PERSON_ME}"`);
  }
  return typeof v === "string" && v.trim() ? [{ property: property.name, op: op as PlanFilterOp, value: v.trim().slice(0, 200) }] : fail("some text");
}

function readRows(value: unknown, where: string, database: PlanDatabase, titles: Map<string, string[]>, problems: string[]): PlanRow[] {
  const items = list(value);
  if (!items) {
    problems.push(`${where}: rows must be a list.`);
    return [];
  }
  if (items.length > MAX_PLAN_ROWS) problems.push(`${where} has more than ${MAX_PLAN_ROWS} example rows.`);
  const rows: PlanRow[] = [];
  for (const [i, item] of items.slice(0, MAX_PLAN_ROWS).entries()) {
    const entry = record(item);
    const title = text(entry?.title, MAX_PLAN_TITLE);
    const at = `${where}, row ${title ? `"${title}"` : i + 1}`;
    if (!entry || !title) {
      problems.push(`${at}: every example row needs a title.`);
      continue;
    }
    const values: Record<string, unknown> = {};
    const raw = entry.values === undefined || entry.values === null ? {} : record(entry.values);
    if (!raw) problems.push(`${at}: values must be an object of property names and values.`);
    for (const [name, v] of Object.entries(raw ?? {})) {
      if (v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length)) continue;
      const property = findProperty(database, name);
      if (!property) {
        problems.push(`${at}: "${name}" isn't one of the database's properties.`);
        continue;
      }
      const checked = rowValue(property, v, titles);
      if (typeof checked === "string") problems.push(`${at}, "${property.name}": ${checked}`);
      else values[property.name] = checked.value;
    }
    rows.push({ title, values });
  }
  return rows;
}

/** A row's value as a plan may give it, or what is wrong with it. */
function rowValue(property: PlanProperty, v: unknown, titles: Map<string, string[]>): { value: unknown } | string {
  const names = (value: unknown) => (Array.isArray(value) ? value : [value]);
  if (isReadOnlyType(property.type)) return "this property fills itself in; leave it out.";
  switch (property.type) {
    case "number":
      return typeof v === "number" && Number.isFinite(v) ? { value: v } : "the value must be a number.";
    case "checkbox":
      return typeof v === "boolean" ? { value: v } : "the value must be true or false.";
    case "date":
      return typeof v === "string" && DATE_VALUE.test(v.trim()) ? { value: v.trim() } : "the value must be a date (YYYY-MM-DD, or start/end).";
    case "select":
    case "status":
    case "multi_select": {
      const given = names(v);
      if (property.type !== "multi_select" && given.length !== 1) return "the value is one option.";
      const picked = given.map((g) => property.options?.find((o) => typeof g === "string" && same(o.name, g))?.name);
      if (picked.some((p) => !p)) return `the value must be one of its options (${(property.options ?? []).map((o) => o.name).join(", ")}).`;
      return { value: property.type === "multi_select" ? [...new Set(picked)] : picked[0] };
    }
    case "person":
      // Example rows name nobody but whoever creates them.
      return names(v).every((p) => p === PERSON_ME) ? { value: [PERSON_ME] } : `example rows can only assign "${PERSON_ME}".`;
    case "relation": {
      const linked = titles.get(property.database ?? "") ?? [];
      const given = names(v);
      if (!given.every((title) => typeof title === "string" && linked.some((t) => same(t, title)))) {
        return "the value must be titles of example rows of the database it links to.";
      }
      return { value: [...new Set(given.map((t) => String(t).trim()))] };
    }
    case "files":
      return "example rows can't have files.";
    case "checklist":
      return Array.isArray(v) && v.every((item) => typeof item === "string" && item.trim())
        ? { value: v.map((item) => (item as string).trim().slice(0, 500)) }
        : "the value must be a list of item texts.";
    default:
      return typeof v === "string" || typeof v === "number" ? { value: String(v).trim().slice(0, 2_000) } : "the value must be text.";
  }
}

// ------------------------------------------------------------------------------------------
// Adjusting a plan in the preview. Each change keeps it whole: what named a removed property,
// view or database goes with it.

/** The plan with database `key` renamed. */
export function renameDatabase(plan: DatabasePlan, key: string, title: string): DatabasePlan {
  return { ...plan, databases: plan.databases.map((d) => (d.key === key ? { ...d, title: title.slice(0, MAX_PLAN_TITLE) } : d)) };
}

/** The plan without database `key`, and without the relations that linked to it. */
export function withoutDatabase(plan: DatabasePlan, key: string): DatabasePlan {
  let next: DatabasePlan = { ...plan, databases: plan.databases.filter((d) => d.key !== key) };
  for (const database of next.databases) {
    for (const property of database.properties.filter((p) => p.type === "relation" && p.database === key)) {
      next = withoutProperty(next, database.key, property.name);
    }
  }
  return next;
}

/** The plan with a property renamed, wherever its database's views and rows name it. */
export function renameProperty(plan: DatabasePlan, key: string, from: string, to: string): DatabasePlan {
  const name = to.slice(0, MAX_PLAN_NAME);
  const rename = (n: string | undefined) => (n !== undefined && same(n, from) ? name : n);
  return {
    ...plan,
    databases: plan.databases.map((d) => {
      if (d.key !== key) return d;
      return {
        ...d,
        properties: d.properties.map((p) => (same(p.name, from) ? { ...p, name } : p)),
        views: d.views.map((v) => ({
          ...v,
          ...(v.group_by !== undefined ? { group_by: rename(v.group_by) } : {}),
          ...(v.date_by !== undefined ? { date_by: rename(v.date_by) } : {}),
          ...(v.filters ? { filters: v.filters.map((f) => ({ ...f, property: rename(f.property)! })) } : {}),
          ...(v.sorts ? { sorts: v.sorts.map((s) => ({ ...s, property: rename(s.property)! })) } : {}),
        })),
        rows: d.rows.map((r) => ({ ...r, values: Object.fromEntries(Object.entries(r.values).map(([k, v]) => [rename(k)!, v])) })),
      };
    }),
  };
}

/**
 * The plan without a property: its values go from the rows, and from the views their filters and
 * sorts on it, their grouping (a board then groups by another select or status, or goes) and their
 * dates (a calendar or timeline without another date goes).
 */
export function withoutProperty(plan: DatabasePlan, key: string, name: string): DatabasePlan {
  return {
    ...plan,
    databases: plan.databases.map((d) => {
      if (d.key !== key) return d;
      const properties = d.properties.filter((p) => !same(p.name, name));
      const views = d.views.flatMap((v): PlanView[] => {
        const view: PlanView = { ...v };
        if (view.filters) view.filters = view.filters.filter((f) => !same(f.property, name));
        if (view.sorts) view.sorts = view.sorts.filter((s) => !same(s.property, name));
        if (view.group_by !== undefined && same(view.group_by, name)) {
          delete view.group_by;
          if (view.type === "board") {
            const other = properties.find((p) => p.type === "status" || p.type === "select");
            if (!other) return [];
            view.group_by = other.name;
          }
        }
        if (view.date_by !== undefined && same(view.date_by, name)) {
          const other = properties.find((p) => p.type === "date");
          if (!other) return [];
          view.date_by = other.name;
        }
        return [view];
      });
      return {
        ...d,
        properties,
        views: views.length ? views : [{ name: "", type: "table" }],
        rows: d.rows.map((r) => ({ ...r, values: Object.fromEntries(Object.entries(r.values).filter(([k]) => !same(k, name))) })),
      };
    }),
  };
}

/** The plan without view `index` of database `key` (a database keeps one view at least). */
export function withoutView(plan: DatabasePlan, key: string, index: number): DatabasePlan {
  return {
    ...plan,
    databases: plan.databases.map((d) => (d.key === key && d.views.length > 1 ? { ...d, views: d.views.filter((_, i) => i !== index) } : d)),
  };
}

/** The plan without example rows, in every database. */
export function withoutRows(plan: DatabasePlan): DatabasePlan {
  return { ...plan, databases: plan.databases.map((d) => ({ ...d, rows: [] })) };
}

/** The JSON a plan is sent and checked as: what validateDatabasePlan reads back to the same plan. */
export function planJson(plan: DatabasePlan): unknown {
  return JSON.parse(JSON.stringify(plan));
}

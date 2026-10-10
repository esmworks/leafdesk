import type {
  ChecklistItem,
  FilterCombinator,
  FilterEntry,
  FilterOp,
  FilterRule,
  PropertyOptions,
  PropertyType,
  SelectOption,
  SortRule,
  ViewConfig,
  ViewType,
} from "@/db/schema/app";
import {
  compileFilters,
  dayString,
  isDayCount,
  isRelativeDateRange,
  pruneFilters,
  rangeNeedsDays,
  relativeDateRange,
  requiredFilterRules,
  valueDay,
} from "./filters";
import { checkDateInput, dateDays, dateSortKey, isDay, type DaySpan } from "./date-value";
import { dayNumber } from "./time-zone";
import { asFiles, cleanFileName, fileIdOf, fileUrl, MAX_FILES_PER_VALUE, type FileValue } from "./files";
import { derivedType, isErrorValue, rollupFormat } from "./derived";
import {
  holdsOptions,
  holdsPeople,
  holdsTimestamp,
  isDerived,
  isReadOnlyType,
  PERSON_ME,
  STATUS_GROUPS,
  type StatusGroup,
} from "./property-types";
import { isPercent, toPercentPoints } from "./number-format";
import { moveBeside } from "./reorder";

export const SELECT_COLORS = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"] as const;

/**
 * Stable codes for user-facing database errors. The English `message` stays the contract for MCP
 * clients; the UI translates by `code` (see `database.errors.*` messages).
 */
export const DATABASE_ERROR_CODES = [
  "invalidUrl",
  "invalidEmail",
  "invalidPhone",
  "invalidChecklist",
  "invalidFile",
  "invalidNumber",
  "invalidCheckbox",
  "invalidDate",
  "unknownOption",
  "unknownProperty",
  "unsupportedType",
  "notADatabase",
  "notADatabaseRow",
  "notASelectProperty",
  "lastView",
  "parentInTrash",
  "nestedDatabase",
  "invalidRelation",
  "invalidRelationTarget",
  "subItemLoop",
  "notSubItemsRelation",
  "dependencyLoop",
  "notDependencyRelation",
  "invalidDependencySettings",
  "invalidPerson",
  "readOnlyProperty",
  "relationTargetReadOnly",
  "databaseLocked",
  "pageLocked",
  "invalidFilter",
  "invalidViewConfig",
  "unsupportedViewType",
  "tooManyRows",
  "invalidFormula",
  "invalidRollup",
  "invalidNumberFormat",
  "invalidDateOptions",
  "invalidPageVisibility",
  "calendarFeedNotCalendar",
  "calendarFeedExportOff",
  "isTemplate",
  "notATemplate",
  "propertyRestricted",
  "cannotRestrict",
  "typeChangeRestricted",
  "typeChangeNamesPeople",
  "invalidAutomation",
  "tooManyAutomations",
  "invalidWebhookUrl",
  "webhookBlocked",
  "agentOwnersOnly",
  "invalidRepeat",
  "tooManySchedules",
] as const;
export type DatabaseErrorCode = (typeof DATABASE_ERROR_CODES)[number];
export type DatabaseErrorParams = Record<string, string>;

export function isDatabaseErrorCode(code: unknown): code is DatabaseErrorCode {
  return typeof code === "string" && (DATABASE_ERROR_CODES as readonly string[]).includes(code);
}

export class PropertyValueError extends Error {
  code?: DatabaseErrorCode;
  params: DatabaseErrorParams;
  constructor(message: string, code?: DatabaseErrorCode, params: DatabaseErrorParams = {}) {
    super(message);
    this.name = "PropertyValueError";
    this.code = code;
    this.params = params;
  }
}

type PropertyDef = { id: string; name: string; type: PropertyType; options: PropertyOptions };

/**
 * Written by Leafdesk itself (who created or last edited the row, and when) or worked out from
 * other values (formulas), never by users or agents.
 */
function readOnlyError(prop: PropertyDef) {
  return new PropertyValueError(`"${prop.name}" is set automatically and can't be changed`, "readOnlyProperty", {
    property: prop.name,
  });
}

/** The row columns computed values come from. Missing ones compute to empty. */
export type ComputedSource = {
  createdBy: string | null;
  updatedBy?: string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
};

function isoTime(d: Date | string | null | undefined) {
  if (!d) return null;
  const date = typeof d === "string" ? new Date(d) : d;
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Values Leafdesk fills in instead of storing: who created and last edited the row (as person
 * values) and when (ISO timestamps). Rows read from the database get these merged into their
 * properties. "Last edited" follows the row's page, so property changes and body edits both count.
 */
export function computedValues(props: { id: string; type: PropertyType }[], row: ComputedSource) {
  const out: Record<string, unknown> = {};
  for (const prop of props) {
    if (prop.type === "created_by") out[prop.id] = row.createdBy ? [row.createdBy] : null;
    else if (prop.type === "last_edited_by") out[prop.id] = row.updatedBy ? [row.updatedBy] : null;
    else if (prop.type === "created_time") out[prop.id] = isoTime(row.createdAt);
    else if (prop.type === "last_edited_time") out[prop.id] = isoTime(row.updatedAt);
  }
  return out;
}

const STATUS_COLORS: Record<StatusGroup, string> = { todo: "gray", in_progress: "blue", done: "green" };

/**
 * Options for a new status property. Options given by name are spread over the groups by
 * position: the first is to do, the last done and the ones between in progress (a lone option
 * is to do). Without options it gets Not started / In progress / Done.
 */
export function makeStatusOptions(
  input: (string | { name: string; group?: StatusGroup })[] = [],
  newId: () => string = () => crypto.randomUUID(),
): SelectOption[] {
  const entries = input.length ? input : ["Not started", "In progress", "Done"];
  const last = entries.length - 1;
  const options = entries.map((entry, i): SelectOption => {
    const name = (typeof entry === "string" ? entry : entry.name).trim();
    const byPosition: StatusGroup = i === 0 ? "todo" : i === last ? "done" : "in_progress";
    const group = typeof entry === "object" && entry.group ? entry.group : byPosition;
    return { id: newId(), name, color: STATUS_COLORS[group], group };
  });
  return sortStatusOptions(options);
}

/** A status option's group; options saved without a (known) one count as to do. */
export function statusGroupOf(option: Pick<SelectOption, "group">): StatusGroup {
  return option.group && STATUS_GROUPS.includes(option.group) ? option.group : "todo";
}

/** The option `value` (a row's value of the status or select property `property`) picks, if any. */
export function optionOf(property: { options: PropertyOptions }, value: unknown): SelectOption | undefined {
  return (property.options.options ?? []).find((o) => o.id === value);
}

/** Whether `value`, a row's value of the status property `property`, is in the "done" group. */
export function isDoneStatus(property: { options: PropertyOptions }, value: unknown) {
  const option = optionOf(property, value);
  return option !== undefined && statusGroupOf(option) === "done";
}

/** Default color for a status option added to `group`. */
export function statusColor(group: StatusGroup) {
  return STATUS_COLORS[group];
}

/**
 * Status options with a valid group each, ordered by group (to do, in progress, done) and by
 * their order within the group. They are stored in this order, so option order is status order.
 */
export function sortStatusOptions(options: SelectOption[]): SelectOption[] {
  return STATUS_GROUPS.flatMap((group) =>
    options.filter((o) => statusGroupOf(o) === group).map((o) => ({ ...o, group })),
  );
}

/** A checklist value as items; anything else reads as an empty list. */
export function asChecklist(value: unknown): ChecklistItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const item = entry as Partial<ChecklistItem> | null;
    if (!item || typeof item !== "object" || typeof item.text !== "string") return [];
    return [{ id: String(item.id ?? ""), text: item.text, checked: item.checked === true }];
  });
}

/** How many items of a checklist are ticked, or null for an empty checklist. */
export function checklistProgress(value: unknown): { done: number; total: number } | null {
  const items = asChecklist(value);
  return items.length ? { done: items.filter((i) => i.checked).length, total: items.length } : null;
}

export function isEmailAddress(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/** Loose phone check: digits with the usual separators, an optional leading +, and an optional extension. */
export function isPhoneNumber(value: string) {
  const digits = value.replace(/\D/g, "").length;
  return /^\+?[\d\s().\-/]+((x|ext\.?|#)\s*\d+)?$/i.test(value) && digits >= 3 && digits <= 20;
}

/** `tel:` link for a stored phone number (separators and extension dropped). */
export function phoneHref(value: string) {
  return `tel:${value.replace(/(x|ext\.?|#)\s*\d+$/i, "").replace(/[^\d+]/g, "")}`;
}

/**
 * Checklist input: a list of item texts or `{text, checked?, id?}` items. Items keep their ids
 * (new ones get one) and blank items are dropped.
 */
function normalizeChecklist(prop: PropertyDef, value: unknown): ChecklistItem[] | null {
  const invalid = () =>
    new PropertyValueError(`"${prop.name}" takes a list of items (texts or {text, checked})`, "invalidChecklist", {
      property: prop.name,
    });
  if (!Array.isArray(value)) throw invalid();
  const seen = new Set<string>();
  const out: ChecklistItem[] = [];
  for (const entry of value) {
    let item: ChecklistItem;
    if (typeof entry === "string") item = { id: "", text: entry, checked: false };
    else if (entry && typeof entry === "object" && typeof (entry as { text?: unknown }).text === "string") {
      const e = entry as { id?: unknown; text: string; checked?: unknown };
      if (e.checked !== undefined && typeof e.checked !== "boolean") throw invalid();
      item = { id: typeof e.id === "string" ? e.id : "", text: e.text, checked: e.checked === true };
    } else throw invalid();
    const text = item.text.replace(/\s+/g, " ").trim().slice(0, 1000);
    if (!text) continue;
    const id = item.id && !seen.has(item.id) ? item.id : crypto.randomUUID();
    seen.add(id);
    out.push({ id, text, checked: item.checked });
  }
  return out.length ? out : null;
}

/**
 * Files input: a list of uploaded files, each its URL (`/api/files/<id>`, absolute or not) or an
 * object with a `url` (a stored value, `{name, url}` from MCP). Only the shape is checked here; the
 * server checks that each file exists, may be read and belongs to the workspace, and puts in the
 * file's own name and type (see databases.resolveFilesValue). Order is kept, repeats dropped.
 */
function normalizeFiles(prop: PropertyDef, value: unknown): FileValue[] | null {
  const invalid = () =>
    new PropertyValueError(`"${prop.name}" takes uploaded files: their URLs (/api/files/…) or {url, name} objects`, "invalidFile", {
      property: prop.name,
    });
  const out: FileValue[] = [];
  for (const entry of Array.isArray(value) ? value : [value]) {
    const item = entry && typeof entry === "object" ? (entry as { url?: unknown; name?: unknown; type?: unknown }) : null;
    const id = fileIdOf(item ? item.url : entry);
    if (!id) throw invalid();
    const url = fileUrl(id);
    if (out.some((f) => f.url === url)) continue;
    out.push({
      url,
      name: typeof item?.name === "string" && item.name.trim() ? cleanFileName(item.name) : "file",
      type: typeof item?.type === "string" && item.type ? item.type : "application/octet-stream",
    });
  }
  if (out.length > MAX_FILES_PER_VALUE) {
    throw new PropertyValueError(`"${prop.name}" can hold at most ${MAX_FILES_PER_VALUE} files`, "invalidFile", {
      property: prop.name,
    });
  }
  return out.length ? out : null;
}

function findOption(options: SelectOption[] | undefined, input: unknown): SelectOption | undefined {
  if (typeof input !== "string") return undefined;
  const needle = input.trim().toLowerCase();
  return options?.find((o) => o.id === input || o.name.toLowerCase() === needle);
}

/**
 * Normalizes a user/agent supplied value for storage. Select values are stored as option ids;
 * callers may pass option names (MCP does), which are resolved here. Returns `null` to clear.
 */
export function normalizeValue(prop: PropertyDef, value: unknown): unknown {
  if (isReadOnlyType(prop.type)) throw readOnlyError(prop);
  if (value === null || value === undefined || value === "") return null;
  switch (prop.type) {
    case "text":
      return String(value);
    case "email": {
      const email = String(value).trim().replace(/^mailto:/i, "");
      if (!isEmailAddress(email)) {
        throw new PropertyValueError(`"${prop.name}" must be an email address`, "invalidEmail", { property: prop.name });
      }
      return email;
    }
    case "phone": {
      const phone = String(value).trim().replace(/^tel:/i, "").replace(/\s+/g, " ");
      if (!isPhoneNumber(phone)) {
        throw new PropertyValueError(`"${prop.name}" must be a phone number`, "invalidPhone", { property: prop.name });
      }
      return phone;
    }
    case "checklist":
      return normalizeChecklist(prop, value);
    case "files":
      return normalizeFiles(prop, value);
    case "url": {
      const url = String(value).trim();
      if (!/^https?:\/\//i.test(url) && !/^mailto:/i.test(url)) {
        throw new PropertyValueError(`"${prop.name}" must be an http(s) or mailto URL`, "invalidUrl", {
          property: prop.name,
        });
      }
      return url;
    }
    case "number": {
      const n = typeof value === "number" ? value : Number(String(value).replace(",", "."));
      if (!Number.isFinite(n)) throw new PropertyValueError(`"${prop.name}" must be a number`, "invalidNumber", { property: prop.name });
      return n;
    }
    case "checkbox":
      if (typeof value === "boolean") return value;
      if (value === "true" || value === 1) return true;
      if (value === "false" || value === 0) return false;
      throw new PropertyValueError(`"${prop.name}" must be true or false`, "invalidCheckbox", {
        property: prop.name,
      });
    case "date": {
      // A day, a time, or a range of either (see lib/date-value).
      const checked = checkDateInput(value, prop.name);
      if (!checked.ok) throw new PropertyValueError(checked.message, "invalidDate", { property: prop.name });
      return checked.value;
    }
    case "select":
    case "status": {
      const option = findOption(prop.options.options, value);
      if (!option) {
        throw new PropertyValueError(`"${value}" is not an option of "${prop.name}"`, "unknownOption", {
          value: String(value),
          property: prop.name,
        });
      }
      return option.id;
    }
    case "relation": {
      // Row ids (or, from MCP, row titles) — resolved and checked against the related database by
      // the server. Order is kept, duplicates dropped.
      const raw = Array.isArray(value) ? value : [value];
      if (raw.some((v) => typeof v !== "string")) {
        throw new PropertyValueError(`"${prop.name}" takes a list of row ids`, "invalidRelation", { property: prop.name });
      }
      const unique = [...new Set((raw as string[]).map((v) => v.trim()).filter(Boolean))];
      return unique.length ? unique : null;
    }
    case "person": {
      // User ids (or, from MCP, emails, names or "me") — resolved and checked against the
      // workspace's people by the server. Order is kept, duplicates dropped.
      const raw = Array.isArray(value) ? value : [value];
      if (raw.some((v) => typeof v !== "string")) {
        throw new PropertyValueError(`"${prop.name}" takes a list of people`, "invalidPerson", { property: prop.name });
      }
      const unique = [...new Set((raw as string[]).map((v) => v.trim()).filter(Boolean))];
      return unique.length ? unique : null;
    }
    case "multi_select": {
      const list = Array.isArray(value) ? value : [value];
      return list.map((v) => {
        const option = findOption(prop.options.options, v);
        if (!option) {
          throw new PropertyValueError(`"${v}" is not an option of "${prop.name}"`, "unknownOption", {
            value: String(v),
            property: prop.name,
          });
        }
        return option.id;
      });
    }
  }
}

/** Human-readable value (option names instead of ids), used by MCP output and markdown export. */
export function displayValue(prop: PropertyDef, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  // A formula that fails on this row says why, in English (MCP clients read it).
  if (isErrorValue(value)) return { error: value.error.message };
  if (prop.type === "select" || prop.type === "status") return findOption(prop.options.options, value)?.name ?? null;
  if (prop.type === "checklist") {
    const items = asChecklist(value).map(({ text, checked }) => ({ text, checked }));
    return items.length ? items : null;
  }
  if (prop.type === "multi_select" && Array.isArray(value)) {
    return value.map((v) => findOption(prop.options.options, v)?.name).filter(Boolean);
  }
  if (prop.type === "files") {
    const files = asFiles(value).map(({ name, url }) => ({ name, url }));
    return files.length ? files : null;
  }
  return value;
}

export type RowLike = { id: string; title: string; properties: Record<string, unknown>; createdAt: Date; updatedAt: Date };

/** Special property ids understood by filters and sorts in addition to real property ids. */
export const TITLE_KEY = "title";
export const CREATED_KEY = "created_at";
export const UPDATED_KEY = "updated_at";

function rawValue(row: RowLike, key: string): unknown {
  if (key === TITLE_KEY) return row.title;
  if (key === CREATED_KEY) return row.createdAt.toISOString();
  if (key === UPDATED_KEY) return row.updatedAt.toISOString();
  return row.properties[key];
}

function isEmpty(v: unknown) {
  return v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0) || v === false;
}

/**
 * The calendar day (`YYYY-MM-DD`) of a timestamp in the local time zone: the viewer's in the
 * browser, the server's for MCP and published pages.
 */
export function localDay(value: unknown): string | null {
  if (typeof value !== "string" && !(value instanceof Date)) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The value filters compare: without ids of select options that no longer exist (they display
 * as empty), and timestamps as days, so "Created is Sep 27" works like a date filter.
 */
function liveValue(row: RowLike, key: string, prop: PropertyDef | undefined): unknown {
  const v = rawValue(row, key);
  if (prop && holdsTimestamp(prop.type)) return localDay(v);
  if (prop && isDerived(prop.type)) {
    const plain = derivedSortValue(v);
    if (derivedType(prop) === "date") return valueDay(plain);
    // Rollup percentages are fractions (0.25); filters compare the percent people see (25). So do
    // sums, averages… of a number property shown as a percentage.
    const rollup = prop.type === "rollup" ? prop.options.rollup : undefined;
    const percent = Boolean(rollup) && (rollupFormat(rollup?.function) === "percent" || isPercent(rollup?.number));
    return percent && typeof plain === "number" ? toPercentPoints(plain) : plain;
  }
  // So do numbers shown as percentages.
  if (prop?.type === "number" && isPercent(prop.options.number) && typeof v === "number") return toPercentPoints(v);
  if (!prop || !holdsOptions(prop.type)) return v;
  const known = (id: unknown) => (prop.options.options ?? []).some((o) => o.id === id);
  if (Array.isArray(v)) return v.filter(known);
  return known(v) ? v : null;
}

/**
 * A derived value as filters and sorts compare it: errors count as empty, lists (rollups showing
 * the related values) as their text.
 */
function derivedSortValue(v: unknown): unknown {
  if (isErrorValue(v)) return null;
  if (Array.isArray(v)) return v.map(String).join(", ");
  return v;
}

/**
 * The days a date filter compares a value by, or undefined for values that aren't dates. Date
 * properties may hold ranges and times (see lib/date-value); times, like created and edited times,
 * count on their day in the runtime's zone (the viewer's in the browser).
 */
function filterDays(row: RowLike, key: string, prop: PropertyDef | undefined): DaySpan | null | undefined {
  const v = rawValue(row, key);
  if (prop?.type === "date") return dateDays(v);
  if ((prop && holdsTimestamp(prop.type)) || (!prop && (key === CREATED_KEY || key === UPDATED_KEY))) return dateDays(localDay(v));
  if (prop && isDerived(prop.type) && derivedType(prop) === "date") {
    const plain = derivedSortValue(v);
    return dateDays(plain) ?? dateDays(valueDay(plain));
  }
  return undefined;
}

/**
 * Date rules match a value by the days it covers, so a range matches when any of its days does:
 * "is" the day falls within it, "is before" it starts before the day, "is after" it ends after
 * the day, "is within" a period it overlaps the period. A single day is a range of one day.
 */
function matchesDays(days: DaySpan | null, rule: FilterRule, now: Date): boolean {
  if (!days) return false;
  if (rule.op === "is_within") {
    const range = relativeDateRange(rule.value, rule.days, now);
    return Boolean(range && days.start <= dayNumber(range.end) && days.end >= dayNumber(range.start));
  }
  if (!isDay(rule.value)) return false;
  const day = dayNumber(rule.value);
  switch (rule.op) {
    case "equals":
      return days.start <= day && day <= days.end;
    case "not_equals":
      return !(days.start <= day && day <= days.end);
    case "lt":
      return days.start < day;
    case "gt":
      return days.end > day;
    default:
      return false;
  }
}

const DATE_OPS = new Set<FilterOp>(["is_within", "equals", "not_equals", "lt", "gt"]);

function matches(row: RowLike, rule: FilterRule, prop: PropertyDef | undefined, now: Date): boolean {
  if (DATE_OPS.has(rule.op)) {
    const days = filterDays(row, rule.propertyId, prop);
    if (days !== undefined) return rule.op === "not_equals" && !days ? true : matchesDays(days, rule, now);
  }
  const v = liveValue(row, rule.propertyId, prop);
  switch (rule.op) {
    case "is_within": {
      const day = valueDay(v);
      const range = relativeDateRange(rule.value, rule.days, now);
      return Boolean(day && range && day >= range.start && day <= range.end);
    }
    case "is_empty":
      return isEmpty(v);
    case "is_not_empty":
      return !isEmpty(v);
    case "contains": {
      const needle = String(rule.value ?? "").toLowerCase();
      if (Array.isArray(v)) return v.some((x) => String(x).toLowerCase() === needle);
      return String(v ?? "").toLowerCase().includes(needle);
    }
    case "equals":
      if (Array.isArray(v)) return v.includes(rule.value);
      return v === rule.value || String(v ?? "") === String(rule.value ?? "");
    case "not_equals":
      if (Array.isArray(v)) return !v.includes(rule.value);
      return String(v ?? "") !== String(rule.value ?? "");
    // Empty values never satisfy a comparison (otherwise "" < "5" would match every blank row).
    case "gt":
      if (isEmpty(v)) return false;
      return typeof v === "number" ? v > Number(rule.value) : String(v) > String(rule.value ?? "");
    case "lt":
      if (isEmpty(v)) return false;
      return typeof v === "number" ? v < Number(rule.value) : String(v) < String(rule.value ?? "");
  }
}

function compare(a: unknown, b: unknown): number {
  if (isEmpty(a) && isEmpty(b)) return 0;
  if (isEmpty(a)) return 1; // empties last regardless of direction
  if (isEmpty(b)) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

/**
 * A rule the editor has added but not filled in yet ("Status is …"). It filters nothing, so every
 * consumer (app, published page, MCP) shows the same rows while the user is still picking.
 */
export function isIncompleteFilter(rule: FilterRule) {
  if (rule.op === "is_within") {
    return !isRelativeDateRange(rule.value) || (rangeNeedsDays(rule.value) && !isDayCount(rule.days));
  }
  return filterNeedsValue(rule.op) && (rule.value === undefined || rule.value === null || rule.value === "");
}

/**
 * Who is looking at a view (person filters on "me" match their rows), the names of the people
 * rows hold, which person sorts order by, and when: relative date filters ("this week") count
 * from `now`'s local day, the current time when left out.
 */
export type ViewViewer = { viewerId?: string | null; people?: { id: string; name: string }[]; now?: Date };

/**
 * A person rule's value with "me" swapped for the viewer's id. Without a viewer (a published
 * page) "me" is nobody, so "contains me" matches no row.
 */
function resolveViewer(rule: FilterRule, prop: PropertyDef | undefined, viewerId: string | null | undefined): FilterRule {
  if (!prop || !holdsPeople(prop.type) || rule.value !== PERSON_ME) return rule;
  return { ...rule, value: viewerId ?? "\u0000nobody" };
}

export function applyView<T extends RowLike>(
  rows: T[],
  {
    filters = [],
    filterCombinator,
    sorts = [],
  }: { filters?: FilterEntry[]; filterCombinator?: FilterCombinator; sorts?: SortRule[] },
  props: PropertyDef[] = [],
  { viewerId, people = [], now = new Date() }: ViewViewer = {},
): T[] {
  const byId = new Map(props.map((p) => [p.id, p]));
  const nameOf = new Map(people.map((p) => [p.id, p.name]));
  // Select sorts compare option order, not option ids (status options are stored in group order);
  // checkboxes sort unchecked < checked; checklists by the share of ticked items; people by their
  // names in the order they were added, so the first person counts most.
  const sortValue = (row: T, key: string) => {
    const prop = byId.get(key);
    const v = rawValue(row, key);
    if (prop && isDerived(prop.type)) return derivedSortValue(v);
    const index = (id: unknown) => prop?.options.options?.findIndex((o) => o.id === id) ?? -1;
    if (prop?.type === "status") {
      const option = prop.options.options?.find((o) => o.id === v);
      return option ? STATUS_GROUPS.indexOf(statusGroupOf(option)) * 100_000 + index(v) : null;
    }
    if (prop?.type === "checklist") {
      const progress = checklistProgress(v);
      return progress ? progress.done / progress.total : null;
    }
    if (prop?.type === "select") {
      const i = index(v);
      return i === -1 ? null : i;
    }
    if (prop?.type === "multi_select") {
      const indices = (Array.isArray(v) ? v.map(index) : []).filter((i) => i !== -1).sort((a, b) => a - b);
      return indices.length ? indices.map((i) => String(i).padStart(4, "0")).join(",") : null;
    }
    if (prop?.type === "checkbox") return v === true ? 1 : 0;
    // Dates sort by where they start: days and times on one timeline, a whole day before its times.
    if (prop?.type === "date") return dateSortKey(v);
    // Files sort by how many a row holds; rows without any go last.
    if (prop?.type === "files") return asFiles(v).length || null;
    if (prop && holdsPeople(prop.type)) {
      const names = (Array.isArray(v) ? v : []).flatMap((id) => {
        const name = typeof id === "string" ? nameOf.get(id) : undefined;
        return name ? [name] : [];
      });
      return names.length ? names.join("\u0000") : null;
    }
    return v;
  };
  const test = compileFilters<T>(
    pruneFilters(filters, (rule) => !isIncompleteFilter(rule)),
    filterCombinator,
    (rule) => {
      const prop = byId.get(rule.propertyId);
      const resolved = resolveViewer(rule, prop, viewerId);
      return (row) => matches(row, resolved, prop, now);
    },
  );
  const filtered = test ? rows.filter(test) : rows;
  if (!sorts.length) return filtered;
  return [...filtered].sort((a, b) => {
    for (const s of sorts) {
      const va = sortValue(a, s.propertyId);
      const vb = sortValue(b, s.propertyId);
      const bothPresent = !isEmpty(va) && !isEmpty(vb);
      const c = compare(va, vb) * (bothPresent && s.direction === "desc" ? -1 : 1);
      if (c !== 0) return c;
    }
    return 0;
  });
}

/** Message keys (`database.filter.ops.*`) for filter operator labels. */
export type FilterOpLabel =
  | "contains"
  | "doesNotContain"
  | "is"
  | "isNot"
  | "isEmpty"
  | "isNotEmpty"
  | "equals"
  | "notEquals"
  | "greaterThan"
  | "lessThan"
  | "isBefore"
  | "isAfter"
  | "isChecked"
  | "isUnchecked"
  | "isWithin";

/**
 * Filter operators offered per property type (`title` is the implicit Name column). `label` is a
 * message key under `database.filter.ops`, translated by the UI.
 */
export function filterOperators(type: PropertyType | "title"): { op: FilterOp; label: FilterOpLabel }[] {
  const empty = [
    { op: "is_empty" as const, label: "isEmpty" as const },
    { op: "is_not_empty" as const, label: "isNotEmpty" as const },
  ];
  switch (type) {
    case "title":
    case "text":
    case "url":
    case "email":
    case "phone":
      return [
        { op: "contains", label: "contains" },
        { op: "equals", label: "is" },
        { op: "not_equals", label: "isNot" },
        ...empty,
      ];
    case "number":
      return [
        { op: "equals", label: "equals" },
        { op: "not_equals", label: "notEquals" },
        { op: "gt", label: "greaterThan" },
        { op: "lt", label: "lessThan" },
        ...empty,
      ];
    case "select":
    case "status":
      return [{ op: "equals", label: "is" }, { op: "not_equals", label: "isNot" }, ...empty];
    case "multi_select":
    case "relation":
    case "person":
    case "created_by":
    case "last_edited_by":
      return [{ op: "contains", label: "contains" }, { op: "not_equals", label: "doesNotContain" }, ...empty];
    case "checklist":
    case "files":
      return empty;
    case "date":
    case "created_time":
    case "last_edited_time":
      return [
        { op: "equals", label: "is" },
        { op: "lt", label: "isBefore" },
        { op: "gt", label: "isAfter" },
        { op: "is_within", label: "isWithin" },
        ...empty,
      ];
    case "checkbox":
      // `false` counts as empty, so unchecked rows match whether or not they were ever touched.
      return [
        { op: "is_not_empty", label: "isChecked" },
        { op: "is_empty", label: "isUnchecked" },
      ];
    case "formula":
    case "rollup":
      // Callers pass a derived property's result type (see lib/derived valueType); text is the fallback.
      return filterOperators("text");
  }
}

/**
 * Values a new row needs so the view's filters keep showing it: "Status is Done" makes the
 * row Done, "Tags contains X" tags it X, "Done is checked" ticks it, "Due is
 * within this week" dates it today (every relative range includes today). Rules that can't be
 * satisfied by one value (not equals, before/after, empty…) are left alone.
 *
 * Only rules every visible row must satisfy count, i.e. those joined by "and". Rules inside an
 * "or" are skipped rather than taking its first branch: an "or" names alternatives, and writing
 * one of them into the row would be a value the user never asked for (the row may well match
 * another branch through its other values).
 */
export function defaultsFromFilters(
  filters: FilterEntry[] = [],
  props: PropertyDef[] = [],
  { viewerId, now = new Date() }: ViewViewer = {},
  filterCombinator?: FilterCombinator,
) {
  const out: Record<string, unknown> = {};
  const active = pruneFilters(filters, (rule) => !isIncompleteFilter(rule));
  for (const rule of requiredFilterRules(active, filterCombinator)) {
    const prop = props.find((p) => p.id === rule.propertyId);
    if (!prop || prop.id in out) continue;
    if (prop.type === "checkbox") {
      if (rule.op === "is_not_empty") out[prop.id] = true;
      continue;
    }
    if (isIncompleteFilter(rule)) continue;
    if (rule.op === "equals" && ["select", "status", "text", "number", "date"].includes(prop.type)) out[prop.id] = rule.value;
    else if (rule.op === "is_within" && prop.type === "date") out[prop.id] = dayString(now);
    else if (rule.op === "contains" && prop.type === "multi_select") out[prop.id] = [rule.value];
    else if (rule.op === "contains" && prop.type === "text") out[prop.id] = rule.value;
    else if (rule.op === "contains" && prop.type === "person") {
      // "Assignee contains me" assigns the new row to whoever creates it.
      const person = rule.value === PERSON_ME ? viewerId : rule.value;
      if (typeof person === "string" && person) out[prop.id] = [person];
    }
  }
  return out;
}

export function filterNeedsValue(op: FilterOp) {
  return op !== "is_empty" && op !== "is_not_empty";
}

/**
 * Property types a view can sort by (relations hold row ids, which have no meaningful order).
 * Files sort by how many a row holds (see applyView).
 */
export function isSortable(type: PropertyType | "title") {
  return type !== "relation";
}

/** A position strictly between two neighbours (either may be missing) for manual ordering. */
export function positionBetween(before?: number | null, after?: number | null): number {
  const hasBefore = typeof before === "number" && Number.isFinite(before);
  const hasAfter = typeof after === "number" && Number.isFinite(after);
  if (hasBefore && hasAfter) return (before + after) / 2;
  if (hasBefore) return before + 1;
  if (hasAfter) return after - 1;
  return 1;
}

export type RowGroup<T> = {
  /** Stable id of the group within its grouping: the option or person id, "" for no value. */
  key: string;
  /** The column's option; for person columns a stand-in carrying the person's id and name. */
  option: SelectOption | null;
  /** Set on person columns. */
  person?: GroupPerson;
  rows: T[];
};

export type GroupPerson = { id: string; name: string; active: boolean; isAgent?: true; agentIcon?: string | null };

/** Property types a view can group by (see lib/grouping for how each one buckets rows). */
export function isGroupable(type: PropertyType) {
  return (
    type === "select" ||
    type === "status" ||
    type === "multi_select" ||
    type === "checkbox" ||
    type === "date" ||
    type === "relation" ||
    holdsTimestamp(type) ||
    holdsPeople(type)
  );
}

/**
 * The property a board groups by: the view's choice, else the first select or status, else the
 * first people property, else the first other groupable one.
 */
export function boardGroupProperty<P extends { id: string; type: PropertyType }>(props: P[], groupBy?: string) {
  const groupable = props.filter((p) => isGroupable(p.type));
  return (
    groupable.find((p) => p.id === groupBy) ??
    groupable.find((p) => p.type === "select" || p.type === "status") ??
    groupable.find((p) => holdsPeople(p.type)) ??
    groupable[0]
  );
}

/**
 * Buckets rows by a person property: first the rows without anyone, then one column per person
 * in `people` order. A row assigned to several people shows in each of their columns. Former
 * members only get a column while someone is still assigned to them.
 */
export function groupRowsByPerson<T extends { properties: Record<string, unknown> }>(
  rows: T[],
  prop: { id: string },
  people: GroupPerson[],
): RowGroup<T>[] {
  const known = new Set(people.map((p) => p.id));
  const none: RowGroup<T> = { key: "", option: null, rows: [] };
  const byPerson = new Map(people.map((p) => [p.id, [] as T[]]));
  for (const row of rows) {
    const value = row.properties[prop.id];
    const ids = Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && known.has(id)) : [];
    if (!ids.length) none.rows.push(row);
    for (const id of new Set(ids)) byPerson.get(id)!.push(row);
  }
  const groups = people
    .filter((p) => p.active || byPerson.get(p.id)!.length)
    .map((person) => ({
      key: person.id,
      option: { id: person.id, name: person.name, color: "gray" },
      person,
      rows: byPerson.get(person.id)!,
    }));
  return [none, ...groups];
}

/** People added to person properties by a change, leaving out whoever made it (they know). */
export function newAssignees(
  personProps: { id: string }[],
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  /** Null when nobody made it (an anonymous form answer): then everyone added counts. */
  actorId: string | null,
) {
  const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return personProps.flatMap((prop) => {
    const was = ids(before[prop.id]);
    return ids(after[prop.id])
      .filter((id) => id !== actorId && !was.includes(id))
      .map((userId) => ({ propertyId: prop.id, userId }));
  });
}

/**
 * A person value after dragging its card from one person's column (`from`, null for the no-person
 * column) to another's (`to`): `to` takes `from`'s place, everyone else stays. Dropping on the
 * no-person column unassigns everyone, so the card really lands there.
 */
export function movePersonValue(value: unknown, from: string | null | undefined, to: string | null | undefined): string[] {
  if (!to) return [];
  const ids = Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  if (ids.includes(to)) return from ? ids.filter((id) => id !== from) : ids;
  const at = from ? ids.indexOf(from) : -1;
  if (at === -1) return [...ids, to];
  return ids.map((id, i) => (i === at ? to : id));
}

/**
 * Buckets rows by a select or status property: first a group for rows without a (known) value,
 * then one group per option in option order (status options by group first). Row order within
 * each group is preserved.
 */
export function groupRows<T extends { properties: Record<string, unknown> }>(
  rows: T[],
  prop: { id: string; type?: PropertyType; options: PropertyOptions },
): RowGroup<T>[] {
  const options = prop.type === "status" ? sortStatusOptions(prop.options.options ?? []) : (prop.options.options ?? []);
  const groups: RowGroup<T>[] = options.map((option) => ({ key: option.id, option, rows: [] }));
  const none: RowGroup<T> = { key: "", option: null, rows: [] };
  const index = new Map(options.map((o, i) => [o.id, i]));
  for (const row of rows) {
    const value = row.properties[prop.id];
    const i = typeof value === "string" ? index.get(value) : undefined;
    (i === undefined ? none : groups[i]).rows.push(row);
  }
  return [none, ...groups];
}

/**
 * Board and gallery cards stay short: long text and numbers start hidden there until the user
 * shows them. List rows and timeline bars are one line, so every property starts hidden there;
 * so it does in charts, which show properties only in the rows behind a bar and when published.
 * Other views show every property unless hidden.
 */
export function hiddenByDefault(viewType: ViewType, propType: PropertyType): boolean {
  if (viewType === "list" || viewType === "timeline" || viewType === "chart") return true;
  return (viewType === "board" || viewType === "gallery") && (propType === "text" || propType === "number");
}

export function isHiddenInView(
  view: { type: ViewType; config: Pick<ViewConfig, "hidden" | "shown"> },
  prop: { id: string; type: PropertyType },
): boolean {
  if (view.config.hidden?.includes(prop.id)) return true;
  return hiddenByDefault(view.type, prop.type) && !view.config.shown?.includes(prop.id);
}

/** The config after flipping one property between shown and hidden. */
export function toggleHiddenInView(
  view: { type: ViewType; config: ViewConfig },
  prop: { id: string; type: PropertyType },
): ViewConfig {
  const hide = !isHiddenInView(view, prop);
  const hidden = (view.config.hidden ?? []).filter((id) => id !== prop.id);
  const shown = (view.config.shown ?? []).filter((id) => id !== prop.id);
  if (hide) hidden.push(prop.id);
  else if (hiddenByDefault(view.type, prop.type)) shown.push(prop.id);
  return { ...view.config, hidden, shown };
}

/**
 * The config after hiding (or showing) every property in `props` at once. Ids of properties not
 * listed (ones the viewer can't see) keep their setting; the Name column is never among them.
 */
export function setAllHiddenInView(
  view: { type: ViewType; config: ViewConfig },
  props: { id: string; type: PropertyType }[],
  hide: boolean,
): ViewConfig {
  const ids = new Set(props.map((p) => p.id));
  const hidden = (view.config.hidden ?? []).filter((id) => !ids.has(id));
  const shown = (view.config.shown ?? []).filter((id) => !ids.has(id));
  if (hide) hidden.push(...props.map((p) => p.id));
  else shown.push(...props.filter((p) => hiddenByDefault(view.type, p.type)).map((p) => p.id));
  return { ...view.config, hidden, shown };
}

/** Puts groups in the view's saved order; groups it doesn't list keep their relative order at the end. */
export function orderGroups<G extends { key: string }>(groups: G[], order: string[] | undefined): G[] {
  if (!order?.length) return groups;
  const rank = new Map(order.map((key, i) => [key, i]));
  const keyed = groups.map((g, i) => ({ g, i, r: rank.get(g.key) }));
  keyed.sort((a, b) => {
    if (a.r !== undefined && b.r !== undefined) return a.r - b.r;
    if (a.r !== undefined) return -1;
    if (b.r !== undefined) return 1;
    return a.i - b.i;
  });
  return keyed.map((k) => k.g);
}

/**
 * Puts properties in the view's saved column order. Properties it doesn't list (added since the
 * order was saved) follow at the end in their database order, next to where "add property" is.
 */
export function orderProperties<P extends { id: string }>(properties: P[], order: string[] | undefined): P[] {
  if (!order?.length) return properties;
  const rank = new Map(order.map((id, i) => [id, i]));
  const at = (p: P) => rank.get(p.id) ?? order.length;
  return properties
    .map((p, i) => ({ p, i }))
    .sort((a, b) => at(a.p) - at(b.p) || a.i - b.i)
    .map(({ p }) => p);
}

/**
 * The column order after dragging `movedId` next to `targetId` (before or after it). `properties`
 * is every property in the view's current order, hidden ones included, so they keep their place.
 */
export function moveProperty(
  properties: { id: string }[],
  movedId: string,
  targetId: string,
  side: "before" | "after",
): string[] {
  return moveBeside(
    properties.map((p) => p.id),
    movedId,
    targetId,
    side,
  );
}

import type { listAutomationRunsAction, listAutomationsAction } from "@/app/actions/automations";
import type { FilterCombinator, FilterEntry, SortRule } from "@/db/schema/app";
import { nextScheduledRun, parseAutomationSchedule, type ScheduleFrequency } from "@/lib/automation-schedule";
import { badTemplates, hasTemplate, TEMPLATE_ROOTS } from "@/lib/automation-templates";
import {
  FOR_EACH_TYPES,
  hasRow,
  isDynamicValue,
  MAX_APPROVAL_DAYS,
  MAX_DATE_PASSED_DAYS,
  MAX_EXAMPLE_PAYLOAD,
  MAX_FOUND_ROWS,
  MAX_HTTP_BODY,
  MAX_WAIT_MINUTES,
  ROW_STEP_TYPES,
  STEP_ID,
  stepIds,
  trashProblem,
  UNSETTABLE_TYPES,
  type AutomationAction,
  type AutomationActionType,
  type AutomationTrigger,
  type AutomationTriggerType,
  type ApprovalTimeout,
  type HttpMethod,
} from "@/lib/automations";
import { fromPercentPoints, isPercent, toPercentPoints } from "@/lib/number-format";
import type { StatusGroup } from "@/lib/property-types";
import { browserTimeZone } from "@/lib/time-zone";
import type { Property, SelectOption } from "./types";

type Ok<T> = T extends { ok: true; data: infer D } ? D : never;

export type AutomationsData = Ok<Awaited<ReturnType<typeof listAutomationsAction>>>;
export type Automation = AutomationsData["automations"][number];
export type AutomationRun = Ok<Awaited<ReturnType<typeof listAutomationRunsAction>>>[number];
/** An agent a "Run an agent" action can pick (the workspace's, not archived). */
export type AgentChoice = AutomationsData["agents"][number];

/** Someone an automation can notify or assign: the workspace's people. */
export type Person = { id: string; name: string; email: string | null; image?: string | null };

/** Property types the editor can set a value of (relations, files and checklists stay out for now). */
export const EDITABLE_TYPES = [
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
  "person",
] as const;

/** Property types a step sets from a template only (`{{find.rows}}` links the rows it found). */
export const TEMPLATE_ONLY_TYPES = ["relation"] as const;

export const canSet = (prop: Property) => (EDITABLE_TYPES as readonly string[]).includes(prop.type);

/** Properties a step can give a value: the editable ones, and those set from a template only. */
export const canFill = (prop: Property) => canSet(prop) || (TEMPLATE_ONLY_TYPES as readonly string[]).includes(prop.type);

/** Properties a trigger can watch: the ones a row write changes (not computed ones). */
export const canWatch = (prop: Property) => !(UNSETTABLE_TYPES as readonly string[]).includes(prop.type);

/** People properties a notification can go to (see holdsPeople). */
export const namesPeopleType = (type: string) => type === "person" || type === "created_by" || type === "last_edited_by";

export const optionsOf = (prop: Property | undefined): SelectOption[] => prop?.options?.options ?? [];

/**
 * One value a step sets, as edited: a stored value (a number as stored, or as typed), a dynamic
 * value, or text with templates.
 */
export type SetEntry = { propertyId: string; value: unknown };

export type WaitUnit = "minutes" | "hours" | "days";
export const WAIT_UNITS: Record<WaitUnit, number> = { minutes: 1, hours: 60, days: 1440 };

/** A schedule as edited: every frequency's fields are kept, so switching between them loses nothing. */
export type DraftSchedule = { frequency: ScheduleFrequency; time: string; weekdays: number[]; days: number[]; cron: string };

/** A request header as edited (`key` only tells the rows apart). */
export type DraftHeader = { key: string; name: string; value: string };

/**
 * A step as edited. `id` is what later steps' templates call it by; `forEach` the id of an earlier
 * find_rows step the step goes over ("" for none). Numbers and JSON stay text until saved.
 */
export type DraftAction = { key: string; id: string } & (
  | { type: "set_properties"; entries: SetEntry[]; forEach: string }
  | { type: "notify"; people: string[]; properties: string[]; message: string; forEach: string }
  | { type: "webhook"; url: string }
  | { type: "run_agent"; agentId: string; prompt: string; forEach: string }
  | { type: "move_to_trash" }
  | { type: "http_request"; method: HttpMethod; url: string; headers: DraftHeader[]; body: string }
  | {
      type: "find_rows";
      databaseId: string;
      filters: FilterEntry[];
      filterCombinator: FilterCombinator;
      sorts: SortRule[];
      limit: string;
    }
  /** `template`: "" for a blank row, else lib/automations DEFAULT_ROW_TEMPLATE or a template's id. */
  | { type: "create_row"; databaseId: string; title: string; entries: SetEntry[]; template: string }
  /** `matchProperty`: "title" or a property id of the database. */
  | { type: "upsert_row"; databaseId: string; matchProperty: string; matchValue: string; title: string; entries: SetEntry[] }
  | { type: "wait"; amount: string; unit: WaitUnit }
  | { type: "log"; message: string }
  | { type: "celebrate" }
  | { type: "start_sequence"; sequenceId: string; forEach: string }
  /** `timeoutDays` as typed. */
  | { type: "approval"; people: string[]; properties: string[]; message: string; timeoutDays: string; onTimeout: ApprovalTimeout }
  /**
   * `url`: a new address as typed ("" keeps the saved one, which only shows as `hint`); `savedId`:
   * the id the step was saved with, whose address it keeps when renamed.
   */
  | { type: "slack"; url: string; hint: string; savedId: string; message: string }
);

export type DraftActionOf<T extends AutomationActionType> = Extract<DraftAction, { type: T }>;

export type DraftTrigger =
  | { type: "row_created" }
  /** `properties`: none for any property; `to` only with one. */
  | { type: "property_changed"; properties: string[]; to?: string | boolean }
  /**
   * `date`: a date property's id, "created_time" or "last_edited_time" ("" until chosen); `days` as
   * typed; `status`: the status property and groups, or null for every row.
   */
  | { type: "date_passed"; date: string; days: string; status: { property: string; groups: StatusGroup[] } | null }
  | { type: "schedule"; schedule: DraftSchedule }
  /** `example`: a body as JSON text, for the variable picker and test runs. */
  | { type: "incoming_webhook"; example: string };

export type Draft = { name: string; enabled: boolean; trigger: DraftTrigger; actions: DraftAction[] };

let keys = 0;
export const newKey = () => `a${++keys}`;

/** The id a new step of a type gets, as the server would give it: its type's stem, then `_2`, `_3`… */
const ID_STEMS: Record<AutomationActionType, string> = {
  set_properties: "set",
  notify: "notify",
  webhook: "webhook",
  run_agent: "agent",
  move_to_trash: "trash",
  http_request: "http",
  find_rows: "find",
  create_row: "create",
  upsert_row: "upsert",
  wait: "wait",
  log: "log",
  celebrate: "celebrate",
  start_sequence: "follow_up",
  approval: "approval",
  slack: "slack",
};

export function newStepId(type: AutomationActionType, taken: string[]) {
  const stem = ID_STEMS[type];
  let id = stem;
  for (let n = 2; taken.includes(id); n++) id = `${stem}_${n}`;
  return id;
}

/** Whether a step can go "for each" found row. */
export const goesForEach = (type: AutomationActionType) => (FOR_EACH_TYPES as readonly string[]).includes(type);

/** A step that acts on the run's row (see needsRow): it needs "for each" in a run without one. */
export function needsRowDraft(action: DraftAction) {
  if ((ROW_STEP_TYPES as readonly string[]).includes(action.type)) return !("forEach" in action && action.forEach);
  if (action.type === "notify") return !action.forEach && action.properties.length > 0;
  if (action.type === "approval") return action.properties.length > 0;
  return false;
}

export const forEachOfDraft = (action: DraftAction) => ("forEach" in action ? action.forEach : "");

/** The database a step's values go to: the found rows' for "for each", the step's own, or the automation's. */
export function targetDatabase(actions: DraftAction[], action: DraftAction, databaseId: string) {
  if (action.type === "create_row" || action.type === "upsert_row" || action.type === "find_rows") return action.databaseId;
  const over = forEachOfDraft(action);
  const source = over ? actions.find((a) => a.id === over) : undefined;
  return source?.type === "find_rows" ? source.databaseId : databaseId;
}

/** The editor's starting value for a property set to something. */
export function initialValue(prop: Property): unknown {
  switch (prop.type) {
    case "checkbox":
      return true;
    case "date":
      return { $: "now" };
    case "person":
    case "multi_select":
      return [];
    default:
      return "";
  }
}

export const defaultSchedule = (): DraftSchedule => ({ frequency: "daily", time: "09:00", weekdays: [1], days: [1], cron: "0 9 * * 1-5" });

function toDraftTrigger(stored: AutomationTrigger): DraftTrigger {
  if (stored.type === "row_created") return { type: "row_created" };
  if (stored.type === "date_passed") {
    return {
      type: "date_passed",
      date: stored.date,
      days: String(stored.days),
      status: stored.status ? { property: stored.status.propertyId, groups: stored.status.groups } : null,
    };
  }
  if (stored.type === "schedule") {
    const s = stored.schedule;
    return {
      type: "schedule",
      schedule: {
        ...defaultSchedule(),
        frequency: s.frequency,
        ...(s.frequency === "cron" ? { cron: s.cron } : { time: s.time }),
        ...(s.frequency === "weekly" ? { weekdays: s.weekdays } : {}),
        ...(s.frequency === "monthly" ? { days: s.days } : {}),
      },
    };
  }
  if (stored.type === "incoming_webhook") {
    return { type: "incoming_webhook", example: stored.example === undefined ? "" : JSON.stringify(stored.example, null, 2) };
  }
  const properties = stored.propertyIds?.length ? stored.propertyIds : stored.propertyId ? [stored.propertyId] : [];
  return {
    type: "property_changed",
    properties,
    ...(properties.length === 1 && stored.to !== undefined && stored.to !== null ? { to: stored.to } : {}),
  };
}

/** Values of a step as edited; values of properties the current database deleted are left out. */
const entriesOf = (values: Record<string, unknown>, keep: (id: string) => boolean): SetEntry[] =>
  Object.entries(values)
    .filter(([id]) => keep(id))
    .map(([propertyId, value]) => ({ propertyId, value }));

/** The minutes of a wait step in the largest unit that holds them whole. */
function waitOf(minutes: number): { amount: string; unit: WaitUnit } {
  if (minutes % WAIT_UNITS.days === 0) return { amount: String(minutes / WAIT_UNITS.days), unit: "days" };
  if (minutes % WAIT_UNITS.hours === 0) return { amount: String(minutes / WAIT_UNITS.hours), unit: "hours" };
  return { amount: String(minutes), unit: "minutes" };
}

/**
 * Stored steps and trigger as the editor edits them: the draft when there is one, else the
 * published version. Values of properties this database deleted are left out.
 */
export function toDraft(automation: Automation, properties: Property[]): Draft {
  const has = (id: string) => properties.some((p) => p.id === id);
  const definition = automation.draft ?? automation;
  const ids = stepIds(definition.actions);
  const actions = definition.actions.map((action: AutomationAction, i): DraftAction => {
    const base = { key: newKey(), id: ids[i] };
    // Steps on found rows or other databases set their properties; only this one's are known here.
    const own = (forEach?: string) => (forEach ? () => true : has);
    switch (action.type) {
      case "set_properties":
        return { ...base, type: "set_properties", entries: entriesOf(action.values, own(action.forEach)), forEach: action.forEach ?? "" };
      case "notify":
        return {
          ...base,
          type: "notify",
          people: action.userIds,
          properties: action.forEach ? action.propertyIds : action.propertyIds.filter(has),
          message: action.message ?? "",
          forEach: action.forEach ?? "",
        };
      case "run_agent":
        return { ...base, type: "run_agent", agentId: action.agentId, prompt: action.prompt, forEach: action.forEach ?? "" };
      case "move_to_trash":
        return { ...base, type: "move_to_trash" };
      case "http_request":
        return {
          ...base,
          type: "http_request",
          method: action.method,
          url: action.url,
          headers: action.headers.map((h) => ({ key: newKey(), name: h.name, value: h.value })),
          body: action.body === undefined ? "" : JSON.stringify(action.body, null, 2),
        };
      case "find_rows":
        return {
          ...base,
          type: "find_rows",
          databaseId: action.databaseId,
          filters: action.filters ?? [],
          filterCombinator: action.filterCombinator ?? "and",
          sorts: action.sorts ?? [],
          limit: String(action.limit),
        };
      case "create_row":
        return {
          ...base,
          type: "create_row",
          databaseId: action.databaseId,
          title: action.title ?? "",
          entries: entriesOf(action.values, () => true),
          template: action.template ?? "",
        };
      case "upsert_row":
        return {
          ...base,
          type: "upsert_row",
          databaseId: action.databaseId,
          matchProperty: action.matchPropertyId,
          matchValue: action.matchValue,
          title: action.title ?? "",
          entries: entriesOf(action.values, () => true),
        };
      case "wait":
        return { ...base, type: "wait", ...waitOf(action.minutes) };
      case "log":
        return { ...base, type: "log", message: action.message };
      case "celebrate":
        return { ...base, type: "celebrate" };
      case "webhook":
        return { ...base, type: "webhook", url: action.url };
      case "slack":
        return { ...base, type: "slack", url: "", hint: action.hint, savedId: ids[i], message: action.message };
      case "start_sequence":
        return { ...base, type: "start_sequence", sequenceId: action.sequenceId, forEach: action.forEach ?? "" };
      case "approval":
        return {
          ...base,
          type: "approval",
          people: action.userIds,
          properties: action.propertyIds.filter(has),
          message: action.message,
          timeoutDays: String(action.timeoutDays),
          onTimeout: action.onTimeout,
        };
    }
  });
  return { name: automation.name, enabled: automation.enabled, trigger: toDraftTrigger(definition.trigger), actions };
}

/** A new step of a type, with its id; it goes over the last found rows when it must (see needsRowDraft). */
export function newAction(type: AutomationActionType, actions: DraftAction[], trigger: DraftTrigger, databaseId: string): DraftAction {
  const base = { key: newKey(), id: newStepId(type, actions.map((a) => a.id)) };
  const finds = actions.filter((a) => a.type === "find_rows");
  // Without a row to act on, a row step goes over the rows found last.
  const forEach = !hasRow(trigger) && finds.length && goesForEach(type) ? finds[finds.length - 1].id : "";
  switch (type) {
    case "set_properties":
      return { ...base, type, entries: [], forEach };
    case "notify":
      return { ...base, type, people: [], properties: [], message: "", forEach };
    case "run_agent":
      return { ...base, type, agentId: "", prompt: "", forEach };
    case "move_to_trash":
      return { ...base, type };
    case "http_request":
      return { ...base, type, method: "POST", url: "", headers: [], body: "" };
    case "find_rows":
      return { ...base, type, databaseId, filters: [], filterCombinator: "and", sorts: [], limit: "20" };
    case "create_row":
      return { ...base, type, databaseId, title: "", entries: [], template: "" };
    case "upsert_row":
      return { ...base, type, databaseId, matchProperty: "title", matchValue: "", title: "", entries: [] };
    case "wait":
      return { ...base, type, amount: "1", unit: "hours" };
    case "log":
      return { ...base, type, message: "" };
    case "celebrate":
      return { ...base, type };
    case "webhook":
      return { ...base, type, url: "" };
    case "slack":
      return { ...base, type, url: "", hint: "", savedId: "", message: "" };
    case "start_sequence":
      return { ...base, type, sequenceId: "", forEach };
    case "approval":
      return { ...base, type, people: [], properties: [], message: "", timeoutDays: String(MAX_APPROVAL_DAYS), onTimeout: "stop" };
  }
}

/** A "date passed" trigger's days as typed, when they are a valid count. */
export function draftDays(days: string): number | null {
  const n = Number(days.trim());
  return days.trim() && Number.isInteger(n) && n >= 0 && n <= MAX_DATE_PASSED_DAYS ? n : null;
}

/** A whole number as typed between `min` and `max`, or null. */
export function wholeNumber(text: string, min: number, max: number): number | null {
  const n = Number(text.trim());
  return text.trim() && Number.isInteger(n) && n >= min && n <= max ? n : null;
}

/** A wait step's minutes as typed, or null when they aren't 1 minute to seven days. */
export const waitMinutes = (action: DraftActionOf<"wait">) => {
  const amount = Number(action.amount.trim());
  const minutes = Math.round(amount * WAIT_UNITS[action.unit]);
  return action.amount.trim() && Number.isFinite(amount) && amount > 0 && minutes >= 1 && minutes <= MAX_WAIT_MINUTES ? minutes : null;
};

/** JSON text as typed: its value, undefined when empty, or an error. */
export function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  if (!text.trim()) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** A schedule as the server takes it. */
export function scheduleInput(schedule: DraftSchedule) {
  switch (schedule.frequency) {
    case "daily":
      return { frequency: "daily" as const, time: schedule.time };
    case "weekly":
      return { frequency: "weekly" as const, time: schedule.time, weekdays: [...schedule.weekdays].sort((a, b) => a - b) };
    case "monthly":
      return { frequency: "monthly" as const, time: schedule.time, days: [...schedule.days].sort((a, b) => a - b) };
    case "cron":
      return { frequency: "cron" as const, cron: schedule.cron.trim() };
  }
}

/** When a schedule as edited next runs in the browser's zone; null when it isn't valid or never comes. */
export function nextRun(schedule: DraftSchedule, now = new Date()) {
  const parsed = parseAutomationSchedule(scheduleInput(schedule));
  return parsed ? nextScheduledRun(parsed, browserTimeZone(), now) : null;
}

export const emptyDraft = (): Draft => ({
  name: "",
  enabled: true,
  trigger: { type: "row_created" },
  actions: [{ key: newKey(), id: "notify", type: "notify", people: [], properties: [], message: "", forEach: "" }],
});

/** A message key of `automations.form.errors`, and the step it is about, if any. */
export type DraftProblem = { problem: string; step: string | null };

/** Values a step sets that are empty where the property needs one. */
function valuesProblem(entries: SetEntry[], props: Property[] | undefined, required: boolean) {
  if (required && !entries.length) return "needProperty";
  for (const { propertyId, value } of entries) {
    // Another database's properties load later; the server checks them then.
    if (!props) continue;
    const prop = props.find((p) => p.id === propertyId);
    if (!prop) return "needProperty";
    if (isDynamicValue(value) || hasTemplate(value)) continue;
    if (badTemplates(value).length) return "badTemplate";
    const empty = Array.isArray(value) ? !value.length : value === "" || value === null || value === undefined;
    if (empty && ["select", "status", "multi_select", "person", "date", "number", "relation"].includes(prop.type)) return "needValue";
  }
  return null;
}

/** Text a step saves that holds a template that isn't one (`{{}}`, `{{a[}}`). */
const badText = (...texts: string[]) => texts.some((text) => badTemplates(text).length > 0);

/** What a draft is missing before it can be saved (see DraftProblem). */
export function draftProblem(
  draft: Draft,
  properties: Property[],
  /** Another database's properties, once loaded. */
  schemaOf: (databaseId: string) => Property[] | undefined,
  databaseId: string,
): DraftProblem | null {
  const whole = (problem: string): DraftProblem => ({ problem, step: null });
  if (!draft.name.trim()) return whole("needName");
  const trigger = draft.trigger;
  if (trigger.type === "date_passed") {
    if (!trigger.date) return whole("needDate");
    if (draftDays(trigger.days) === null) return whole("needDays");
    if (trigger.status && (!trigger.status.property || !trigger.status.groups.length)) return whole("needGroups");
  }
  if (trigger.type === "schedule") {
    const s = trigger.schedule;
    if (s.frequency === "weekly" && !s.weekdays.length) return whole("needWeekdays");
    if (s.frequency === "monthly" && !s.days.length) return whole("needMonthDays");
    if (!parseAutomationSchedule(scheduleInput(s))) return whole(s.frequency === "cron" ? "badCron" : "badTime");
    if (!nextRun(s)) return whole("neverRuns");
  }
  if (trigger.type === "incoming_webhook") {
    const example = parseJson(trigger.example);
    if (!example.ok) return whole("badExample");
    if (example.value !== undefined && JSON.stringify(example.value).length > MAX_EXAMPLE_PAYLOAD) return whole("exampleTooLong");
  }
  if (!draft.actions.length) return whole("needAction");
  const trash = trashProblem(draft.actions);
  if (trash) return whole(trash);
  const seen: string[] = [];
  for (const action of draft.actions) {
    const at = (problem: string): DraftProblem => ({ problem, step: action.id || "?" });
    if (!STEP_ID.test(action.id) || (TEMPLATE_ROOTS as readonly string[]).includes(action.id)) return at("badStepId");
    if (seen.includes(action.id)) return at("duplicateStepId");
    const over = forEachOfDraft(action);
    if (over && !draft.actions.slice(0, draft.actions.indexOf(action)).some((a) => a.id === over && a.type === "find_rows")) {
      return at("forEachGone");
    }
    if (!hasRow(trigger) && needsRowDraft(action)) return at("needForEach");
    const props = schemaOf(targetDatabase(draft.actions, action, databaseId)) ?? (over ? undefined : properties);
    let problem: string | null = null;
    switch (action.type) {
      case "set_properties":
        problem = valuesProblem(action.entries, props, true);
        break;
      case "notify":
        if (!action.people.length && !action.properties.length) problem = "needPeople";
        else if (badText(action.message)) problem = "badTemplate";
        break;
      case "run_agent":
        if (!action.agentId) problem = "needAgent";
        else if (badText(action.prompt)) problem = "badTemplate";
        break;
      case "webhook":
        if (!action.url.trim()) problem = "needUrl";
        break;
      case "slack":
        if (!action.url.trim() && !action.hint) problem = "needSlackUrl";
        else if (badText(action.message)) problem = "badTemplate";
        break;
      case "http_request": {
        const body = parseJson(action.body);
        if (!action.url.trim()) problem = "needUrl";
        else if (action.headers.some((h) => !h.name.trim() && h.value.trim())) problem = "needHeaderName";
        else if (!body.ok) problem = "invalidJson";
        else if (body.value !== undefined && JSON.stringify(body.value).length > MAX_HTTP_BODY) problem = "bodyTooLong";
        else if (badText(action.url, action.body, ...action.headers.map((h) => h.value))) problem = "badTemplate";
        break;
      }
      case "find_rows":
        if (!action.databaseId) problem = "needDatabase";
        else if (wholeNumber(action.limit, 1, MAX_FOUND_ROWS) === null) problem = "needLimit";
        break;
      case "create_row":
      case "upsert_row":
        if (!action.databaseId) problem = "needDatabase";
        else if (action.type === "upsert_row" && !action.matchProperty) problem = "needMatch";
        else if (action.type === "upsert_row" && !action.matchValue.trim()) problem = "needMatchValue";
        else if (badText(action.title, action.type === "upsert_row" ? action.matchValue : "")) problem = "badTemplate";
        else problem = valuesProblem(action.entries, schemaOf(action.databaseId), false);
        break;
      case "wait":
        if (waitMinutes(action) === null) problem = "needWait";
        break;
      case "log":
        if (!action.message.trim()) problem = "needMessage";
        else if (badText(action.message)) problem = "badTemplate";
        break;
      case "start_sequence":
        if (!action.sequenceId) problem = "needSequence";
        break;
      case "approval":
        if (!action.people.length && !action.properties.length) problem = "needApprovers";
        else if (wholeNumber(action.timeoutDays, 1, MAX_APPROVAL_DAYS) === null) problem = "needTimeout";
        else if (badText(action.message)) problem = "badTemplate";
        break;
    }
    if (problem) return at(problem);
    seen.push(action.id);
  }
  return null;
}

/** Whether a property is a number shown as a percentage: its values are typed in percent points. */
function percentOf(properties: Property[] | undefined, id: string) {
  const prop = properties?.find((p) => p.id === id);
  return prop?.type === "number" && isPercent(prop.options.number);
}

/** A stored number as the editor shows it: a percentage's fraction as its points. */
export const shownNumber = (prop: Property, value: number) => String(prop.type === "number" && isPercent(prop.options.number) ? toPercentPoints(value) : value);

/** A typed value as the server takes it: trimmed, a percentage's points as the fraction; templates as written. */
function typedValue(properties: Property[] | undefined, propertyId: string, value: unknown) {
  if (typeof value !== "string") return value;
  if (hasTemplate(value)) return value;
  const text = (value as string).trim();
  const n = Number(text);
  return text && Number.isFinite(n) && percentOf(properties, propertyId) ? fromPercentPoints(n) : text;
}

/** Values of a step as the server takes them, by property id. */
export const valuesOf = (entries: SetEntry[], props: Property[] | undefined) =>
  Object.fromEntries(entries.map((e) => [e.propertyId, typedValue(props, e.propertyId, e.value)]));

/** A draft's trigger as the server takes it. */
export function triggerInput(trigger: DraftTrigger) {
  switch (trigger.type) {
    case "row_created":
      return { type: "row_created" as const };
    case "date_passed":
      return {
        type: "date_passed" as const,
        date: trigger.date,
        days: draftDays(trigger.days) ?? 0,
        status: trigger.status ? { property: trigger.status.property, groups: trigger.status.groups } : null,
      };
    case "schedule":
      return { type: "schedule" as const, schedule: scheduleInput(trigger.schedule) };
    case "incoming_webhook": {
      const example = parseJson(trigger.example);
      return { type: "incoming_webhook" as const, ...(example.ok && example.value !== undefined ? { example: example.value } : {}) };
    }
    case "property_changed":
      return {
        type: "property_changed" as const,
        properties: trigger.properties,
        to: trigger.properties.length === 1 ? (trigger.to ?? null) : null,
      };
  }
}

/** A draft's steps as the server takes them (properties, people and databases by id). */
export function actionsInput(draft: Draft, properties: Property[], schemaOf: (databaseId: string) => Property[] | undefined, databaseId: string) {
  return draft.actions.map((action) => {
    const id = action.id;
    const props = schemaOf(targetDatabase(draft.actions, action, databaseId)) ?? properties;
    const forEach = "forEach" in action && action.forEach ? { forEach: action.forEach } : {};
    switch (action.type) {
      case "set_properties":
        return { id, type: "set_properties" as const, values: valuesOf(action.entries, props), ...forEach };
      case "notify":
        return { id, type: "notify" as const, people: action.people, properties: action.properties, message: action.message.trim(), ...forEach };
      case "run_agent":
        return { id, type: "run_agent" as const, agent: action.agentId, prompt: action.prompt.trim(), ...forEach };
      case "move_to_trash":
        return { id, type: "move_to_trash" as const };
      case "http_request": {
        const body = parseJson(action.body);
        return {
          id,
          type: "http_request" as const,
          method: action.method,
          url: action.url.trim(),
          headers: action.headers.filter((h) => h.name.trim()).map((h) => ({ name: h.name.trim(), value: h.value })),
          ...(body.ok && body.value !== undefined ? { body: body.value } : {}),
        };
      }
      case "find_rows":
        return {
          id,
          type: "find_rows" as const,
          database: action.databaseId,
          filters: action.filters,
          filterCombinator: action.filterCombinator,
          sorts: action.sorts,
          limit: wholeNumber(action.limit, 1, MAX_FOUND_ROWS) ?? 20,
        };
      case "create_row":
        return {
          id,
          type: "create_row" as const,
          database: action.databaseId,
          title: action.title.trim(),
          values: valuesOf(action.entries, schemaOf(action.databaseId)),
          ...(action.template ? { template: action.template } : {}),
        };
      case "upsert_row":
        return {
          id,
          type: "upsert_row" as const,
          database: action.databaseId,
          match: { property: action.matchProperty, value: action.matchValue.trim() },
          title: action.title.trim(),
          values: valuesOf(action.entries, schemaOf(action.databaseId)),
        };
      case "wait":
        return { id, type: "wait" as const, minutes: waitMinutes(action) ?? 1 };
      case "log":
        return { id, type: "log" as const, message: action.message.trim() };
      case "celebrate":
        return { id, type: "celebrate" as const };
      case "webhook":
        return { id, type: "webhook" as const, url: action.url.trim() };
      case "slack":
        return {
          id,
          type: "slack" as const,
          message: action.message.trim(),
          // Left out, the address stays the saved step's, which the browser never had.
          ...(action.url.trim() ? { url: action.url.trim() } : { urlFrom: action.savedId || id }),
        };
      case "start_sequence":
        return { id, type: "start_sequence" as const, sequence: action.sequenceId, ...forEach };
      case "approval":
        return {
          id,
          type: "approval" as const,
          people: action.people,
          properties: action.properties,
          message: action.message.trim(),
          timeoutDays: wholeNumber(action.timeoutDays, 1, MAX_APPROVAL_DAYS) ?? MAX_APPROVAL_DAYS,
          onTimeout: action.onTimeout,
        };
    }
  });
}

/** A draft as the server takes it (properties and people by id). */
export function toInput(draft: Draft, properties: Property[], schemaOf: (databaseId: string) => Property[] | undefined, databaseId: string) {
  return {
    name: draft.name.trim(),
    enabled: draft.enabled,
    // Whoever saves it: a "date passed" trigger counts days, and a schedule runs, in their time zone.
    timeZone: browserTimeZone(),
    trigger: triggerInput(draft.trigger),
    actions: actionsInput(draft, properties, schemaOf, databaseId),
  };
}

/** The webhook addresses of stored steps, to tell whether a draft changed them. */
export const webhookUrls = (actions: AutomationAction[] | DraftAction[]) =>
  (actions as (AutomationAction | DraftAction)[]).flatMap((a) => (a.type === "webhook" ? [a.url.trim()] : [])).join("\n");

/**
 * A step's id renamed, and every reference to it in later steps: their templates and "for each".
 * Templates are matched on their first part (`{{find.rows}}`, `{{ find["a b"] }}`).
 */
export function renameStep(actions: DraftAction[], from: string, to: string): DraftAction[] {
  const pattern = new RegExp(`(\\{\\{\\s*)${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s*(?:\\}\\}|[.[]))`, "g");
  const rewrite = (value: unknown): unknown => {
    if (typeof value === "string") return value.replace(pattern, `$1${to}`);
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewrite(v)]));
    return value;
  };
  return actions.map((action) => {
    if (action.id === from) return { ...action, id: to };
    const { key, id, ...rest } = action;
    const next = rewrite(rest) as Omit<DraftAction, "key" | "id">;
    return { ...next, key, id, ...("forEach" in action && action.forEach === from ? { forEach: to } : {}) } as DraftAction;
  });
}

/** Steps after a move or a removal: a "for each" over a step that no longer comes before it is let go. */
export function keepForEachValid(actions: DraftAction[]): DraftAction[] {
  return actions.map((action, i) => {
    if (!("forEach" in action) || !action.forEach) return action;
    const ok = actions.slice(0, i).some((a) => a.id === action.forEach && a.type === "find_rows");
    return ok ? action : { ...action, forEach: "" };
  });
}

/** The trigger's value as a word: an option's, a person's name, or checked/unchecked. */
export function triggerValueName(
  to: string | boolean | null | undefined,
  prop: Property | undefined,
  people: Person[],
  checkedLabels: { checked: string; unchecked: string },
) {
  if (to === undefined || to === null) return null;
  if (typeof to === "boolean") return to ? checkedLabels.checked : checkedLabels.unchecked;
  if (prop?.type === "person") return people.find((p) => p.id === to)?.name ?? "?";
  return optionsOf(prop).find((o) => o.id === to)?.name ?? "?";
}

/** Trigger types in the order the editor offers them. */
export const TRIGGER_CHOICES: AutomationTriggerType[] = ["row_created", "property_changed", "date_passed", "schedule", "incoming_webhook"];

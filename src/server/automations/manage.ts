import { and, asc, count, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import {
  automationRun,
  automationThreshold,
  automationVersion,
  databaseAutomation,
  databaseView,
  page,
  user,
  workspaceAgent,
  type AutomationDefinition,
} from "@/db/schema";
import { emailSequence } from "@/db/schema/sequences";
import { hasAgentLevel } from "@/lib/agent-sharing";
import { MAX_AGENT_PROMPT } from "@/lib/agents";
import { nextScheduledRun, parseAutomationSchedule } from "@/lib/automation-schedule";
import { badTemplates, hasTemplate, TEMPLATE_ROOTS, templateRoots } from "@/lib/automation-templates";
import {
  agentTargets,
  APPROVAL_TIMEOUTS,
  cleanRowTemplate,
  FOR_EACH_TYPES,
  hasActor,
  hasRow,
  HTTP_METHODS,
  isDynamicValue,
  MAX_APPROVAL_DAYS,
  MAX_APPROVERS,
  MAX_AUTOMATION_ACTIONS,
  MAX_AUTOMATION_NAME,
  MAX_AUTOMATIONS,
  MAX_DATE_PASSED_DAYS,
  MAX_EXAMPLE_PAYLOAD,
  MAX_FOUND_ROWS,
  MAX_HTTP_BODY,
  MAX_HTTP_HEADERS,
  MAX_NOTIFY_PEOPLE,
  MAX_STEP_MESSAGE,
  MAX_THRESHOLD,
  MAX_WAIT_MINUTES,
  MAX_WEBHOOK_URL,
  needsRow,
  runEvent,
  STEP_ID,
  THRESHOLD_COMPARISONS,
  THRESHOLD_FNS,
  thresholdMet,
  TO_VALUE_TYPES,
  trashProblem,
  UNSETTABLE_TYPES,
  watchedProperties,
  type AutomationAction,
  type AutomationActionType,
  type AutomationRunStatus,
  type AutomationStep,
  type AutomationTrigger,
  type DatePassedTrigger,
  type HttpMethod,
  type RunOrigin,
  type ThresholdComparison,
  type ThresholdFn,
  type ThresholdTrigger,
} from "@/lib/automations";
import { chartAggregateFunctionsOf } from "@/lib/chart";
import { filterConfigError, filterRules } from "@/lib/filters";
import { pageLabel } from "@/lib/labels";
import { PropertyValueError } from "@/lib/properties";
import { holdsPeople, STATUS_GROUPS, type StatusGroup } from "@/lib/property-types";
import { isTimeZone } from "@/lib/time-zone";
import type { FilterCombinator, FilterEntry, SortRule } from "@/db/schema/app";
import { getMembership, pageVisibleTo } from "@/server/access";
import { slackUrlHint, slackWebhookUrl } from "@/lib/slack";
import { LinkPreviewError } from "@/server/link-preview";
import { recordAudit } from "@/server/audit";
import { releaseDatabaseFromAgents, shareDatabaseWithAgents } from "@/server/agents/manage";
import { agentLevel } from "@/server/agents/sharing";
import { getProperties, normalizeRowProperties, requireDatabase } from "@/server/databases";
import { seal } from "@/server/secret-box";
import { rowTemplateInput } from "@/server/templates";
import { latestMeeting } from "@/server/meeting-triggers";
import { exportAllowed, workspacePeople } from "@/server/workspaces";
import { checkHeader, HttpStepError, parseRequestUrl } from "./http";
import { hookUrl, newHookSalt } from "./incoming";
import { kickAutomations } from "./queue";
import { forHistory } from "./run";
import { nextRunOf } from "./scheduled";
import { armThreshold, readThreshold, thresholdData } from "./threshold";
import { automationZone, countDatePassedMatches, forgetFired } from "./timed";
import { allowedHost, newSecretSalt, parseWebhookUrl, sendWebhook, WebhookError, webhookSecret, webhookTarget } from "./webhook";

/**
 * Managing a database's automations. Only people with full access to the database see or change
 * them (as with its properties' access rules): an automation acts with its publisher's access, and
 * its webhooks and requests send data out of the workspace. Publishing one makes the publisher the
 * person it runs as.
 *
 * An automation's trigger and steps change in a draft: saving a change to a published automation
 * keeps it there (`publish: false`) until it is published, and "Test run" runs the draft once,
 * with real effects, marked as a test. Publishing makes it the next version; runs under way keep
 * the version they started with. MCP and other callers publish as they save unless they ask for a
 * draft.
 *
 * Input names properties by id or (case-insensitive) name, and people by id, email, name or "me",
 * so MCP clients can write them as they read them; what is stored is ids only.
 */

type ValuesInput = Record<string, unknown>;

/** A step as typed: properties and people by id or name (see above). Every step may carry an `id`. */
export type AutomationActionInput = (
  | { type: "set_properties"; values: ValuesInput; forEach?: string | null }
  | { type: "notify"; people?: string[]; properties?: string[]; message?: string | null; forEach?: string | null }
  | { type: "webhook"; url: string }
  /** The agent by id or name; the task it's given. */
  | { type: "run_agent"; agent: string; prompt?: string; forEach?: string | null }
  | { type: "move_to_trash" }
  | { type: "http_request"; method?: string; url: string; headers?: { name: string; value: string }[] | Record<string, string>; body?: unknown }
  /** `database` by id or title; filters and sorts as a view stores them (property ids). */
  | { type: "find_rows"; database: string; filters?: FilterEntry[]; filterCombinator?: FilterCombinator; sorts?: SortRule[]; limit?: number }
  /** `template`: a row template of the database by id, or "default" for its default one (lib/automations). */
  | { type: "create_row"; database: string; title?: string | null; values?: ValuesInput; template?: string | null }
  /** `match.property`: "title" or a property of the database, by name or id. */
  | { type: "upsert_row"; database: string; match: { property: string; value: string }; title?: string | null; values?: ValuesInput }
  | { type: "wait"; minutes: number }
  | { type: "log"; message: string }
  | { type: "celebrate" }
  /** The sequence by id or name, of the database the step acts on. */
  | { type: "start_sequence"; sequence: string; forEach?: string | null }
  /** People by id, email, name or "me"; person properties by name or id; `timeoutDays` 1 to 30 (30 when left out). */
  | { type: "approval"; people?: string[]; properties?: string[]; message?: string | null; timeoutDays?: number; onTimeout?: string; forEach?: string | null }
  /**
   * `url`: the Slack incoming webhook's address. Left out, the step keeps the address of the saved
   * Slack step `urlFrom` (its own id when not given), which is never shown.
   */
  | { type: "slack"; url?: string | null; message?: string | null; urlFrom?: string | null }
) & { id?: string | null };

/** An automation as typed: properties and people by id or name (see above). */
export type AutomationInput = {
  name: string;
  enabled?: boolean;
  /**
   * The saver's IANA time zone, which a "date passed" trigger counts days in and a schedule runs
   * in: UTC for a new automation without one; an update without one keeps the stored zone.
   */
  timeZone?: string;
  trigger:
    /** `filled`: wait until a row added without a title was filled in. */
    | { type: "row_created"; filled?: boolean }
    /** `property` for one, `properties` for several (no `to` then); neither for any property. */
    | { type: "property_changed"; property?: string | null; properties?: string[] | null; to?: unknown }
    /**
     * `date`: a date property, or "created_time" / "last_edited_time" (a created or edited time
     * property names those too). `status`: the status property (the database's only one when left
     * out) and the groups its value is in.
     */
    | { type: "date_passed"; date: string; days: number; status?: { property?: string | null; groups: string[] } | null }
    | { type: "schedule"; schedule: unknown }
    /** `example`: a body to offer in the variable picker and test runs (JSON, or JSON text). */
    | { type: "incoming_webhook"; example?: unknown }
    /**
     * `view`: a shared view of the database (id or name); `calculation`: count_all (the default)
     * or a calculation over `property`, a number (or a number formula or rollup).
     */
    | { type: "view_threshold"; view: string; calculation?: string; property?: string | null; comparison: string; value: number }
    /** `property`: a button property of the database (id or name). */
    | { type: "button_clicked"; property: string }
    | { type: "meeting_summarized" };
  actions: AutomationActionInput[];
};

/** How a save goes: published at once (the default), or kept as a draft of the automation. */
export type SaveOptions = { publish?: boolean };

type Prop = Awaited<ReturnType<typeof getProperties>>[number];

const invalid = (message: string, params: Record<string, string> = {}) =>
  new PropertyValueError(message, "invalidAutomation", { reason: message, ...params });

function checkTimeZone(value: unknown, fallback: string) {
  if (value === undefined) return fallback;
  if (!isTimeZone(value)) throw invalid("Unknown time zone: give an IANA name such as Europe/Istanbul");
  return value;
}

function findProperty(props: Prop[], ref: string) {
  const prop = props.find((p) => p.id === ref) ?? props.find((p) => p.name.toLowerCase() === ref.trim().toLowerCase());
  if (!prop) {
    throw new PropertyValueError(
      `Unknown property "${ref}". Available: ${props.map((p) => `${p.name} (${p.type})`).join(", ") || "none"}`,
      "unknownProperty",
      { property: ref },
    );
  }
  return prop;
}

/** A "date passed" trigger as typed, checked: the date property or time, the days, the status condition. */
function checkDatePassed(props: Prop[], input: Extract<AutomationInput["trigger"], { type: "date_passed" }>): DatePassedTrigger {
  const ref = typeof input.date === "string" ? input.date.trim() : "";
  if (!ref) throw invalid('"date" is a date property, "created_time" or "last_edited_time"');
  let date: string;
  if (ref === "created_time" || ref === "last_edited_time") date = ref;
  else {
    const prop = findProperty(props, ref);
    if (prop.type === "created_time" || prop.type === "last_edited_time") date = prop.type;
    else if (prop.type !== "date") throw invalid(`"${prop.name}" is a ${prop.type} property: count from a date property, or when the row was added or last edited`);
    else date = prop.id;
  }
  const days = input.days;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 0 || days > MAX_DATE_PASSED_DAYS) {
    throw invalid(`"days" is a whole number from 0 to ${MAX_DATE_PASSED_DAYS}`);
  }
  if (!input.status) return { type: "date_passed", date, days, status: null };
  const groups = [...new Set(Array.isArray(input.status.groups) ? input.status.groups : [])];
  if (!groups.length || groups.some((g) => !(STATUS_GROUPS as readonly string[]).includes(g))) {
    throw invalid(`A status condition names one or more of the groups ${STATUS_GROUPS.join(", ")}`);
  }
  let status: Prop;
  if (input.status.property) {
    status = findProperty(props, input.status.property);
    if (status.type !== "status") throw invalid(`"${status.name}" is not a status property`);
  } else {
    const statuses = props.filter((p) => p.type === "status");
    if (statuses.length !== 1) {
      throw invalid(statuses.length ? "Name the status property the condition is about" : "This database has no status property");
    }
    status = statuses[0];
  }
  // Every group is no condition at all.
  if (groups.length === STATUS_GROUPS.length) return { type: "date_passed", date, days, status: null };
  return {
    type: "date_passed",
    date,
    days,
    status: { propertyId: status.id, groups: STATUS_GROUPS.filter((g) => groups.includes(g)) as StatusGroup[] },
  };
}

/** A threshold trigger as typed, checked: a shared view of the database, the calculation and the line. */
async function checkThreshold(
  databaseId: string,
  props: Prop[],
  input: Extract<AutomationInput["trigger"], { type: "view_threshold" }>,
): Promise<ThresholdTrigger> {
  const ref = typeof input.view === "string" ? input.view.trim() : "";
  if (!ref) throw invalid('"view" is a view of the database, by id or name');
  const views = await db
    .select({ id: databaseView.id, name: databaseView.name })
    .from(databaseView)
    // Shared views only: a personal one is gone for whoever publishes the automation next.
    .where(and(eq(databaseView.databaseId, databaseId), isNull(databaseView.deletedAt), isNull(databaseView.ownerId)));
  const view = views.find((v) => v.id === ref) ?? views.find((v) => v.name.trim().toLowerCase() === ref.toLowerCase());
  if (!view) throw invalid(`No shared view "${ref}" in this database. Views: ${views.map((v) => v.name).join(", ") || "none"}`);
  const fn = input.calculation ?? "count_all";
  if (!(THRESHOLD_FNS as readonly string[]).includes(fn)) throw invalid(`"calculation" is one of ${THRESHOLD_FNS.join(", ")}`);
  let propertyId: string | null = null;
  if (fn !== "count_all") {
    if (!input.property) throw invalid(`"${fn}" calculates over a number property: name it in "property"`);
    const prop = findProperty(props, input.property);
    if (!chartAggregateFunctionsOf(prop).includes(fn as ThresholdFn)) throw invalid(`"${prop.name}" holds no numbers to calculate "${fn}" over`);
    propertyId = prop.id;
  }
  if (!(THRESHOLD_COMPARISONS as readonly string[]).includes(input.comparison)) throw invalid('"comparison" is "above" or "below"');
  const value = input.value;
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > MAX_THRESHOLD) {
    throw invalid(`"value" is a number from -${MAX_THRESHOLD} to ${MAX_THRESHOLD}`);
  }
  return { type: "view_threshold", viewId: view.id, fn: fn as ThresholdFn, propertyId, comparison: input.comparison as ThresholdComparison, value };
}

/** Only a person's change has someone to set as "actor": not a date passing, a schedule or a request. */
function checkActorFits(trigger: AutomationTrigger, actions: AutomationAction[]) {
  if (hasActor(trigger)) return;
  const actor = actions.some(
    (a) => a.type === "set_properties" && Object.values(a.values).some((v) => isDynamicValue(v) && v.$ === "actor"),
  );
  if (actor) throw invalid('"actor" is whoever made the change that started the automation, and nobody\'s change starts this one: name people instead');
}

/** An example body as typed: JSON, or JSON text; at most MAX_EXAMPLE_PAYLOAD as JSON text. */
function checkExample(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw invalid("The example body is not valid JSON");
    }
  }
  const text = JSON.stringify(parsed);
  if (text.length > MAX_EXAMPLE_PAYLOAD) throw invalid(`The example body may have at most ${MAX_EXAMPLE_PAYLOAD} characters of JSON`);
  return parsed;
}

async function checkTrigger(userId: string, databaseId: string, props: Prop[], input: AutomationInput["trigger"], timeZone: string): Promise<AutomationTrigger> {
  if (input?.type === "row_created") {
    if (input.filled !== undefined && typeof input.filled !== "boolean") throw invalid('"filled" is true or false');
    return input.filled ? { type: "row_created", filled: true } : { type: "row_created" };
  }
  if (input?.type === "date_passed") return checkDatePassed(props, input);
  if (input?.type === "schedule") {
    const schedule = parseAutomationSchedule(input.schedule);
    if (!schedule) {
      throw invalid(
        'A schedule is {"frequency": "daily", "time": "09:00"}, "weekly" with "weekdays" (0 for Sunday to 6), "monthly" with "days" (1 to 31), or {"frequency": "cron", "cron": "*/15 * * * *"}',
      );
    }
    if (!nextScheduledRun(schedule, automationZone(timeZone), new Date())) throw invalid("This cron expression never comes round");
    return { type: "schedule", schedule };
  }
  if (input?.type === "incoming_webhook") {
    const example = checkExample(input.example);
    return example === undefined ? { type: "incoming_webhook" } : { type: "incoming_webhook", example };
  }
  if (input?.type === "view_threshold") return checkThreshold(databaseId, props, input);
  if (input?.type === "meeting_summarized") return { type: "meeting_summarized" };
  if (input?.type === "button_clicked") {
    if (typeof input.property !== "string" || !input.property.trim()) throw invalid("A button trigger needs the button property");
    const prop = findProperty(props, input.property);
    if (prop.type !== "button") throw invalid(`"${prop.name}" is a ${prop.type} property, not a button`);
    return { type: "button_clicked", propertyId: prop.id };
  }
  if (input?.type !== "property_changed") {
    throw invalid(
      'The trigger is "row_created", "property_changed", "date_passed", "view_threshold", "schedule", "incoming_webhook", "button_clicked" or "meeting_summarized"',
    );
  }
  const refs = [...new Set([...(input.properties ?? []), ...(input.property ? [input.property] : [])].filter((r) => typeof r === "string" && r.trim()))];
  if (!refs.length) {
    if (input.to !== undefined && input.to !== null) throw invalid('"to" needs a property');
    return { type: "property_changed", propertyId: null };
  }
  const watched = [...new Set(refs.map((ref) => findProperty(props, ref).id))];
  if (watched.length > 1) {
    if (input.to !== undefined && input.to !== null && input.to !== "") throw invalid('"to" goes with one property, not several');
    return { type: "property_changed", propertyId: watched[0], propertyIds: watched };
  }
  const prop = props.find((p) => p.id === watched[0])!;
  if (input.to === undefined || input.to === null || input.to === "") return { type: "property_changed", propertyId: prop.id };
  if (!(TO_VALUE_TYPES as readonly string[]).includes(prop.type)) {
    throw invalid(`"${prop.name}" is a ${prop.type} property: only select, status, checkbox, person and multi-select properties take a value to change to`);
  }
  const normalized = (await normalizeRowProperties(userId, databaseId, { [prop.id]: input.to }, {}, { check: false, dependencies: false }))[prop.id];
  const to = Array.isArray(normalized) ? normalized[0] : normalized;
  if (typeof to !== "string" && typeof to !== "boolean") throw invalid(`"${prop.name}" needs a value to change to`);
  return { type: "property_changed", propertyId: prop.id, to };
}

/** A short id for a new step of a type: what later steps' templates call it by. */
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

/** Every step's id: the one given (checked), or a new one from its type. */
function checkIds(input: AutomationActionInput[]) {
  const given = input.map((a) => (typeof a?.id === "string" && a.id.trim() ? a.id.trim() : null));
  const taken = new Set<string>();
  for (const id of given) {
    if (id === null) continue;
    if (!STEP_ID.test(id)) throw invalid(`"${id}" is not a step id: lowercase letters, digits and _, starting with a letter, at most 32`);
    if ((TEMPLATE_ROOTS as readonly string[]).includes(id)) throw invalid(`"${id}" is kept for templates: give the step another id`);
    if (taken.has(id)) throw invalid(`Two steps have the id "${id}"`);
    taken.add(id);
  }
  return input.map((a, i) => {
    if (given[i]) return given[i]!;
    const stem = ID_STEMS[a?.type as AutomationActionType] ?? "step";
    let id = stem;
    for (let n = 2; taken.has(id); n++) id = `${stem}_${n}`;
    taken.add(id);
    return id;
  });
}

function checkText(value: unknown, what: string, max: number, required = false) {
  const text = typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
  if (required && !text.trim()) throw invalid(`${what} can't be empty`);
  if (text.length > max) throw invalid(`${what} may have at most ${max} characters`);
  const bad = badTemplates(text);
  if (bad.length) throw invalid(`${bad[0]} is not a template: write {{trigger.Property}} or {{step.path}}`);
  return text;
}

/** A database of the workspace `userId` can open at `level`, by id or title. */
async function checkDatabase(userId: string, workspaceId: string, ref: unknown, level: "view" | "edit") {
  const text = typeof ref === "string" ? ref.trim() : "";
  if (!text) throw invalid("Name the database the step works in");
  let id = text;
  const [byId] = await db.select({ id: page.id }).from(page).where(and(eq(page.id, text), eq(page.workspaceId, workspaceId), eq(page.kind, "database")));
  if (!byId) {
    const candidates = await db
      .select({ id: page.id, title: page.title })
      .from(page)
      .where(and(eq(page.workspaceId, workspaceId), eq(page.kind, "database"), isNull(page.archivedAt), eq(page.inTemplate, false), pageVisibleTo(userId)));
    const found = candidates.find((c) => pageLabel(c.title).toLowerCase() === text.toLowerCase());
    if (!found) throw invalid(`"${text}" is not a database of this workspace you can open`, { value: text });
    id = found.id;
  }
  let database;
  try {
    database = await requireDatabase(userId, id, level);
  } catch {
    throw invalid(level === "view" ? `You can't open the database "${text}"` : `You can't add rows to the database "${text}"`, { value: text });
  }
  if (database.workspaceId !== workspaceId || database.isTemplate || database.inTemplate) throw invalid(`"${text}" is not a database of this workspace`);
  return { id: database.id, props: await getProperties(database.id) };
}

/**
 * Values for a row of a database (`props`), by property name or id: stored values (checked as a
 * row write checks them), "now"/"actor", or text with templates (checked when it runs).
 */
async function checkValues(userId: string, databaseId: string, props: Prop[], input: unknown, required: boolean) {
  const literal: Record<string, unknown> = {};
  const values: Record<string, unknown> = {};
  for (const [ref, value] of Object.entries((input ?? {}) as Record<string, unknown>)) {
    const prop = findProperty(props, ref);
    if ((UNSETTABLE_TYPES as readonly string[]).includes(prop.type)) {
      throw new PropertyValueError(`"${prop.name}" is computed and can't be set`, "readOnlyProperty", { property: prop.name });
    }
    if (isDynamicValue(value)) {
      if (value.$ === "now" && prop.type !== "date") throw invalid(`"now" sets date properties; "${prop.name}" is a ${prop.type} property`);
      if (value.$ === "actor" && prop.type !== "person") throw invalid(`"actor" sets person properties; "${prop.name}" is a ${prop.type} property`);
      values[prop.id] = value;
    } else if (templateRoots(value).size || badTemplates(value).length) {
      const bad = badTemplates(value);
      if (bad.length) throw invalid(`${bad[0]} is not a template: write {{trigger.Property}} or {{step.path}}`);
      if (JSON.stringify(value).length > MAX_STEP_MESSAGE) throw invalid(`A value may have at most ${MAX_STEP_MESSAGE} characters`);
      values[prop.id] = value;
    } else literal[prop.id] = value;
  }
  Object.assign(values, await normalizeRowProperties(userId, databaseId, literal, {}, { dependencies: false }));
  if (required && !Object.keys(values).length) throw invalid("Setting properties needs at least one value");
  return values;
}

/**
 * Checks a request's address as saved: with no templates, fully (shape and blocklist; a host that
 * doesn't resolve yet may well later); with templates, that it starts with https:// (or http:// to an allowed host).
 */
async function checkRequestUrl(value: unknown) {
  const text = checkText(value, "The address", MAX_WEBHOOK_URL, true).trim();
  if (hasTemplate(text)) {
    const start = text.slice(0, text.indexOf("{{"));
    if (!/^https?:\/\/./i.test(start) && !/^https:\/\/$/i.test(start) && !/^http:\/\/$/i.test(start)) {
      throw invalid("A request's address starts with https:// before any template");
    }
    return text;
  }
  try {
    const url = parseRequestUrl(text);
    await webhookTarget(url);
    return url.toString();
  } catch (error) {
    if (error instanceof LinkPreviewError && error.code === "blocked") {
      throw new PropertyValueError(`Requests can't go to private or local addresses (${error.message})`, "webhookBlocked", {});
    }
    if (error instanceof LinkPreviewError && error.code === "unreachable") return parseRequestUrl(text).toString();
    if (error instanceof HttpStepError || error instanceof LinkPreviewError) throw invalid(error.message, { value: text });
    throw error;
  }
}

/**
 * The steps as typed, checked against the trigger: each step's own rules, templates that only use
 * the trigger and earlier steps, "for each" over an earlier find_rows step, and no step that needs
 * a row in a run without one. `current`: the steps as saved (published and draft), which anyone
 * who may change the automation may keep as they are (a webhook while export is off, an agent's
 * task only owners may write). `stored`: the saved steps a Slack step may keep the address of.
 */
async function checkActions(
  userId: string,
  databaseId: string,
  workspaceId: string,
  props: Prop[],
  input: AutomationActionInput[],
  trigger: AutomationTrigger,
  current: AutomationAction[] = [],
  stored: AutomationAction[] = current,
) {
  if (!Array.isArray(input) || !input.length) throw invalid("An automation needs at least one step");
  if (input.length > MAX_AUTOMATION_ACTIONS) throw invalid(`At most ${MAX_AUTOMATION_ACTIONS} steps`);
  const ids = checkIds(input);
  let people: Awaited<ReturnType<typeof workspacePeople>> | undefined;
  let owner: boolean | undefined;
  let exportOn: boolean | undefined;
  const exportAllowedOnce = async () => (exportOn ??= await exportAllowed(workspaceId));
  /** People by id, email, name or "me" (guests: by id only), as ids. */
  const personIds = async (refs: string[]) => {
    people ??= await workspacePeople(workspaceId);
    // Guests name people by id only, as in person properties (resolvePersonValue): matching an
    // address or a name would tell them who is in the workspace, and under which address.
    const byEmailOrName = people.find((p) => p.id === userId)?.role !== "guest";
    return [
      ...new Set(
        refs.map((ref) => {
          if (ref === "me") return userId;
          const needle = ref.trim().toLowerCase();
          const person =
            people!.find((p) => p.id === ref) ??
            (byEmailOrName ? (people!.find((p) => p.email.toLowerCase() === needle) ?? people!.find((p) => p.name.toLowerCase() === needle)) : undefined);
          if (!person) throw invalid(`"${ref}" is not in this workspace`, { value: ref });
          return person.id;
        }),
      ),
    ];
  };
  const personProperties = (of: Prop[], refs: string[]) => [
    ...new Set(
      refs.map((ref) => {
        const prop = findProperty(of, ref);
        if (!holdsPeople(prop.type)) throw invalid(`"${prop.name}" is not a person property`);
        return prop.id;
      }),
    ),
  ];
  const out: AutomationAction[] = [];
  /** The databases find_rows steps look in, by step id, with their properties. */
  const found = new Map<string, { id: string; props: Prop[] }>();
  for (const [i, action] of input.entries()) {
    const id = ids[i];
    const label = `Step "${id}"`;
    // "For each": over an earlier find_rows step's rows, for row steps only.
    const over = (action as { forEach?: unknown }).forEach;
    let target = { id: databaseId, props };
    let forEach: string | undefined;
    if (action?.type === "approval" && typeof over === "string" && over.trim()) {
      throw invalid(`${label}: an approval asks once for the whole run, so it can't go "for each" found row`);
    }
    if (typeof over === "string" && over.trim()) {
      if (!(FOR_EACH_TYPES as readonly string[]).includes(action.type)) throw invalid(`${label}: only setting properties, notifying, running an agent and starting a follow-up go "for each" found row`);
      const source = found.get(over.trim());
      if (!source) throw invalid(`${label} goes "for each" row of "${over}", which is no earlier step that finds rows`);
      target = source;
      forEach = over.trim();
    }
    let step: AutomationAction;
    if (action?.type === "set_properties") {
      step = { type: "set_properties", values: await checkValues(userId, target.id, target.props, action.values, true), ...(forEach ? { forEach } : {}) };
    } else if (action?.type === "notify") {
      const userIds = await personIds(action.people ?? []);
      const propertyIds = personProperties(target.props, action.properties ?? []);
      if (!userIds.length && !propertyIds.length) throw invalid("A notification needs people or a person property");
      if (userIds.length > MAX_NOTIFY_PEOPLE) throw invalid(`At most ${MAX_NOTIFY_PEOPLE} people`);
      const message = checkText(action.message, "A notification's message", MAX_STEP_MESSAGE).trim();
      step = { type: "notify", userIds, propertyIds, ...(message ? { message } : {}), ...(forEach ? { forEach } : {}) };
    } else if (action?.type === "webhook") {
      let url: URL;
      try {
        url = parseWebhookUrl(String(action.url ?? ""));
        await webhookTarget(url);
      } catch (error) {
        if (error instanceof LinkPreviewError && error.code === "blocked") {
          throw new PropertyValueError(`Webhooks can't go to private or local addresses (${error.message})`, "webhookBlocked", {});
        }
        // A host that doesn't resolve yet may well later: only the shape and the blocklist stop a save.
        if (error instanceof LinkPreviewError && error.code === "unreachable") url = parseWebhookUrl(String(action.url));
        else if (error instanceof WebhookError || error instanceof LinkPreviewError) {
          throw new PropertyValueError(`"${action.url}" is not a valid http(s) address`, "invalidWebhookUrl", { value: String(action.url ?? "") });
        } else throw error;
      }
      // A webhook sends rows out of the workspace: not while its owners have export turned off
      // (one already saved may stay, but sends nothing until export is back on; see run.ts).
      const kept = current.some((a) => a.type === "webhook" && a.url === url.toString());
      if (!kept && !(await exportAllowedOnce())) {
        throw new PropertyValueError("The workspace's owners turned export off, so automations can't send webhooks", "webhookExportOff", {});
      }
      step = { type: "webhook", url: url.toString() };
    } else if (action?.type === "run_agent") {
      const ref = String(action.agent ?? "").trim();
      const agents = await db
        .select({ id: workspaceAgent.id, name: workspaceAgent.name })
        .from(workspaceAgent)
        .where(and(eq(workspaceAgent.workspaceId, workspaceId), isNull(workspaceAgent.archivedAt)));
      const agent = agents.find((a) => a.id === ref) ?? agents.find((a) => a.name.toLowerCase() === ref.toLowerCase());
      if (!agent) throw invalid(`"${ref}" is not an agent of this workspace`, { value: ref });
      const prompt = checkText(typeof action.prompt === "string" ? action.prompt.trim() : "", "An agent's task", MAX_AGENT_PROMPT);
      // The task is written by whoever saves it and the agent may open pages they can't: only
      // those who choose what the agent may open (owners, and those who can edit the agent, see
      // agents/sharing.ts) give it tasks. Others may keep one as it is.
      const kept = current.some((a) => a.type === "run_agent" && a.agentId === agent.id && a.prompt === prompt && (a.forEach ?? null) === (forEach ?? null));
      if (!kept) {
        owner ??= (await getMembership(userId, workspaceId))?.role === "owner";
        if (!owner && !hasAgentLevel(await agentLevel(userId, { id: agent.id, workspaceId }), "edit")) {
          throw new PropertyValueError("Only owners of the workspace and those who can edit the agent add or change actions that run it", "agentOwnersOnly", {});
        }
      }
      step = { type: "run_agent", agentId: agent.id, prompt, ...(forEach ? { forEach } : {}) };
    } else if (action?.type === "move_to_trash") {
      step = { type: "move_to_trash" };
    } else if (action?.type === "http_request") {
      const method = String(action.method ?? "GET").toUpperCase() as HttpMethod;
      if (!HTTP_METHODS.includes(method)) throw invalid(`${label}: the method is one of ${HTTP_METHODS.join(", ")}`);
      const url = await checkRequestUrl(action.url);
      const headerList = Array.isArray(action.headers)
        ? action.headers
        : Object.entries(action.headers ?? {}).map(([name, value]) => ({ name, value: String(value) }));
      if (headerList.length > MAX_HTTP_HEADERS) throw invalid(`${label}: at most ${MAX_HTTP_HEADERS} headers`);
      const headers = headerList
        .filter((h) => String(h?.name ?? "").trim())
        .map((h) => {
          const name = String(h.name).trim();
          const value = checkText(h.value, `The "${name}" header`, MAX_STEP_MESSAGE);
          try {
            checkHeader(name, value.replace(/\{\{[^{}]*\}\}/g, "x"));
          } catch (error) {
            throw invalid(`${label}: ${(error as Error).message}`);
          }
          return { name, value };
        });
      let body = action.body;
      if (typeof body === "string") {
        // JSON text from a form; text that isn't JSON is sent as a JSON string.
        try {
          body = body.trim() ? JSON.parse(body) : undefined;
        } catch {
          throw invalid(`${label}: the body is not valid JSON (templates go inside strings: "{{trigger.id}}")`);
        }
      }
      if (body !== undefined && body !== null) {
        if (JSON.stringify(body).length > MAX_HTTP_BODY) throw invalid(`${label}: the body may have at most ${MAX_HTTP_BODY} characters`);
        const bad = badTemplates(body);
        if (bad.length) throw invalid(`${bad[0]} is not a template`);
      }
      // A request sends data out of the workspace: as webhooks, not while export is off.
      const kept = current.some((a) => a.type === "http_request" && a.url === url);
      if (!kept && !(await exportAllowedOnce())) {
        throw new PropertyValueError("The workspace's owners turned export off, so automations can't send requests", "webhookExportOff", {});
      }
      step = { type: "http_request", method, url, headers, ...(body !== undefined && body !== null ? { body } : {}) };
    } else if (action?.type === "find_rows") {
      const database = await checkDatabase(userId, workspaceId, action.database, "view");
      const filters = action.filters ?? [];
      const error = filterConfigError({ filters, filterCombinator: action.filterCombinator });
      if (error) throw invalid(`${label}: ${error}`);
      const known = new Set(["title", ...database.props.map((p) => p.id)]);
      const unknown = filterRules(filters).find((r) => !known.has(r.propertyId));
      if (unknown) throw invalid(`${label}: no property "${unknown.propertyId}" to filter on`);
      const sorts = (action.sorts ?? []).map((s) => {
        if (!known.has(s?.propertyId)) throw invalid(`${label}: no property "${s?.propertyId}" to sort by`);
        return { propertyId: s.propertyId, direction: s.direction === "desc" ? ("desc" as const) : ("asc" as const) };
      });
      const limit = action.limit ?? 20;
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_FOUND_ROWS) throw invalid(`${label}: finds 1 to ${MAX_FOUND_ROWS} rows`);
      if (badTemplates(filters).length) throw invalid(`${badTemplates(filters)[0]} is not a template`);
      step = {
        type: "find_rows",
        databaseId: database.id,
        filters,
        ...(action.filterCombinator ? { filterCombinator: action.filterCombinator } : {}),
        sorts,
        limit,
      };
      found.set(id, database);
    } else if (action?.type === "create_row" || action?.type === "upsert_row") {
      const database = await checkDatabase(userId, workspaceId, action.database, "edit");
      const values = await checkValues(userId, database.id, database.props, action.values, false);
      const title = checkText(action.title, "A row's title", MAX_STEP_MESSAGE).trim();
      if (action.type === "create_row") {
        const template = action.template ? cleanRowTemplate(action.template) : undefined;
        if (action.template && (!template || !(await rowTemplateInput(database.id, template)))) throw invalid(`${label}: no row template "${action.template}" in that database`);
        step = { type: "create_row", databaseId: database.id, ...(title ? { title } : {}), values, ...(template ? { template } : {}) };
      }
      else {
        const ref = String(action.match?.property ?? "").trim();
        if (!ref) throw invalid(`${label}: name the property a row is matched on ("title" for its title)`);
        const matchPropertyId = ref.toLowerCase() === "title" ? "title" : findProperty(database.props, ref).id;
        const matchProp = database.props.find((p) => p.id === matchPropertyId);
        if (matchProp && (UNSETTABLE_TYPES as readonly string[]).includes(matchProp.type)) throw invalid(`${label}: "${matchProp.name}" is computed and can't be matched on`);
        const matchValue = checkText(action.match?.value, `${label}: the value to match`, MAX_STEP_MESSAGE, true).trim();
        step = { type: "upsert_row", databaseId: database.id, matchPropertyId, matchValue, ...(title ? { title } : {}), values };
      }
    } else if (action?.type === "wait") {
      const minutes = action.minutes;
      if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 1 || minutes > MAX_WAIT_MINUTES) {
        throw invalid(`${label}: waits a whole number of minutes from 1 to ${MAX_WAIT_MINUTES} (seven days)`);
      }
      step = { type: "wait", minutes };
    } else if (action?.type === "log") {
      step = { type: "log", message: checkText(action.message, "A log message", MAX_STEP_MESSAGE, true).trim() };
    } else if (action?.type === "celebrate") {
      step = { type: "celebrate" };
    } else if (action?.type === "start_sequence") {
      const ref = String(action.sequence ?? "").trim();
      const sequences = await db.select({ id: emailSequence.id, name: emailSequence.name }).from(emailSequence).where(eq(emailSequence.databaseId, target.id));
      const sequence = sequences.find((s) => s.id === ref) ?? sequences.find((s) => s.name.toLowerCase() === ref.toLowerCase());
      if (!sequence) throw invalid(`${label}: "${ref}" is not a follow-up of the database it starts on`, { value: ref });
      step = { type: "start_sequence", sequenceId: sequence.id, ...(forEach ? { forEach } : {}) };
    } else if (action?.type === "approval") {
      const userIds = await personIds(action.people ?? []);
      const propertyIds = personProperties(props, action.properties ?? []);
      if (!userIds.length && !propertyIds.length) throw invalid(`${label}: an approval needs people to ask, or a person property whose people are asked`);
      if (userIds.length > MAX_APPROVERS) throw invalid(`${label}: at most ${MAX_APPROVERS} people`);
      const message = checkText(action.message, "An approval's message", MAX_STEP_MESSAGE).trim();
      const timeoutDays = action.timeoutDays ?? MAX_APPROVAL_DAYS;
      if (typeof timeoutDays !== "number" || !Number.isInteger(timeoutDays) || timeoutDays < 1 || timeoutDays > MAX_APPROVAL_DAYS) {
        throw invalid(`${label}: waits for an answer a whole number of days from 1 to ${MAX_APPROVAL_DAYS}`);
      }
      const onTimeout = action.onTimeout ?? "stop";
      if (!(APPROVAL_TIMEOUTS as readonly string[]).includes(onTimeout)) throw invalid(`${label}: on timeout, the run stops ("stop") or goes on ("continue")`);
      step = { type: "approval", userIds, propertyIds, message, timeoutDays, onTimeout: onTimeout as (typeof APPROVAL_TIMEOUTS)[number] };
    } else if (action?.type === "slack") {
      const message = checkText(action.message, "A Slack message", MAX_STEP_MESSAGE).trim();
      const typed = typeof action.url === "string" ? action.url.trim() : "";
      let sealed: string;
      let hint: string;
      if (typed) {
        const url = slackWebhookUrl(typed, (u) => allowedHost(u));
        if (!url) throw new PropertyValueError("Not a Slack incoming webhook address (https://hooks.slack.com/services/…)", "invalidSlackUrl", {});
        sealed = seal(url.toString());
        hint = slackUrlHint(url.toString());
      } else {
        const from = typeof action.urlFrom === "string" && action.urlFrom.trim() ? action.urlFrom.trim() : id;
        const saved = stored.find((a): a is Extract<AutomationAction, { type: "slack" }> => a.type === "slack" && a.id === from && !!a.sealed);
        if (!saved?.sealed) throw invalid(`${label}: give the Slack incoming webhook's address`);
        ({ sealed, hint } = { sealed: saved.sealed, hint: saved.hint });
      }
      // Slack gets the row's values: as webhooks, not while export is off (a saved address may stay).
      const kept = current.some((a) => a.type === "slack" && a.sealed === sealed);
      if (!kept && !(await exportAllowedOnce())) {
        throw new PropertyValueError("The workspace's owners turned export off, so automations can't send to Slack", "webhookExportOff", {});
      }
      step = { type: "slack", sealed, hint, message };
    } else {
      throw invalid(
        'Each step is "set_properties", "notify", "webhook", "run_agent", "move_to_trash", "http_request", "find_rows", "create_row", "upsert_row", "wait", "log", "celebrate", "approval", "start_sequence" or "slack"',
      );
    }
    step.id = id;
    // Templates use the trigger, the found row of a "for each", and earlier steps only.
    for (const root of templateRoots(step)) {
      if (root === "trigger") continue;
      if (root === "item") {
        if (!forEach) throw invalid(`${label} uses {{item…}}, which is the found row of a "for each" step`);
        continue;
      }
      const at = ids.indexOf(root);
      if (at === -1 || at >= i) throw invalid(`${label} uses {{${root}…}}, which is no earlier step`);
    }
    if (!hasRow(trigger) && needsRow(step)) {
      const kind = trigger.type === "schedule" ? "a schedule" : trigger.type === "view_threshold" ? "a threshold" : "an incoming webhook";
      if (step.type === "approval") throw invalid(`${label} asks the people a row names, and ${kind} has no row: name the people to ask`);
      throw invalid(`${label} acts on the row that started the automation, and ${kind} has none: find rows first and go "for each" of them`);
    }
    out.push(step);
  }
  const trash = trashProblem(out);
  if (trash === "trashNotLast") throw invalid("Moving the row to the trash is the last action: nothing can follow it");
  if (trash === "trashWithAgent") throw invalid("An agent can't run on a row the same automation moves to the trash");
  return out;
}

function checkName(name: unknown) {
  const text = typeof name === "string" ? name.trim() : "";
  if (!text) throw invalid("An automation needs a name");
  return text.slice(0, MAX_AUTOMATION_NAME);
}

type Automation = typeof databaseAutomation.$inferSelect;

/** The agents the actions run, on each database (see agentTargets). */
const targetsOf = (actions: AutomationAction[], databaseId: string) => agentTargets(actions, databaseId);

const auditDetails = (a: { name: string; enabled: boolean; trigger: AutomationTrigger; actions: AutomationAction[]; version?: number }) => ({
  name: a.name,
  enabled: a.enabled,
  trigger: a.trigger.type,
  actions: a.actions.map((x) => x.type).join(", "),
  webhooks:
    a.actions.flatMap((x) => (x.type === "webhook" || x.type === "http_request" ? [hostOf(x.url)] : x.type === "slack" ? [x.hint.split("/")[0]] : [])).join(", ") ||
    undefined,
  ...(a.version !== undefined ? { version: a.version } : {}),
});

const hostOf = (url: string) => {
  try {
    return new URL(url.replace(/\{\{[^{}]*\}\}/g, "x")).host;
  } catch {
    return "";
  }
};

/** Shares the databases the new steps run agents on with them, and takes back what the old ones no longer need. */
async function syncAgentShares(userId: string, databaseId: string, actions: AutomationAction[], previous: AutomationAction[]) {
  const next = targetsOf(actions, databaseId);
  const byDatabase = new Map<string, string[]>();
  for (const t of next) byDatabase.set(t.databaseId, [...(byDatabase.get(t.databaseId) ?? []), t.agentId]);
  for (const [target, agents] of byDatabase) await shareDatabaseWithAgents(userId, target, agents);
  for (const old of targetsOf(previous, databaseId)) {
    if (next.some((t) => t.agentId === old.agentId && t.databaseId === old.databaseId)) continue;
    await releaseDatabaseFromAgents(userId, old.databaseId, [old.agentId]).catch(() => undefined);
  }
}

/** Checks a whole definition as `userId` would save it. */
async function checkDefinition(
  userId: string,
  automation: { databaseId: string; workspaceId: string },
  input: { trigger: AutomationInput["trigger"]; actions: AutomationActionInput[]; timeZone: string },
  current: AutomationAction[],
  stored: AutomationAction[] = current,
): Promise<AutomationDefinition> {
  const props = await getProperties(automation.databaseId);
  const trigger = await checkTrigger(userId, automation.databaseId, props, input.trigger, input.timeZone);
  const actions = await checkActions(userId, automation.databaseId, automation.workspaceId, props, input.actions, trigger, current, stored);
  checkActorFits(trigger, actions);
  return { trigger, actions, timeZone: input.timeZone };
}

/** A stored step back as input, so a draft saved earlier can be checked again when published. */
function asInput(action: AutomationAction): AutomationActionInput {
  if (action.type === "notify") {
    return { id: action.id, type: "notify", people: action.userIds, properties: action.propertyIds, message: action.message, forEach: action.forEach };
  }
  if (action.type === "run_agent") return { id: action.id, type: "run_agent", agent: action.agentId, prompt: action.prompt, forEach: action.forEach };
  if (action.type === "start_sequence") return { id: action.id, type: "start_sequence", sequence: action.sequenceId, forEach: action.forEach };
  if (action.type === "approval") {
    return { id: action.id, type: "approval", people: action.userIds, properties: action.propertyIds, message: action.message, timeoutDays: action.timeoutDays, onTimeout: action.onTimeout };
  }
  if (action.type === "find_rows") {
    return { id: action.id, type: "find_rows", database: action.databaseId, filters: action.filters, filterCombinator: action.filterCombinator, sorts: action.sorts, limit: action.limit };
  }
  if (action.type === "create_row") return { id: action.id, type: "create_row", database: action.databaseId, title: action.title, values: action.values, template: action.template };
  if (action.type === "upsert_row") {
    return { id: action.id, type: "upsert_row", database: action.databaseId, match: { property: action.matchPropertyId, value: action.matchValue }, title: action.title, values: action.values };
  }
  // The address stays sealed: the step keeps the saved one.
  if (action.type === "slack") return { id: action.id, type: "slack", message: action.message, urlFrom: action.id };
  return action as AutomationActionInput;
}

function triggerAsInput(trigger: AutomationTrigger): AutomationInput["trigger"] {
  if (trigger.type === "property_changed") {
    return { type: "property_changed", properties: watchedProperties(trigger), ...(trigger.to !== undefined && trigger.to !== null ? { to: trigger.to } : {}) };
  }
  if (trigger.type === "date_passed") {
    return { type: "date_passed", date: trigger.date, days: trigger.days, status: trigger.status ? { property: trigger.status.propertyId, groups: trigger.status.groups } : null };
  }
  if (trigger.type === "view_threshold") {
    return { type: "view_threshold", view: trigger.viewId, calculation: trigger.fn, property: trigger.propertyId, comparison: trigger.comparison, value: trigger.value };
  }
  if (trigger.type === "button_clicked") return { type: "button_clicked", property: trigger.propertyId };
  return trigger as AutomationInput["trigger"];
}

/**
 * Makes `definition` the automation's next version, as `userId` (who it runs as from then on):
 * stored with the others, live for new runs, its schedule counted from now.
 */
/** Whether two triggers watch the same calculation against the same line (stored jsonb has its keys in another order). */
function sameThreshold(a: AutomationTrigger, b: AutomationTrigger) {
  if (a.type !== "view_threshold" || b.type !== "view_threshold") return false;
  return a.viewId === b.viewId && a.fn === b.fn && a.propertyId === b.propertyId && a.comparison === b.comparison && a.value === b.value;
}

async function publishDefinition(userId: string, current: Automation, definition: AutomationDefinition, extra: Partial<Automation> = {}) {
  const version = current.version + 1;
  const threshold = current.trigger.type === "view_threshold" || definition.trigger.type === "view_threshold";
  const enabling = extra.enabled === true && !current.enabled;
  // A threshold notes where its value stands: only crossings from now on start it.
  const fresh = threshold && (current.version < 1 || !sameThreshold(current.trigger, definition.trigger) || enabling);
  const updated = await db.transaction(async (tx) => {
    // Forgotten with the save, so a check between it and armThreshold has nothing old to compare with.
    if (fresh) await tx.delete(automationThreshold).where(eq(automationThreshold.automationId, current.id));
    await tx.insert(automationVersion).values({ automationId: current.id, version, ...definition, publishedBy: userId });
    const [row] = await tx
      .update(databaseAutomation)
      .set({
        ...extra,
        trigger: definition.trigger,
        actions: definition.actions,
        timeZone: definition.timeZone,
        version,
        draft: null,
        runAs: userId,
        checkError: null,
        nextRunAt: nextRunOf(definition.trigger, definition.timeZone),
        hookSalt: current.hookSalt ?? newHookSalt(),
      })
      .where(eq(databaseAutomation.id, current.id))
      .returning();
    return row;
  });
  // Counting from another date makes every row new to it; other changes keep what it ran for.
  if (current.trigger.type === "date_passed" && (definition.trigger.type !== "date_passed" || definition.trigger.date !== current.trigger.date)) {
    await forgetFired(current.id);
  }
  if (threshold) await armThreshold(current.id, fresh);
  await syncAgentShares(userId, current.databaseId, definition.actions, current.version > 0 ? current.actions : []);
  return updated;
}

export async function createAutomation(userId: string, databaseId: string, input: AutomationInput, { publish = true }: SaveOptions = {}) {
  const database = await requireDatabase(userId, databaseId, "full");
  const name = checkName(input.name);
  const timeZone = checkTimeZone(input.timeZone, "UTC");
  const definition = await checkDefinition(userId, { databaseId, workspaceId: database.workspaceId }, { trigger: input.trigger, actions: input.actions, timeZone }, []);
  const [{ n }] = await db.select({ n: count() }).from(databaseAutomation).where(eq(databaseAutomation.databaseId, databaseId));
  if (n >= MAX_AUTOMATIONS) {
    throw new PropertyValueError(`A database has at most ${MAX_AUTOMATIONS} automations`, "tooManyAutomations", { max: String(MAX_AUTOMATIONS) });
  }
  const enabled = input.enabled ?? true;
  // Saved as a draft first (version 0, which doesn't run); publishing makes it version 1.
  const [draft] = await db
    .insert(databaseAutomation)
    .values({
      databaseId,
      workspaceId: database.workspaceId,
      name,
      enabled,
      trigger: definition.trigger,
      actions: definition.actions,
      timeZone,
      version: 0,
      draft: publish ? null : { ...definition, savedBy: userId, savedAt: new Date().toISOString() },
      secretSalt: newSecretSalt(),
      hookSalt: newHookSalt(),
      runAs: userId,
      createdBy: userId,
    })
    .returning();
  const created = publish ? await publishDefinition(userId, draft, definition) : draft;
  await recordAudit({
    workspaceId: database.workspaceId,
    actorId: userId,
    action: "automation.created",
    target: { type: "page", id: databaseId },
    details: { ...auditDetails(created), ...(publish ? {} : { draft: true }) },
  });
  return (await describe([created]))[0];
}

/** Loads an automation the user may manage. */
async function manageable(userId: string, automationId: string) {
  const [found] = await db.select().from(databaseAutomation).where(eq(databaseAutomation.id, automationId));
  if (!found) throw new PropertyValueError("No automation with this id", "invalidAutomation", { reason: "notFound" });
  await requireDatabase(userId, found.databaseId, "full");
  return found;
}

/** The steps saved so far, published and in the draft: what anyone who may change it may keep. */
const savedActions = (a: Automation) => [...a.actions, ...(a.draft?.actions ?? [])];

/**
 * Changes an automation; what `patch` leaves out stays as it was. Its name and whether it is on
 * change at once, and the saver becomes who it runs as. A new trigger, steps or time zone are
 * published as the next version, or kept in the draft with `publish: false` (who it runs as
 * stays until the draft is published).
 */
export async function updateAutomation(userId: string, automationId: string, patch: Partial<AutomationInput>, { publish = true }: SaveOptions = {}) {
  const current = await manageable(userId, automationId);
  const name = patch.name !== undefined ? checkName(patch.name) : current.name;
  const enabled = patch.enabled ?? current.enabled;
  const base: AutomationDefinition = current.draft ?? { trigger: current.trigger, actions: current.actions, timeZone: current.timeZone };
  const changesSteps = patch.trigger !== undefined || patch.actions !== undefined || patch.timeZone !== undefined;
  let updated: Automation;
  if (changesSteps) {
    const timeZone = checkTimeZone(patch.timeZone, base.timeZone);
    const definition = await checkDefinition(
      userId,
      current,
      {
        trigger: patch.trigger !== undefined ? patch.trigger : triggerAsInput(base.trigger),
        actions: patch.actions !== undefined ? patch.actions : base.actions.map(asInput),
        timeZone,
      },
      savedActions(current),
    );
    if (publish) updated = await publishDefinition(userId, current, definition, { name, enabled });
    else {
      [updated] = await db
        .update(databaseAutomation)
        .set({ name, enabled, draft: { ...definition, savedBy: userId, savedAt: new Date().toISOString() } })
        .where(eq(databaseAutomation.id, automationId))
        .returning();
    }
  } else {
    // Turned on again, a schedule counts from now rather than catching up. Saving it makes the
    // saver who it runs as, as publishing does.
    const nextRunAt = enabled && !current.enabled ? nextRunOf(current.trigger, current.timeZone) : current.nextRunAt;
    const enabling = enabled && !current.enabled;
    updated = await db.transaction(async (tx) => {
      // Turned on again, a threshold notes where its value stands rather than taking what it missed.
      if (enabling) await tx.delete(automationThreshold).where(eq(automationThreshold.automationId, automationId));
      const [row] = await tx
        .update(databaseAutomation)
        .set({ name, enabled, nextRunAt, runAs: userId, checkError: null })
        .where(eq(databaseAutomation.id, automationId))
        .returning();
      return row;
    });
    if (enabling) await armThreshold(automationId, true);
  }
  await recordAudit({
    workspaceId: current.workspaceId,
    actorId: userId,
    action: "automation.updated",
    target: { type: "page", id: current.databaseId },
    details: { ...auditDetails(updated), previous: auditDetails(current), ...(changesSteps && !publish ? { draft: true } : {}) },
  });
  return (await describe([updated]))[0];
}

/** Makes the automation's draft its next version. */
export async function publishAutomation(userId: string, automationId: string) {
  const current = await manageable(userId, automationId);
  if (!current.draft && current.version > 0) throw invalid("Nothing to publish: the automation has no unpublished changes");
  const draft = current.draft ?? { trigger: current.trigger, actions: current.actions, timeZone: current.timeZone };
  // Checked again as the publisher: who may give an agent a task, or what a database lets them do, may have changed.
  const definition = await checkDefinition(
    userId,
    current,
    { trigger: triggerAsInput(draft.trigger), actions: draft.actions.map(asInput), timeZone: draft.timeZone },
    current.version > 0 ? current.actions : [],
    savedActions(current),
  );
  const updated = await publishDefinition(userId, current, definition);
  await recordAudit({
    workspaceId: current.workspaceId,
    actorId: userId,
    action: "automation.updated",
    target: { type: "page", id: current.databaseId },
    details: { ...auditDetails(updated), previous: auditDetails(current), published: updated.version },
  });
  return (await describe([updated]))[0];
}

/** Drops the automation's unpublished changes; one never published has nothing to fall back on. */
export async function discardAutomationDraft(userId: string, automationId: string) {
  const current = await manageable(userId, automationId);
  if (current.version < 1) throw invalid("This automation was never published: delete it instead");
  const [updated] = await db.update(databaseAutomation).set({ draft: null }).where(eq(databaseAutomation.id, automationId)).returning();
  return (await describe([updated]))[0];
}

export type TestRunInput = { rowId?: string | null; payload?: unknown };

/**
 * Runs the draft (or the published steps) once, now, as `userId`, with real effects, marked as a
 * test in the history: on a row of the database for a row trigger, with `payload` (or the saved
 * example) as an incoming webhook's body. Returns the run's id; it runs in the queue like any other.
 */
export async function testAutomation(userId: string, automationId: string, input: TestRunInput = {}) {
  const automation = await manageable(userId, automationId);
  const definition: AutomationDefinition = automation.draft ?? { trigger: automation.trigger, actions: automation.actions, timeZone: automation.timeZone };
  const trigger = definition.trigger;
  let rowId: string | null = null;
  let origin: RunOrigin | null = null;
  let triggerData: Record<string, unknown> | null = null;
  let created = false;
  let changed: string[] = [];
  if (hasRow(trigger)) {
    if (!input.rowId) throw invalid("A test run of this automation needs a row to run on");
    const [row] = await db
      .select({ id: page.id, parentId: page.parentId, archivedAt: page.archivedAt, isTemplate: page.isTemplate, properties: page.properties })
      .from(page)
      .where(and(eq(page.id, input.rowId), pageVisibleTo(userId)));
    if (!row || row.parentId !== automation.databaseId || row.archivedAt || row.isTemplate) throw invalid("No row of this database with this id");
    rowId = row.id;
    created = trigger.type === "row_created";
    if (trigger.type === "button_clicked") origin = "button";
    if (trigger.type === "meeting_summarized") {
      // The row's last written-up meeting, as if it had just been written.
      origin = "meeting";
      triggerData = { meeting: await latestMeeting(row.id) };
    }
    if (trigger.type === "property_changed") {
      // Nothing changed: each watched value is shown as it is, before and after alike.
      changed = watchedProperties(trigger);
      triggerData = { changes: Object.fromEntries(changed.map((id) => [id, { before: row.properties[id] ?? null, after: row.properties[id] ?? null }])) };
    }
  } else if (trigger.type === "incoming_webhook") {
    origin = "incoming_webhook";
    const body = input.payload !== undefined && input.payload !== null && input.payload !== "" ? checkExample(input.payload) : (trigger.example ?? {});
    triggerData = { body: body ?? {} };
  } else if (trigger.type === "view_threshold") {
    // As if it crossed now, with the value the tester sees.
    origin = "view_threshold";
    const reading = await readThreshold(userId, automation.databaseId, trigger, { timeZone: definition.timeZone });
    if (reading.error) throw new PropertyValueError("The automation's view or property is gone", "invalidAutomation", { reason: reading.error });
    triggerData = thresholdData(trigger, reading, null);
  } else {
    origin = "schedule";
    triggerData = { scheduledFor: new Date().toISOString() };
  }
  const [run] = await db
    .insert(automationRun)
    .values({
      automationId,
      rowId,
      actorId: userId,
      created,
      changed,
      origin,
      version: automation.version,
      test: true,
      // A draft's steps go with the run; the published ones are its version's.
      definition: automation.draft ? definition : null,
      triggerData,
      ...(trigger.type === "date_passed" && rowId ? { basis: new Date().toISOString() } : {}),
    })
    .returning({ id: automationRun.id });
  kickAutomations();
  return { runId: run.id };
}

export async function deleteAutomation(userId: string, automationId: string) {
  const current = await manageable(userId, automationId);
  await db.delete(databaseAutomation).where(eq(databaseAutomation.id, automationId));
  for (const t of targetsOf(current.version > 0 ? current.actions : [], current.databaseId)) {
    await releaseDatabaseFromAgents(userId, t.databaseId, [t.agentId]).catch(() => undefined);
  }
  await recordAudit({
    workspaceId: current.workspaceId,
    actorId: userId,
    action: "automation.deleted",
    target: { type: "page", id: current.databaseId },
    details: auditDetails(current),
  });
}

/** A new webhook signing secret: the old one stops working at once. */
export async function rotateAutomationSecret(userId: string, automationId: string) {
  const current = await manageable(userId, automationId);
  const [updated] = await db
    .update(databaseAutomation)
    .set({ secretSalt: newSecretSalt() })
    .where(eq(databaseAutomation.id, automationId))
    .returning();
  await recordAudit({
    workspaceId: current.workspaceId,
    actorId: userId,
    action: "automation.updated",
    target: { type: "page", id: current.databaseId },
    details: { ...auditDetails(updated), previous: auditDetails(current), secretRotated: true },
  });
  return (await describe([updated]))[0];
}

/** A new address for an incoming webhook: the old one stops working at once. */
export async function rotateAutomationHook(userId: string, automationId: string) {
  const current = await manageable(userId, automationId);
  const [updated] = await db.update(databaseAutomation).set({ hookSalt: newHookSalt() }).where(eq(databaseAutomation.id, automationId)).returning();
  await recordAudit({
    workspaceId: current.workspaceId,
    actorId: userId,
    action: "automation.updated",
    target: { type: "page", id: current.databaseId },
    details: { ...auditDetails(updated), previous: auditDetails(current), hookRotated: true },
  });
  return (await describe([updated]))[0];
}

/** Sends a `ping` to each of the automation's webhooks, now, and says how each went. */
export async function testAutomationWebhooks(userId: string, automationId: string) {
  const automation = await manageable(userId, automationId);
  const id = crypto.randomUUID();
  const body = JSON.stringify({
    id,
    event: "ping",
    created_at: new Date().toISOString(),
    automation: { id: automation.id, name: automation.name },
    workspace_id: automation.workspaceId,
    database: { id: automation.databaseId },
  });
  const results: { url: string; ok: boolean; httpStatus?: number; code?: string; error?: string }[] = [];
  // Like the runs, a ping isn't sent while the workspace's owners have export off.
  const exportOff = !(await exportAllowed(automation.workspaceId));
  const actions = automation.draft?.actions ?? automation.actions;
  for (const action of actions) {
    if (action.type !== "webhook") continue;
    if (exportOff) {
      results.push({ url: action.url, ok: false, code: "webhookExportOff", error: "The workspace's owners turned export off" });
      continue;
    }
    try {
      const httpStatus = await sendWebhook(action.url, { id, event: "ping", body, secret: webhookSecret(automation.secretSalt) });
      results.push({ url: action.url, ok: true, httpStatus });
    } catch (error) {
      const e = error as { code?: string; message?: string; httpStatus?: number | null };
      results.push({ url: action.url, ok: false, code: e.code ?? "error", error: e.message, ...(e.httpStatus ? { httpStatus: e.httpStatus } : {}) });
    }
  }
  return results;
}

export type AutomationView = Awaited<ReturnType<typeof describe>>[number];

/** Steps as they leave the server: a Slack step's sealed address stays behind (its hint shows). */
const shownActions = (actions: AutomationAction[]): AutomationAction[] =>
  actions.map((a) => {
    if (a.type !== "slack") return a;
    const { sealed: _sealed, ...shown } = a;
    return shown;
  });

/** Automations as the settings show them: who they run as, their secret and address, their draft and latest run. */
async function describe(automations: Automation[]) {
  if (!automations.length) return [];
  const ids = automations.map((a) => a.id);
  const people = [...new Set(automations.flatMap((a) => (a.runAs ? [a.runAs] : [])))];
  const [names, latest] = await Promise.all([
    people.length ? db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, people)) : [],
    db
      .selectDistinctOn([automationRun.automationId], {
        automationId: automationRun.automationId,
        status: automationRun.status,
        createdAt: automationRun.createdAt,
      })
      .from(automationRun)
      .where(and(inArray(automationRun.automationId, ids), eq(automationRun.test, false)))
      .orderBy(automationRun.automationId, desc(automationRun.createdAt)),
  ]);
  return automations.map((a) => {
    const last = latest.find((r) => r.automationId === a.id);
    const steps = [...a.actions, ...(a.draft?.actions ?? [])];
    const incoming = a.trigger.type === "incoming_webhook" || a.draft?.trigger.type === "incoming_webhook";
    return {
      id: a.id,
      databaseId: a.databaseId,
      name: a.name,
      enabled: a.enabled,
      trigger: a.trigger,
      actions: shownActions(a.actions),
      /** The time zone a "date passed" trigger counts days in and a schedule runs in. */
      timeZone: a.timeZone,
      /** The published version; 0 when only a draft was saved (it doesn't run). */
      version: a.version,
      /** Unpublished changes: what a test run runs and publishing makes live. */
      draft: a.draft ? { trigger: a.draft.trigger, actions: shownActions(a.draft.actions), timeZone: a.draft.timeZone, savedAt: a.draft.savedAt } : null,
      runAs: a.runAs ? { id: a.runAs, name: names.find((n) => n.id === a.runAs)?.name ?? "" } : null,
      /** Only automations with a webhook have one to show. */
      secret: steps.some((x) => x.type === "webhook") ? webhookSecret(a.secretSalt) : null,
      /** An incoming webhook's secret address. */
      hookUrl: incoming && a.hookSalt ? hookUrl(a.id, a.hookSalt) : null,
      /** A scheduled automation that is on: when it runs next. */
      nextRunAt: a.enabled && a.version > 0 && a.nextRunAt ? a.nextRunAt.toISOString() : null,
      lastRun: last ? { status: last.status as AutomationRunStatus, at: last.createdAt.toISOString() } : null,
      /** "Date passed" and schedules: why the last check couldn't run (see AutomationCheckError). */
      checkError: a.enabled ? a.checkError : null,
      createdAt: a.createdAt.toISOString(),
      updatedAt: a.updatedAt.toISOString(),
    };
  });
}

export async function listAutomations(userId: string, databaseId: string) {
  await requireDatabase(userId, databaseId, "full");
  const automations = await db
    .select()
    .from(databaseAutomation)
    .where(eq(databaseAutomation.databaseId, databaseId))
    .orderBy(asc(databaseAutomation.createdAt));
  return describe(automations);
}

export type AutomationRunView = {
  id: string;
  /** The row it ran on; null for a schedule's or an incoming webhook's run. */
  rowId: string | null;
  rowTitle: string;
  event: string;
  /** A "date passed" run: the row's date it ran for. */
  basis: string | null;
  status: AutomationRunStatus;
  steps: AutomationStep[];
  /** The version it ran; a test run of unpublished changes has `draft`. */
  version: number;
  test: boolean;
  draft: boolean;
  /** What started it, as the history shows it: an incoming webhook's body, a schedule's time, a meeting's write-up. */
  trigger: unknown;
  createdAt: string;
  finishedAt: string | null;
};

/** The automation's latest runs, newest first. */
export async function listAutomationRuns(userId: string, automationId: string, limit = 20): Promise<AutomationRunView[]> {
  await manageable(userId, automationId);
  const runs = await db
    .select({
      id: automationRun.id,
      rowId: automationRun.rowId,
      rowTitle: page.title,
      created: automationRun.created,
      basis: automationRun.basis,
      origin: automationRun.origin,
      status: automationRun.status,
      steps: automationRun.steps,
      version: automationRun.version,
      test: automationRun.test,
      definition: automationRun.definition,
      triggerData: automationRun.triggerData,
      createdAt: automationRun.createdAt,
      finishedAt: automationRun.finishedAt,
    })
    .from(automationRun)
    .leftJoin(page, eq(page.id, automationRun.rowId))
    // Rows the person can't see stay out, title and all; runs without a row are theirs to see.
    .where(and(eq(automationRun.automationId, automationId), or(isNull(automationRun.rowId), pageVisibleTo(userId))))
    .orderBy(desc(automationRun.createdAt))
    .limit(Math.min(Math.max(limit, 1), 100));
  return runs.map((r) => ({
    id: r.id,
    rowId: r.rowId,
    rowTitle: r.rowId ? pageLabel(r.rowTitle ?? "") : "",
    event: runEvent(r),
    basis: r.basis,
    status: r.status,
    steps: r.steps,
    version: r.version,
    test: r.test,
    draft: r.test && r.definition !== null,
    trigger:
      r.origin === "incoming_webhook"
        ? forHistory(r.triggerData?.body ?? null)
        : r.origin === "schedule"
          ? { scheduledFor: r.triggerData?.scheduledFor ?? null }
          : r.origin === "view_threshold"
            ? { value: r.triggerData?.value ?? null, previous: r.triggerData?.previous ?? null, threshold: r.triggerData?.threshold ?? null, comparison: r.triggerData?.comparison ?? null }
            : r.origin === "meeting"
              ? { meeting: forHistory(r.triggerData?.meeting ?? null) }
              : null,
    createdAt: r.createdAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
  }));
}

/**
 * How many rows a "date passed" trigger, as typed, would run for at the next check with days in
 * `timeZone` (the saver's) at `now`: for a saved automation (`automationId`) counting from the same date,
 * without the rows it already ran for. Zero for other triggers.
 */
export async function previewDatePassed(
  userId: string,
  databaseId: string,
  input: AutomationInput["trigger"],
  automationId: string | null = null,
  timeZone = "UTC",
  now = new Date(),
) {
  const database = await requireDatabase(userId, databaseId, "full");
  if (input?.type !== "date_passed") return 0;
  const zone = checkTimeZone(timeZone, "UTC");
  const trigger = checkDatePassed(await getProperties(databaseId), input);
  let keep: string | null = null;
  if (automationId) {
    const current = await manageable(userId, automationId);
    if (current.databaseId !== databaseId) throw new PropertyValueError("No automation with this id", "invalidAutomation", { reason: "notFound" });
    if (current.trigger.type === "date_passed" && current.trigger.date === trigger.date) keep = current.id;
  }
  return countDatePassedMatches(trigger, { id: databaseId, workspaceId: database.workspaceId }, keep, zone, now);
}

/**
 * A threshold trigger's value now, as typed, for the editor: what `userId` sees of the view's rows
 * with days in `timeZone`, and whether it is past the line (publishing notes that without a run).
 */
export async function previewThreshold(userId: string, databaseId: string, input: AutomationInput["trigger"], timeZone = "UTC") {
  await requireDatabase(userId, databaseId, "full");
  if (input?.type !== "view_threshold") return null;
  const trigger = await checkThreshold(databaseId, await getProperties(databaseId), input);
  const reading = await readThreshold(userId, databaseId, trigger, { timeZone: checkTimeZone(timeZone, "UTC") });
  if (reading.error) return null;
  return { value: reading.value, met: thresholdMet(reading.value, trigger) };
}

/** When a schedule, as typed, would run next in `timeZone`, for the editor; null when it never would. */
export function previewSchedule(schedule: unknown, timeZone: string, now = new Date()) {
  const parsed = parseAutomationSchedule(schedule);
  if (!parsed || !isTimeZone(timeZone)) return null;
  return nextScheduledRun(parsed, timeZone, now)?.toISOString() ?? null;
}

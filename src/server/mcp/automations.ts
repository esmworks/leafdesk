import * as z from "zod";
import { listSequences } from "@/server/sequences/manage";
import type { FilterEntry, ViewConfig } from "@/db/schema/app";
import { MAX_CRON_LENGTH, type AutomationSchedule } from "@/lib/automation-schedule";
import { hasTemplate, templateRoots } from "@/lib/automation-templates";
import {
  forEachOf,
  HTTP_METHODS,
  isDynamicValue,
  MAX_APPROVAL_DAYS,
  MAX_APPROVERS,
  MAX_AUTOMATION_ACTIONS,
  MAX_AUTOMATION_NAME,
  MAX_DATE_PASSED_DAYS,
  MAX_FOUND_ROWS,
  MAX_HTTP_HEADERS,
  MAX_NOTIFY_PEOPLE,
  MAX_STEP_MESSAGE,
  MAX_THRESHOLD,
  MAX_WAIT_MINUTES,
  MAX_WEBHOOK_URL,
  STEP_ID,
  THRESHOLD_COMPARISONS,
  THRESHOLD_FNS,
  watchedProperties,
  stepIds,
  type AutomationAction,
  type AutomationTrigger,
} from "@/lib/automations";
import { MAX_AGENT_PROMPT } from "@/lib/agents";
import { filterRules, isFilterGroup } from "@/lib/filters";
import { pageLabel } from "@/lib/labels";
import { displayValue, PropertyValueError } from "@/lib/properties";
import { holdsPeople, STATUS_GROUPS } from "@/lib/property-types";
import { AccessError } from "@/server/access";
import * as agents from "@/server/agents/manage";
import type { AutomationActionInput, AutomationInput, AutomationRunView, AutomationView } from "@/server/automations/manage";
import * as databases from "@/server/databases";
import { filterCombinatorInput, filtersInput, id, rowValue, sortsInput } from "@/server/operations";
import { checked, see } from "./docs";
import * as workspaces from "@/server/workspaces";
import { pageUrl, ToolInputError } from "./format";
import {
  describeViewConfig,
  displayProperties,
  toFilterEntries,
  toSortRule,
  type FilterEntryInput,
  type FilterInput,
  type Lookups,
  type PropertyDef,
} from "./query";

/**
 * Database automations over MCP: the tools' input schemas, turning their input into what
 * server/automations/manage takes, and stored automations (ids) back into names a model can read.
 */

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const timeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
  .describe('The time of day, "HH:MM" (24 hours), in the automation\'s time_zone.');

const scheduleInput = z
  .discriminatedUnion("frequency", [
    z.object({ frequency: z.literal("daily"), time: timeOfDay }),
    z.object({
      frequency: z.literal("weekly"),
      time: timeOfDay,
      weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).describe("Days of the week: 0 Sunday, 1 Monday … 6 Saturday."),
    }),
    z.object({
      frequency: z.literal("monthly"),
      time: timeOfDay,
      days: z
        .array(z.number().int().min(1).max(31))
        .min(1)
        .max(31)
        .describe("Days of the month, 1-31; a day a month doesn't have (the 31st, the 29th of February) runs on its last day."),
    }),
    z.object({
      frequency: z.literal("cron"),
      cron: z
        .string()
        .min(1)
        .max(MAX_CRON_LENGTH)
        .describe('Five cron fields: minute hour day-of-month month day-of-week, e.g. "*/30 8-18 * * MON-FRI".'),
    }),
  ])
  .describe("When it runs, in the automation's time_zone.");

export const triggerInput = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("row_created") }),
    z.object({
      type: z.literal("property_changed"),
      property: z
        .string()
        .min(1)
        .optional()
        .describe("The property, by name or id. Leave out (and properties too) to run when any property of an existing row changes."),
      properties: z
        .array(z.string().min(1))
        .min(1)
        .max(50)
        .optional()
        .describe("Several properties (names or ids): runs when any of them changes. Instead of property; can't be combined with to."),
      to: z
        .union([z.string(), z.boolean()])
        .optional()
        .describe(
          'Only when the value becomes this: an option name (select, status, multi-select: when it gets added), true or false (checkbox), or a person (id, email, name or "me"; when they get added). Needs property.',
        ),
    }),
    z.object({
      type: z.literal("date_passed"),
      date: z
        .string()
        .min(1)
        .describe('What to count from: a date property (name or id; its start), "created_time" (when the row was added) or "last_edited_time" (when it was last edited).'),
      days: z
        .number()
        .int()
        .min(0)
        .max(MAX_DATE_PASSED_DAYS)
        .describe("How many days past that date the row must be (0: on the day itself, or once the time has come)."),
      status: z
        .object({
          property: z.string().min(1).optional().describe("The status property, by name or id; may be left out when the database has only one."),
          groups: z.array(z.enum(STATUS_GROUPS)).min(1).describe("The status groups the row's status must be in. A row without a status counts as todo."),
        })
        .nullable()
        .optional()
        .describe('Only rows whose status is in these groups, e.g. {"groups": ["todo", "in_progress"]} for rows that are not done.'),
    }),
    z.object({
      type: z.literal("view_threshold"),
      view: z.string().min(1).describe("A shared view of this database, by name or id: its filters pick the rows (personal views can't be used)."),
      calculation: z
        .enum(THRESHOLD_FNS)
        .optional()
        .describe("count_all (default) counts the view's rows; sum, average, median, min and max calculate over property."),
      property: z.string().min(1).nullable().optional().describe("The number property (or number formula or rollup) to calculate over, by name or id. Not for count_all."),
      comparison: z.enum(THRESHOLD_COMPARISONS).describe("above: more than value; below: less than value. The value itself is neither."),
      value: z.number().min(-MAX_THRESHOLD).max(MAX_THRESHOLD).describe("The line."),
    }),
    z.object({ type: z.literal("schedule"), schedule: scheduleInput }),
    z.object({
      type: z.literal("incoming_webhook"),
      example: z
        .unknown()
        .optional()
        .describe("An example JSON body (an object, or JSON text): what test_automation sends when given no payload, and what the app offers as {{trigger…}} fields."),
    }),
  ])
  .describe(
    'What starts the automation. Row triggers: {"type": "row_created"} when a row is added; {"type": "property_changed", "property": "Status", "to": "Done"} when a value changes; {"type": "date_passed", "date": "last_edited_time", "days": 30, "status": {"groups": ["todo", "in_progress"]}} that many days past (checked every few minutes; once per value, again after the date changes and is past again; matching rows run at the next check, at most 100 per check). Triggers without a row: {"type": "view_threshold", "view": "Cash and bank", "calculation": "sum", "property": "Amount", "comparison": "below", "value": 50000} runs once when the calculation over the view\'s rows (as the automation\'s person sees them) crosses the line, and again only after it came back; checked a moment after rows change and every few minutes (for "today" filters); what is already past the line when it is published or turned on doesn\'t run it; {"type": "schedule", "schedule": {"frequency": "weekly", "time": "09:00", "weekdays": [1]}} runs at those times in time_zone (missed times run once); {"type": "incoming_webhook"} runs when a JSON POST arrives at the automation\'s secret address (hook_url in the result), with the body as {{trigger}} (at most 64 KB, 60/min; answers 202 with the run_id).',
  );

// Described once, in set_properties' values: the union is sent again inside every values field.
const dynamicValue = z.object({ $: z.enum(["now", "actor"]) });

const stepValues = (what: string) => z.record(z.string(), z.union([rowValue, dynamicValue])).describe(`Values to set on ${what}, written as in set_properties.`);

// Described once, in actionsInput: every step type has one.
const stepId = z.string().regex(STEP_ID).optional();

const forEachInput = z
  .string()
  .min(1)
  .optional()
  .describe(
    "The id of an earlier find_rows step: do this once per found row, with {{item}} as that row.",
  );

const databaseInput = (what: string) => id("database").describe(`The database ${what} (an id from search or get_database; this one or another of the workspace).`);

const actionInput = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("set_properties"),
    id: stepId,
    values: z
      .record(z.string(), z.union([rowValue, dynamicValue]))
      .describe(
        `Values to set on the row (with for_each: on each found row, by that database's property names), keyed by property name or id, written as for update_database_row (option names, dates as YYYY-MM-DD, times or "start/end" ranges, people as ids, emails, names or "me", null to clear), or {"$": "now"} for the day the automation runs and {"$": "actor"} for whoever made the change (row_created and property_changed only). Values may be templates: "{{trigger.Due}}"; a value that is one template keeps its type (rows and people give their ids to relation and person properties), and one that leads nowhere clears the property. Example: {"Status": "Done", "Completed": {"$": "now"}, "Customer": "{{find.first}}"}.`,
      ),
    for_each: forEachInput,
  }),
  z.object({
    type: z.literal("notify"),
    id: stepId,
    people: z
      .array(z.string().min(1))
      .max(MAX_NOTIFY_PEOPLE)
      .optional()
      .describe('People to notify: user ids, emails, names or "me".'),
    properties: z
      .array(z.string().min(1))
      .max(50)
      .optional()
      .describe("Person properties (name or id): whoever the row (with for_each, each found row) names in them is notified too. Needs a row or for_each."),
    message: z
      .string()
      .max(MAX_STEP_MESSAGE)
      .optional()
      .describe(`A message shown with the notification (at most ${MAX_STEP_MESSAGE} characters); may hold templates: "{{trigger.Customer}} wants a call".`),
    for_each: forEachInput,
  }),
  z.object({
    type: z.literal("webhook"),
    id: stepId,
    url: z.string().min(1).max(MAX_WEBHOOK_URL).describe("The http(s) address the signed JSON POST of the row goes to. Row triggers only."),
  }),
  z.object({
    type: z.literal("run_agent"),
    id: stepId,
    agent: z.string().min(1).describe("The agent, by id or name (list_agents lists the workspace's agents)."),
    prompt: z
      .string()
      .max(MAX_AGENT_PROMPT)
      .optional()
      .describe(`The task the agent gets for the row, on top of its own instructions (at most ${MAX_AGENT_PROMPT} characters); may hold templates.`),
    for_each: forEachInput,
  }),
  z.object({ type: z.literal("move_to_trash"), id: stepId }),
  z.object({
    type: z.literal("http_request"),
    id: stepId,
    method: z.enum(HTTP_METHODS).optional().describe("GET (default), POST, PUT, PATCH or DELETE."),
    url: z
      .string()
      .min(1)
      .max(MAX_WEBHOOK_URL)
      .describe('The https address, which may hold templates ("https://api.example.com/orders/{{trigger.Order id}}"). Plain http, private networks and local names only for hosts the administrator allows.'),
    headers: z
      .union([
        z.array(z.object({ name: z.string().min(1), value: z.string() })).max(MAX_HTTP_HEADERS),
        z.record(z.string(), z.string()),
      ])
      .optional()
      .describe(`Request headers, at most ${MAX_HTTP_HEADERS}: {"Authorization": "Bearer …"} or [{name, value}]; values may hold templates. Run history masks credentials.`),
    body: z
      .unknown()
      .optional()
      .describe('A JSON body (sent with POST, PUT and PATCH); strings in it may be templates: {"email": "{{trigger.Email}}", "total": "{{trigger.Amount}}"}.'),
  }),
  z.object({
    type: z.literal("find_rows"),
    id: stepId,
    database_id: databaseInput("to look in"),
    filters: filtersInput
      .optional()
      .describe(
        'Filters as query_database takes them (property and option names). A value may be a template ("{{trigger.Customer}}"), kept as written and filled in when the step runs; one that leads nowhere fails the step (emptyFilter).',
      ),
    filter_combinator: filterCombinatorInput,
    sorts: sortsInput.optional(),
    limit: z.number().int().min(1).max(MAX_FOUND_ROWS).optional().describe(`How many rows at most (1-${MAX_FOUND_ROWS}, default 20).`),
  }),
  z.object({
    type: z.literal("create_row"),
    id: stepId,
    database_id: databaseInput("to add the row to"),
    title: z.string().max(MAX_STEP_MESSAGE).optional().describe("Its title; may hold templates."),
    values: stepValues("the new row (that database's property names)").optional(),
    template_id: z.string().optional().describe('Row template id, or "default".'),
  }),
  z.object({
    type: z.literal("upsert_row"),
    id: stepId,
    database_id: databaseInput("to change or add the row in"),
    match: z
      .object({
        property: z.string().min(1).describe('The property rows are matched on, by name or id, or "title".'),
        value: z.string().min(1).max(MAX_STEP_MESSAGE).describe('The value to match, usually a template ("{{trigger.Email}}"); an empty one fails the step.'),
      })
      .describe("The first row whose property equals this value is changed; with none, a row is added with it."),
    title: z.string().max(MAX_STEP_MESSAGE).optional().describe("The row's title; may hold templates."),
    values: stepValues("the row (that database's property names)").optional(),
  }),
  z.object({
    type: z.literal("wait"),
    id: stepId,
    minutes: z.number().int().min(1).max(MAX_WAIT_MINUTES).describe(`Minutes to wait before the next step (1-${MAX_WAIT_MINUTES}, seven days).`),
  }),
  z.object({
    type: z.literal("log"),
    id: stepId,
    message: z.string().min(1).max(MAX_STEP_MESSAGE).describe("Text written into the run's history; may hold templates."),
  }),
  z.object({
    type: z.literal("celebrate"),
    id: stepId,
  }),
  z.object({
    type: z.literal("start_sequence"),
    id: stepId,
    sequence: z.string().min(1).describe("The follow-up sequence to start on the row, by id or name: one of the database's (list_sequences)."),
    for_each: forEachInput,
  }),
  z.object({
    type: z.literal("approval"),
    id: stepId,
    people: z
      .array(z.string().min(1))
      .max(MAX_APPROVERS)
      .optional()
      .describe('People who may approve: user ids, emails, names or "me".'),
    properties: z
      .array(z.string().min(1))
      .max(20)
      .optional()
      .describe("Person properties (name or id): whoever the row names in them when the run gets here may approve too (row triggers only)."),
    message: z
      .string()
      .max(MAX_STEP_MESSAGE)
      .optional()
      .describe(`What the approvers read (at most ${MAX_STEP_MESSAGE} characters); may hold templates: "Mark {{trigger.title}} as Won for {{trigger.Amount}}?".`),
    timeout_days: z
      .number()
      .int()
      .min(1)
      .max(MAX_APPROVAL_DAYS)
      .optional()
      .describe(`How many days the run waits for an answer (1-${MAX_APPROVAL_DAYS}, default ${MAX_APPROVAL_DAYS}).`),
    on_timeout: z.enum(["stop", "continue"]).optional().describe("stop (default) ends a run unanswered in time; continue goes on as if approved, with approved_by null."),
  }),
  z.object({
    type: z.literal("slack"),
    id: stepId,
    url: z.string().max(MAX_WEBHOOK_URL).optional().describe("A Slack incoming webhook (https://hooks.slack.com/services/…), kept secret. Omit to keep the saved one."),
    message: z.string().max(MAX_STEP_MESSAGE).optional(),
  }),
]);

const TEMPLATE_NOTE =
  'Text in steps may hold templates: {{trigger.X}} is what started the run (a row trigger: the row\'s values by property name, and id, title, url, event, database, actor and changes.<Property>.before / .after; date_passed adds date; incoming_webhook: the JSON body; schedule: event, scheduledFor and database; view_threshold: value, previous, threshold, comparison, calculation, property, view {id, name, url} and database), {{item.X}} the found row of a for_each step, and {{<step id>.X}} what an earlier step gave: find_rows {rows, count, first} (rows by property name, id, title, url), http_request {status, headers, body}, create_row and upsert_row {id, title, url, created}, log {message}, wait {until}, approval {approved, approved_by: {id, name}, answered_at}, set_properties {id, values}, notify {notified}, run_agent {agentRunId}, start_sequence {enrollmentId}, and a for_each step {count, items}. Paths use dots, list positions and quotes: {{find.rows.0.title}}, {{http.body.customer["e-mail"]}}; names match exactly, then regardless of case. In text a missing path is empty and a list is joined with ", "; a value that is only a template keeps its type (null if missing). A step that uses a failed or skipped step is skipped (dependencyFailed).';

export const actionsInput = z
  .array(actionInput)
  .min(1)
  .max(MAX_AUTOMATION_ACTIONS)
  .describe(
    `What the automation does, in order (at most ${MAX_AUTOMATION_ACTIONS} steps; each works or fails on its own): set_properties, notify (inbox, and email as each person chooses, to people who can open the row), webhook, run_agent (queues a run of an agent on the row), move_to_trash (the last step; not with run_agent), http_request (2xx within 15 s, no redirects; network errors, timeouts and 502-504 retried up to 5 times), find_rows, create_row, upsert_row, wait, log, celebrate (confetti for whoever made the change), approval (asks the people named and in the row's person properties, in "For review"; the run waits: rejected stops it, see on_timeout; noApprovers if nobody is found; not for_each; a test run skips it), start_sequence (a follow-up of the database on the row, from the runner's mailbox; rows in it already: alreadyEnrolled) or slack (posts the message, Slack mrkdwn, and the row's link to a Slack incoming webhook; list_automations shows a hint of its url). A schedule, view_threshold or incoming_webhook automation has no row: set_properties, run_agent and notify with properties need for_each over an earlier find_rows step ({{item}}: that row by name, id, title, url); webhook and move_to_trash are impossible. A run_agent step gives the agent edit access to the database while an automation runs it; only workspace owners and agent editors add or change one. A step's optional id names its output in later templates ({{find.rows}}): a-z, 0-9, _, a letter first, at most 32, not "trigger" or "item"; default its type (find, find_2 …). ${TEMPLATE_NOTE}`,
  );

const nameInput = z.string().min(1).max(MAX_AUTOMATION_NAME);
/** The zone a "date_passed" trigger counts days in and a schedule runs in; what the description adds when it's left out. */
const timeZoneInput = (leftOut: string) =>
  z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe(
      `The IANA time zone (such as "Europe/Istanbul") a schedule runs in and a "date_passed" trigger counts the days of dates without a time in: a row due on a day has reached it once that day starts there. Pass the user's own zone; ${leftOut}.`,
    );

const publishInput = (what: string) =>
  z
    .boolean()
    .optional()
    .describe(
      `true (default): ${what} published at once as the automation's next version. false: kept as a draft that doesn't run until publish_automation; test_automation runs it.`,
    );

/** The trigger and steps as tools take them: outlines with a pointer to their docs, checked in full when called. */
const triggerParam = checked(
  triggerInput,
  "object",
  `When it runs: {type: "row_created" | "property_changed" | "date_passed" | "view_threshold" | "schedule" | "incoming_webhook", …}. ${see("automations")}`,
);
const actionsParam = checked(
  actionsInput,
  "array",
  `The steps in order, each {type, …}: set_properties, notify, webhook, slack, run_agent, move_to_trash, http_request, find_rows, create_row, upsert_row, wait, approval, start_sequence, celebrate or log; for_each repeats one per row an earlier find_rows found, and {{templates}} read earlier outputs. ${see("automations")}`,
);

export const automationInputs = {
  list: z.object({ database_id: id("database") }),
  create: z.object({
    database_id: id("database"),
    name: nameInput.describe("A name for the automation, shown in the database's automations."),
    enabled: z.boolean().optional().describe("Whether it runs once published (default true)."),
    time_zone: timeZoneInput("UTC when left out"),
    trigger: triggerParam,
    actions: actionsParam,
    publish: publishInput("it is"),
  }),
  // No defaults here: what is left out stays as it is.
  update: z.object({
    automation_id: id("automation"),
    name: nameInput.optional(),
    enabled: z.boolean().optional().describe("Turn the automation on or off (at once, draft or not)."),
    time_zone: timeZoneInput("left out, the stored zone stays"),
    trigger: triggerParam.optional(),
    actions: actionsParam.optional(),
    publish: publishInput("a new trigger, steps or time zone are"),
    new_webhook_address: z
      .literal(true)
      .optional()
      .describe("An incoming_webhook automation: give it a new secret address (hook_url); the old one stops working at once."),
  }),
  automationId: z.object({ automation_id: id("automation") }),
  test: z.object({
    automation_id: id("automation"),
    row_id: id("row").optional().describe("A row trigger: the row of the database to run on (needed)."),
    payload: z
      .unknown()
      .optional()
      .describe("An incoming_webhook trigger: the JSON body to run with (an object, or JSON text); left out, the trigger's example."),
  }),
  runs: z.object({
    automation_id: id("automation"),
    limit: z.number().int().min(1).max(100).default(20).describe("Maximum runs (1-100, default 20)."),
  }),
};

type TriggerArg = z.infer<typeof triggerInput>;
type ActionsArg = z.infer<typeof actionsInput>;
type ScheduleArg = z.infer<typeof scheduleInput>;

const toSchedule = (schedule: ScheduleArg): AutomationSchedule => schedule;

const toTrigger = (trigger: TriggerArg): AutomationInput["trigger"] => {
  switch (trigger.type) {
    case "row_created":
      return { type: "row_created" };
    case "date_passed":
      return {
        type: "date_passed",
        date: trigger.date,
        days: trigger.days,
        status: trigger.status ? { property: trigger.status.property ?? null, groups: trigger.status.groups } : null,
      };
    case "schedule":
      return { type: "schedule", schedule: toSchedule(trigger.schedule) };
    case "incoming_webhook":
      return { type: "incoming_webhook", ...(trigger.example !== undefined ? { example: trigger.example } : {}) };
    case "view_threshold":
      return {
        type: "view_threshold",
        view: trigger.view,
        calculation: trigger.calculation,
        property: trigger.property ?? null,
        comparison: trigger.comparison,
        value: trigger.value,
      };
    default:
      return {
        type: "property_changed",
        property: trigger.property ?? null,
        ...(trigger.properties !== undefined ? { properties: trigger.properties } : {}),
        ...(trigger.to !== undefined ? { to: trigger.to } : {}),
      };
  }
};

/**
 * Filters by name to the ids a view stores (toFilterEntries). A rule whose value is a template is
 * kept as written, its property named by id: the run fills it in.
 */
function toStepFilters(props: PropertyDef[], inputs: FilterEntryInput[], lookups: Lookups): FilterEntry[] {
  const templated: FilterInput[] = [];
  // Converted with a stand-in rule that needs no value, then put back.
  const standIn = (entries: FilterEntryInput[]): FilterEntryInput[] =>
    entries.map((entry) => {
      if ("type" in entry && entry.type === "group") return { ...entry, rules: standIn(entry.rules) };
      const rule = entry as FilterInput;
      if (rule.value === undefined || !templateRoots(rule.value).size) return rule;
      templated.push(rule);
      return { property: rule.property, op: "is_not_empty" };
    });
  const converted = toFilterEntries(props, standIn(inputs), lookups);
  if (!templated.length) return converted;
  let i = 0;
  const restore = (entries: FilterEntry[], given: FilterEntryInput[]): FilterEntry[] =>
    entries.map((entry, n) => {
      const input = given[n];
      if (isFilterGroup(entry)) return { ...entry, rules: restore(entry.rules, (input as { rules: FilterEntryInput[] }).rules) };
      const rule = input as FilterInput;
      if (rule.value === undefined || !templateRoots(rule.value).size) return entry;
      const original = templated[i++];
      return { propertyId: entry.propertyId, op: original.op, value: original.value, ...(original.days !== undefined ? { days: original.days } : {}) };
    });
  return restore(converted, inputs);
}

type DatabaseInfo = { title: string; props: PropertyDef[]; lookups: Lookups };

/** Steps as manage takes them; find_rows' filters and sorts go from names to ids here, against the database they look in. */
async function toActions(userId: string, actions: ActionsArg): Promise<AutomationActionInput[]> {
  const loaded = new Map<string, Promise<DatabaseInfo>>();
  const database = (databaseId: string) => {
    let found = loaded.get(databaseId);
    if (!found) {
      found = (async () => {
        const { database, properties } = await databases.getDatabase(userId, databaseId);
        return { title: database.title, props: properties as PropertyDef[], lookups: await databases.getLookups(userId, properties) };
      })();
      loaded.set(databaseId, found);
    }
    return found;
  };
  const out: AutomationActionInput[] = [];
  for (const a of actions) {
    const stepId = a.id !== undefined ? { id: a.id } : {};
    const forEach = "for_each" in a && a.for_each !== undefined ? { forEach: a.for_each } : {};
    let step: AutomationActionInput;
    switch (a.type) {
      case "set_properties":
        step = { type: "set_properties", values: a.values, ...forEach };
        break;
      case "notify":
        step = {
          type: "notify",
          people: a.people ?? [],
          properties: a.properties ?? [],
          ...(a.message !== undefined ? { message: a.message } : {}),
          ...forEach,
        };
        break;
      case "webhook":
        step = { type: "webhook", url: a.url };
        break;
      case "move_to_trash":
        step = { type: "move_to_trash" };
        break;
      case "run_agent":
        step = { type: "run_agent", agent: a.agent, ...(a.prompt !== undefined ? { prompt: a.prompt } : {}), ...forEach };
        break;
      case "http_request":
        step = {
          type: "http_request",
          ...(a.method !== undefined ? { method: a.method } : {}),
          url: a.url,
          ...(a.headers !== undefined ? { headers: a.headers } : {}),
          ...(a.body !== undefined ? { body: a.body } : {}),
        };
        break;
      case "find_rows": {
        const { props, lookups } = await database(a.database_id);
        step = {
          type: "find_rows",
          database: a.database_id,
          ...(a.filters ? { filters: toStepFilters(props, a.filters as FilterEntryInput[], lookups) } : {}),
          ...(a.filter_combinator ? { filterCombinator: a.filter_combinator } : {}),
          ...(a.sorts ? { sorts: a.sorts.map((s) => toSortRule(props, s)) } : {}),
          ...(a.limit !== undefined ? { limit: a.limit } : {}),
        };
        break;
      }
      case "create_row":
        step = { type: "create_row", database: a.database_id, ...(a.title !== undefined ? { title: a.title } : {}), ...(a.values ? { values: a.values } : {}), ...(a.template_id ? { template: a.template_id } : {}) };
        break;
      case "upsert_row":
        step = {
          type: "upsert_row",
          database: a.database_id,
          match: a.match,
          ...(a.title !== undefined ? { title: a.title } : {}),
          ...(a.values ? { values: a.values } : {}),
        };
        break;
      case "wait":
        step = { type: "wait", minutes: a.minutes };
        break;
      case "log":
        step = { type: "log", message: a.message };
        break;
      case "celebrate":
        step = { type: "celebrate" };
        break;
      case "slack":
        step = { type: "slack", ...(a.url ? { url: a.url } : {}), ...(a.message !== undefined ? { message: a.message } : {}) };
        break;
      case "start_sequence":
        step = { type: "start_sequence", sequence: a.sequence, ...forEach };
        break;
      case "approval":
        step = {
          type: "approval",
          people: a.people ?? [],
          properties: a.properties ?? [],
          ...(a.message !== undefined ? { message: a.message } : {}),
          ...(a.timeout_days !== undefined ? { timeoutDays: a.timeout_days } : {}),
          ...(a.on_timeout !== undefined ? { onTimeout: a.on_timeout } : {}),
        };
        break;
    }
    out.push({ ...step, ...stepId });
  }
  return out;
}

/** create_automation's arguments as manage.createAutomation takes them. */
export async function toAutomationInput(
  userId: string,
  args: { name: string; enabled?: boolean; time_zone?: string; trigger: TriggerArg; actions: ActionsArg },
): Promise<AutomationInput> {
  return {
    name: args.name,
    ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
    ...(args.time_zone !== undefined ? { timeZone: args.time_zone } : {}),
    trigger: toTrigger(args.trigger),
    actions: await toActions(userId, args.actions),
  };
}

/** update_automation's arguments as a patch: only what was given (empty when nothing was). */
export async function toAutomationPatch(
  userId: string,
  args: { name?: string; enabled?: boolean; time_zone?: string; trigger?: TriggerArg; actions?: ActionsArg },
): Promise<Partial<AutomationInput>> {
  const patch: Partial<AutomationInput> = {};
  if (args.name !== undefined) patch.name = args.name;
  if (args.enabled !== undefined) patch.enabled = args.enabled;
  if (args.time_zone !== undefined) patch.timeZone = args.time_zone;
  if (args.trigger !== undefined) patch.trigger = toTrigger(args.trigger);
  if (args.actions !== undefined) patch.actions = await toActions(userId, args.actions);
  return patch;
}

/** Errors with a better next step than "call get_database". */
export async function withAutomationErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof PropertyValueError && error.params.reason === "notFound") {
      throw new ToolInputError("No automation with this id. Call list_automations with the database to see its automations.");
    }
    if (error instanceof PropertyValueError && error.code === "webhookBlocked") {
      throw new ToolInputError(
        `${error.message}. Use a public address; the server's administrator can allow a host on a private network with AUTOMATION_WEBHOOK_ALLOWED_HOSTS.`,
      );
    }
    throw error;
  }
}

type Person = { id: string; name: string };

type AgentRef = { id: string; name: string };

/** What it takes to name a database's properties, options, people and agents, and the other databases steps use. */
export type AutomationContext = {
  workspaceId: string;
  databaseId: string;
  props: PropertyDef[];
  lookups: Lookups;
  people: Person[];
  agents: AgentRef[];
  /** Databases find_rows, create_row and upsert_row steps use, by id (this one too); missing when the user can't open one. */
  databases: Map<string, DatabaseInfo>;
  /** The database's follow-up sequences, for naming them. */
  sequences: { id: string; name: string }[];
  /** The database's views the user sees, for naming a threshold's. */
  views: { id: string; name: string }[];
};

/** The workspace's agents, archived ones too, for naming them; none for those who can't list them (guests). */
async function agentNames(userId: string, workspaceId: string): Promise<AgentRef[]> {
  try {
    return await agents.agentRefs(userId, workspaceId);
  } catch (error) {
    if (error instanceof AccessError) return [];
    throw error;
  }
}

const usedDatabases = (actions: AutomationAction[]) =>
  actions.flatMap((a) => (a.type === "find_rows" || a.type === "create_row" || a.type === "upsert_row" ? [a.databaseId] : []));

/** `automations`: those to be described, whose steps may use other databases. */
export async function automationContext(userId: string, databaseId: string, automations: AutomationView[] = []): Promise<AutomationContext> {
  const { database, properties, views } = await databases.getDatabase(userId, databaseId);
  const [lookups, members, agentRefs, sequences] = await Promise.all([
    databases.getLookups(userId, properties),
    workspaces.workspacePeople(database.workspaceId),
    agentNames(userId, database.workspaceId),
    listSequences(userId, databaseId).catch(() => []),
  ]);
  const people = new Map<string, Person>();
  for (const p of [...lookups.people, ...members]) if (!people.has(p.id)) people.set(p.id, { id: p.id, name: p.name });
  const own: DatabaseInfo = { title: database.title, props: properties as PropertyDef[], lookups };
  const others = new Set(automations.flatMap((a) => usedDatabases([...a.actions, ...(a.draft?.actions ?? [])])));
  others.delete(databaseId);
  const loaded = new Map<string, DatabaseInfo>([[databaseId, own]]);
  await Promise.all(
    [...others].map(async (id) => {
      try {
        const other = await databases.getDatabase(userId, id);
        loaded.set(id, { title: other.database.title, props: other.properties as PropertyDef[], lookups: await databases.getLookups(userId, other.properties) });
      } catch (error) {
        if (!(error instanceof AccessError) && !(error instanceof PropertyValueError)) throw error;
      }
    }),
  );
  return {
    workspaceId: database.workspaceId,
    databaseId,
    props: own.props,
    lookups: { ...lookups, people: [...people.values()].map((p) => ({ ...p, email: null })) },
    people: [...people.values()],
    agents: agentRefs,
    databases: loaded,
    sequences: sequences.map((s) => ({ id: s.id, name: s.name })),
    views: views.map((v) => ({ id: v.id, name: v.name })),
  };
}

const quote = (text: string) => `"${text}"`;

function propertyRef(props: PropertyDef[], propertyId: string) {
  const prop = props.find((p) => p.id === propertyId);
  return { id: propertyId, name: propertyId === "title" ? "title" : (prop?.name ?? null) };
}

const personRef = (ctx: AutomationContext, userId: string): { id: string; name: string | null } => ({
  id: userId,
  name: ctx.people.find((p) => p.id === userId)?.name ?? null,
});

/** The value a "becomes" condition names, as the user would write it. */
function triggerValue(ctx: AutomationContext, propertyId: string, to: string | boolean) {
  if (typeof to === "boolean") return to;
  const prop = ctx.props.find((p) => p.id === propertyId);
  if (!prop) return to;
  if (holdsPeople(prop.type)) return personRef(ctx, to).name ?? to;
  const shown = displayValue(prop, prop.type === "multi_select" ? [to] : to);
  if (Array.isArray(shown)) return (shown[0] as string | undefined) ?? to;
  return typeof shown === "string" ? shown : to;
}

const listed = (parts: string[], word: string) =>
  parts.length < 2 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} ${word} ${parts[parts.length - 1]}`;

function describeSchedule(schedule: AutomationSchedule, timeZone: string) {
  const zone = ` (${timeZone})`;
  switch (schedule.frequency) {
    case "daily":
      return `Every day at ${schedule.time}${zone}`;
    case "weekly":
      return `Every ${listed(schedule.weekdays.map((d) => WEEKDAYS[d] ?? String(d)), "and")} at ${schedule.time}${zone}`;
    case "monthly":
      return `On day ${listed(schedule.days.map(String), "and")} of each month at ${schedule.time}${zone}`;
    default:
      return `On the cron schedule "${schedule.cron}"${zone}`;
  }
}

function describeTrigger(ctx: AutomationContext, trigger: AutomationTrigger, timeZone: string) {
  if (trigger.type === "row_created") return { type: "row_created", summary: "When a row is added" };
  if (trigger.type === "schedule") return { type: "schedule", schedule: trigger.schedule, summary: describeSchedule(trigger.schedule, timeZone) };
  if (trigger.type === "incoming_webhook") {
    return {
      type: "incoming_webhook",
      ...(trigger.example !== undefined ? { example: trigger.example } : {}),
      summary: "When a JSON POST arrives at the automation's address",
    };
  }
  if (trigger.type === "view_threshold") {
    const name = ctx.views.find((v) => v.id === trigger.viewId)?.name ?? null;
    const view = { id: trigger.viewId, name };
    const property = trigger.propertyId ? propertyRef(ctx.props, trigger.propertyId) : null;
    const what =
      trigger.fn === "count_all"
        ? "the number of rows"
        : `the ${trigger.fn} of ${property?.name !== null && property ? quote(property.name) : "a deleted property"}`;
    return {
      type: "view_threshold",
      view,
      calculation: trigger.fn,
      ...(property ? { property } : {}),
      comparison: trigger.comparison,
      value: trigger.value,
      summary: `When ${what} in ${name !== null ? `view ${quote(name)}` : "a deleted view"} goes ${trigger.comparison} ${trigger.value}`,
    };
  }
  if (trigger.type === "date_passed") {
    const date =
      trigger.date === "created_time" || trigger.date === "last_edited_time" ? trigger.date : propertyRef(ctx.props, trigger.date);
    const since =
      trigger.date === "created_time"
        ? "the row was added"
        : trigger.date === "last_edited_time"
          ? "the row was last edited"
          : typeof date === "object" && date.name !== null
            ? quote(date.name)
            : "a deleted date property";
    const status = trigger.status ? { property: propertyRef(ctx.props, trigger.status.propertyId), groups: trigger.status.groups } : null;
    const passed = trigger.days === 1 ? "1 day has" : `${trigger.days} days have`;
    const only = status ? `, for rows whose status is ${status.groups.join(" or ")}` : "";
    return { type: "date_passed", date, days: trigger.days, status, summary: `When ${passed} passed since ${since}${only}` };
  }
  const watched = watchedProperties(trigger);
  if (!watched.length) return { type: "property_changed", property: null, summary: "When any property of a row changes" };
  const label = (p: { name: string | null }) => (p.name !== null ? quote(p.name) : "a deleted property");
  if (watched.length > 1) {
    const properties = watched.map((p) => propertyRef(ctx.props, p));
    return { type: "property_changed", properties, summary: `When ${listed(properties.map(label), "or")} changes` };
  }
  const property = propertyRef(ctx.props, watched[0]);
  if (trigger.to === undefined || trigger.to === null) return { type: "property_changed", property, summary: `When ${label(property)} changes` };
  const to = triggerValue(ctx, watched[0], trigger.to);
  return { type: "property_changed", property, to, summary: `When ${label(property)} changes to ${JSON.stringify(to)}` };
}

/** Set values by property name (id for a deleted property), as the user would write them. */
function describeValues(info: DatabaseInfo | undefined, values: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [propertyId, value] of Object.entries(values)) {
    const prop = info?.props.find((p) => p.id === propertyId);
    const key = prop?.name ?? propertyId;
    if (isDynamicValue(value) || !prop || hasTemplate(value)) out[key] = value;
    else if (value === null || value === undefined || (Array.isArray(value) && !value.length)) out[key] = null;
    else out[key] = displayProperties([prop], { [prop.id]: value }, info!.lookups)[prop.name] ?? value;
  }
  return out;
}

const databaseRef = (ctx: AutomationContext, databaseId: string) => {
  const info = ctx.databases.get(databaseId);
  return { id: databaseId, title: info ? pageLabel(info.title) : null };
};
const databaseLabel = (ref: { id: string; title: string | null }) => (ref.title !== null ? quote(ref.title) : `the database ${ref.id}`);

function describeAction(ctx: AutomationContext, action: AutomationAction, all: AutomationAction[], ids: string[], stepId: string) {
  // A "for each" step acts on the rows of the database its find_rows step looks in.
  const over = forEachOf(action);
  const source = over ? all[ids.indexOf(over)] : undefined;
  const target = ctx.databases.get(source?.type === "find_rows" ? source.databaseId : ctx.databaseId);
  const each = over ? ` for each row of "${over}"` : "";
  const base = { id: stepId, ...(over ? { for_each: over } : {}) };
  switch (action.type) {
    case "set_properties": {
      const values = describeValues(target, action.values);
      const parts = Object.entries(values).map(([name, value]) =>
        isDynamicValue(value)
          ? `${quote(name)} to ${value.$ === "now" ? "the day it runs" : "whoever made the change"}`
          : `${quote(name)} to ${JSON.stringify(value)}`,
      );
      return { ...base, type: "set_properties", values, summary: `Set ${parts.join(", ")}${each}` };
    }
    case "notify": {
      const people = action.userIds.map((u) => personRef(ctx, u));
      const properties = action.propertyIds.map((p) => propertyRef(target?.props ?? [], p));
      const who = [
        ...people.map((p) => p.name ?? p.id),
        ...properties.map((p) => `the people in ${p.name !== null ? quote(p.name) : "a deleted property"}`),
      ];
      return {
        ...base,
        type: "notify",
        people,
        properties,
        ...(action.message ? { message: action.message } : {}),
        summary: `Notify ${who.join(", ")}${each}`,
      };
    }
    case "run_agent": {
      const agent = { id: action.agentId, name: ctx.agents.find((a) => a.id === action.agentId)?.name ?? null };
      return {
        ...base,
        type: "run_agent",
        agent,
        prompt: action.prompt,
        summary: `Run the agent ${agent.name !== null ? quote(agent.name) : agent.id} on ${over ? `each row of "${over}"` : "the row"}`,
      };
    }
    case "move_to_trash":
      return { ...base, type: "move_to_trash", summary: "Move the row to the trash" };
    case "webhook":
      return { ...base, type: "webhook", url: action.url, summary: `POST the row to ${action.url}` };
    case "http_request":
      return {
        ...base,
        type: "http_request",
        method: action.method,
        url: action.url,
        headers: action.headers,
        ...(action.body !== undefined ? { body: action.body } : {}),
        summary: `${action.method} ${action.url}`,
      };
    case "find_rows": {
      const database = databaseRef(ctx, action.databaseId);
      const info = ctx.databases.get(action.databaseId);
      const config = { filters: action.filters ?? [], filterCombinator: action.filterCombinator, sorts: action.sorts ?? [] } as ViewConfig;
      const query = info
        ? describeViewConfig(info.props, config, info.lookups)
        : {
            ...(action.filters?.length ? { filters: action.filters } : {}),
            ...(action.filterCombinator === "or" ? { filter_combinator: "or" } : {}),
            ...(action.sorts?.length ? { sorts: action.sorts } : {}),
          };
      const filtered = filterRules(action.filters ?? []).length ? " matching its filters" : "";
      return { ...base, type: "find_rows", database, ...query, limit: action.limit, summary: `Find up to ${action.limit} rows of ${databaseLabel(database)}${filtered}` };
    }
    case "create_row": {
      const database = databaseRef(ctx, action.databaseId);
      return {
        ...base,
        type: "create_row",
        database,
        ...(action.title ? { title: action.title } : {}),
        ...(action.template ? { template: action.template } : {}),
        values: describeValues(ctx.databases.get(action.databaseId), action.values),
        summary: `Add a row to ${databaseLabel(database)}`,
      };
    }
    case "upsert_row": {
      const database = databaseRef(ctx, action.databaseId);
      const info = ctx.databases.get(action.databaseId);
      const match = { property: propertyRef(info?.props ?? [], action.matchPropertyId), value: action.matchValue };
      const by = match.property.name !== null ? quote(match.property.name) : "a deleted property";
      return {
        ...base,
        type: "upsert_row",
        database,
        match,
        ...(action.title ? { title: action.title } : {}),
        values: describeValues(info, action.values),
        summary: `Change the row of ${databaseLabel(database)} whose ${by} is ${quote(action.matchValue)}, or add one`,
      };
    }
    case "wait":
      return { ...base, type: "wait", minutes: action.minutes, summary: `Wait ${action.minutes === 1 ? "1 minute" : `${action.minutes} minutes`}` };
    case "log":
      return { ...base, type: "log", message: action.message, summary: `Log ${quote(action.message)}` };
    case "celebrate":
      return { ...base, type: "celebrate", summary: "Confetti for whoever made the change" };
    case "slack":
      return { ...base, type: "slack", url: action.hint, message: action.message, summary: `Send to Slack (${action.hint})` };
    case "start_sequence": {
      const sequence = { id: action.sequenceId, name: ctx.sequences.find((s) => s.id === action.sequenceId)?.name ?? null };
      return {
        ...base,
        type: "start_sequence",
        sequence,
        summary: `Start the follow-up ${sequence.name !== null ? quote(sequence.name) : sequence.id} on ${over ? `each row of "${over}"` : "the row"}`,
      };
    }
    case "approval": {
      const people = action.userIds.map((u) => personRef(ctx, u));
      const properties = action.propertyIds.map((p) => propertyRef(ctx.props, p));
      const who = [
        ...people.map((p) => p.name ?? p.id),
        ...properties.map((p) => `the people in ${p.name !== null ? quote(p.name) : "a deleted property"}`),
      ];
      const days = action.timeoutDays === 1 ? "1 day" : `${action.timeoutDays} days`;
      return {
        ...base,
        type: "approval",
        people,
        properties,
        ...(action.message ? { message: action.message } : {}),
        timeout_days: action.timeoutDays,
        on_timeout: action.onTimeout,
        summary: `Ask ${listed(who, "or")} to approve; unanswered after ${days}, ${action.onTimeout === "continue" ? "go on" : "stop"}`,
      };
    }
  }
}

const describeSteps = (ctx: AutomationContext, actions: AutomationAction[]) => {
  const ids = stepIds(actions);
  return actions.map((a, i) => describeAction(ctx, a, actions, ids, ids[i]));
};

/** An automation as list_automations and the write tools return it. */
export function describeAutomation(ctx: AutomationContext, automation: AutomationView) {
  const { draft } = automation;
  return {
    id: automation.id,
    name: automation.name,
    enabled: automation.enabled,
    database_id: automation.databaseId,
    /** The published version; 0 while only a draft was saved (it doesn't run). */
    version: automation.version,
    trigger: describeTrigger(ctx, automation.trigger, automation.timeZone),
    actions: describeSteps(ctx, automation.actions),
    /** The zone a schedule runs in and a "date_passed" trigger counts days in (that of whoever saved it last). */
    time_zone: automation.timeZone,
    ...(draft
      ? {
          draft: {
            trigger: describeTrigger(ctx, draft.trigger, draft.timeZone),
            actions: describeSteps(ctx, draft.actions),
            time_zone: draft.timeZone,
            saved_at: draft.savedAt,
          },
        }
      : {}),
    run_as: automation.runAs,
    last_run: automation.lastRun,
    ...(automation.nextRunAt ? { next_run_at: automation.nextRunAt } : {}),
    ...(automation.checkError ? { check_error: automation.checkError } : {}),
    ...(automation.secret ? { webhook_secret: automation.secret } : {}),
    ...(automation.hookUrl ? { hook_url: automation.hookUrl } : {}),
    created_at: automation.createdAt,
    updated_at: automation.updatedAt,
    url: pageUrl(ctx.workspaceId, automation.databaseId),
  };
}

/** A run as list_automation_runs returns it. */
export function describeRun(run: AutomationRunView) {
  return {
    id: run.id,
    event: run.event,
    ...(run.basis !== null ? { date: run.basis } : {}),
    status: run.status,
    version: run.version,
    ...(run.test ? { test: true } : {}),
    ...(run.draft ? { draft: true } : {}),
    row: run.rowId !== null ? { id: run.rowId, title: run.rowTitle } : null,
    ...(run.trigger !== null && run.trigger !== undefined ? { trigger: run.trigger } : {}),
    steps: run.steps.map((s) => ({
      ...(s.id ? { id: s.id } : {}),
      type: s.type,
      status: s.status,
      attempts: s.attempts,
      ...(s.code ? { code: s.code } : {}),
      ...(s.error ? { error: s.error } : {}),
      ...(s.httpStatus ? { http_status: s.httpStatus } : {}),
      ...(s.notified !== undefined ? { notified: s.notified } : {}),
      ...(s.agentRunId ? { agent_run_id: s.agentRunId } : {}),
      ...(s.agentRunIds?.length ? { agent_run_ids: s.agentRunIds } : {}),
      ...(s.startedAt ? { started_at: s.startedAt } : {}),
      ...(s.durationMs !== undefined ? { duration_ms: s.durationMs } : {}),
      ...(s.waitUntil ? { wait_until: s.waitUntil } : {}),
      ...(s.approval
        ? {
            approval: {
              ...(s.approval.changeId ? { change_id: s.approval.changeId } : {}),
              approvers: s.approval.approvers.map((a) => a.name),
              expires_at: s.approval.expiresAt,
              ...(s.approval.test ? { test: true } : {}),
              ...(s.approval.answer ? { answer: s.approval.answer === "timedOut" ? "timed_out" : s.approval.answer } : {}),
              ...(s.approval.answeredBy ? { answered_by: s.approval.answeredBy.name } : {}),
              ...(s.approval.answeredAt ? { answered_at: s.approval.answeredAt } : {}),
            },
          }
        : {}),
      ...(s.input !== undefined ? { input: s.input } : {}),
      ...(s.output !== undefined ? { output: s.output } : {}),
      ...(s.items?.length ? { items: s.items.map((item) => ({ row_id: item.rowId, title: item.title, status: item.status, ...(item.code ? { code: item.code } : {}), ...(item.error ? { error: item.error } : {}) })) } : {}),
    })),
    created_at: run.createdAt,
    finished_at: run.finishedAt,
  };
}

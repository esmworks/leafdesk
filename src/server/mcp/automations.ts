import * as z from "zod";
import {
  isDynamicValue,
  MAX_AUTOMATION_ACTIONS,
  MAX_AUTOMATION_NAME,
  MAX_NOTIFY_PEOPLE,
  MAX_WEBHOOK_URL,
  type AutomationAction,
  type AutomationTrigger,
} from "@/lib/automations";
import { displayValue, PropertyValueError } from "@/lib/properties";
import { holdsPeople } from "@/lib/property-types";
import type { AutomationInput, AutomationRunView, AutomationView } from "@/server/automations/manage";
import * as databases from "@/server/databases";
import { id, rowValue } from "@/server/operations";
import * as workspaces from "@/server/workspaces";
import { pageUrl, ToolInputError } from "./format";
import { displayProperties, type Lookups, type PropertyDef } from "./query";

/**
 * Database automations over MCP: the tools' input schemas, turning their input into what
 * server/automations/manage takes, and stored automations (ids) back into names a model can read.
 */

const triggerInput = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("row_created") }),
    z.object({
      type: z.literal("property_changed"),
      property: z
        .string()
        .min(1)
        .optional()
        .describe("The property, by name or id. Leave out to run when any property of an existing row changes."),
      to: z
        .union([z.string(), z.boolean()])
        .optional()
        .describe(
          'Only when the value becomes this: an option name (select, status, multi-select: when it gets added), true or false (checkbox), or a person (id, email, name or "me"; when they get added). Needs property.',
        ),
    }),
  ])
  .describe(
    'What starts the automation: {"type": "row_created"} when a row is added (in the app, a form, an import, MCP or the API), or {"type": "property_changed", "property": "Status", "to": "Done"} when a value changes.',
  );

const dynamicValue = z
  .object({ $: z.enum(["now", "actor"]) })
  .describe('{"$": "now"} sets a date to the day the automation runs; {"$": "actor"} sets a person to whoever made the change.');

const actionInput = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("set_properties"),
    values: z
      .record(z.string(), z.union([rowValue, dynamicValue]))
      .describe(
        'Values to set on the row, keyed by property name or id, written as for update_database_row (option names, YYYY-MM-DD dates, people as ids, emails, names or "me", null to clear), or {"$": "now"} for a date and {"$": "actor"} for a person. Example: {"Status": "Done", "Completed": {"$": "now"}, "Reviewer": {"$": "actor"}}.',
      ),
  }),
  z.object({
    type: z.literal("notify"),
    people: z
      .array(z.string().min(1))
      .max(MAX_NOTIFY_PEOPLE)
      .optional()
      .describe('People to notify: user ids, emails, names or "me".'),
    properties: z
      .array(z.string().min(1))
      .max(50)
      .optional()
      .describe("Person properties (name or id): whoever the row names in them is notified too."),
  }),
  z.object({
    type: z.literal("webhook"),
    url: z.string().min(1).max(MAX_WEBHOOK_URL).describe("The http(s) address the signed JSON POST goes to."),
  }),
]);

const actionsInput = z
  .array(actionInput)
  .min(1)
  .max(MAX_AUTOMATION_ACTIONS)
  .describe(
    "What the automation does, in order: set_properties, notify (an inbox notification, and an email as each person chooses, to people who can open the row) or webhook.",
  );

const nameInput = z.string().min(1).max(MAX_AUTOMATION_NAME);

export const automationInputs = {
  list: z.object({ database_id: id("database") }),
  create: z.object({
    database_id: id("database"),
    name: nameInput.describe("A name for the automation, shown in the database's automations."),
    enabled: z.boolean().optional().describe("Whether it runs (default true)."),
    trigger: triggerInput,
    actions: actionsInput,
  }),
  // No defaults here: what is left out stays as it is.
  update: z.object({
    automation_id: id("automation"),
    name: nameInput.optional(),
    enabled: z.boolean().optional().describe("Turn the automation on or off."),
    trigger: triggerInput.optional(),
    actions: actionsInput.optional().describe("Replaces all of the automation's actions."),
  }),
  automationId: z.object({ automation_id: id("automation") }),
  runs: z.object({
    automation_id: id("automation"),
    limit: z.number().int().min(1).max(100).default(20).describe("Maximum runs (1-100, default 20)."),
  }),
};

type TriggerArg = z.infer<typeof triggerInput>;
type ActionsArg = z.infer<typeof actionsInput>;

const toTrigger = (trigger: TriggerArg): AutomationInput["trigger"] =>
  trigger.type === "row_created"
    ? { type: "row_created" }
    : { type: "property_changed", property: trigger.property ?? null, ...(trigger.to !== undefined ? { to: trigger.to } : {}) };

const toActions = (actions: ActionsArg): AutomationInput["actions"] =>
  actions.map((a) =>
    a.type === "set_properties"
      ? { type: "set_properties", values: a.values }
      : a.type === "notify"
        ? { type: "notify", people: a.people ?? [], properties: a.properties ?? [] }
        : { type: "webhook", url: a.url },
  );

/** create_automation's arguments as manage.createAutomation takes them. */
export function toAutomationInput(args: { name: string; enabled?: boolean; trigger: TriggerArg; actions: ActionsArg }): AutomationInput {
  return {
    name: args.name,
    ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
    trigger: toTrigger(args.trigger),
    actions: toActions(args.actions),
  };
}

/** update_automation's arguments as a patch: only what was given. */
export function toAutomationPatch(args: {
  name?: string;
  enabled?: boolean;
  trigger?: TriggerArg;
  actions?: ActionsArg;
}): Partial<AutomationInput> {
  const patch: Partial<AutomationInput> = {};
  if (args.name !== undefined) patch.name = args.name;
  if (args.enabled !== undefined) patch.enabled = args.enabled;
  if (args.trigger !== undefined) patch.trigger = toTrigger(args.trigger);
  if (args.actions !== undefined) patch.actions = toActions(args.actions);
  if (!Object.keys(patch).length) throw new ToolInputError("Nothing to change: pass name, enabled, trigger or actions.");
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

/** What it takes to name a database's properties, options and people. */
export type AutomationContext = { workspaceId: string; props: PropertyDef[]; lookups: Lookups; people: Person[] };

export async function automationContext(userId: string, databaseId: string): Promise<AutomationContext> {
  const { database, properties } = await databases.getDatabase(userId, databaseId);
  const [lookups, members] = await Promise.all([
    databases.getLookups(userId, properties),
    workspaces.workspacePeople(database.workspaceId),
  ]);
  const people = new Map<string, Person>();
  for (const p of [...lookups.people, ...members]) if (!people.has(p.id)) people.set(p.id, { id: p.id, name: p.name });
  return {
    workspaceId: database.workspaceId,
    props: properties as PropertyDef[],
    lookups: { ...lookups, people: [...people.values()].map((p) => ({ ...p, email: null })) },
    people: [...people.values()],
  };
}

const quote = (text: string) => `"${text}"`;

function propertyRef(ctx: AutomationContext, propertyId: string) {
  const prop = ctx.props.find((p) => p.id === propertyId);
  return { id: propertyId, name: prop?.name ?? null };
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

function describeTrigger(ctx: AutomationContext, trigger: AutomationTrigger) {
  if (trigger.type === "row_created") return { type: "row_created", summary: "When a row is added" };
  if (trigger.propertyId === null) return { type: "property_changed", property: null, summary: "When any property of a row changes" };
  const property = propertyRef(ctx, trigger.propertyId);
  const label = property.name !== null ? quote(property.name) : "a deleted property";
  if (trigger.to === undefined || trigger.to === null) return { type: "property_changed", property, summary: `When ${label} changes` };
  const to = triggerValue(ctx, trigger.propertyId, trigger.to);
  return { type: "property_changed", property, to, summary: `When ${label} changes to ${JSON.stringify(to)}` };
}

/** Set values by property name (id for a deleted property), as the user would write them. */
function describeValues(ctx: AutomationContext, values: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [propertyId, value] of Object.entries(values)) {
    const prop = ctx.props.find((p) => p.id === propertyId);
    const key = prop?.name ?? propertyId;
    if (isDynamicValue(value) || !prop) out[key] = value;
    else if (value === null || value === undefined || (Array.isArray(value) && !value.length)) out[key] = null;
    else out[key] = displayProperties([prop], { [prop.id]: value }, ctx.lookups)[prop.name] ?? value;
  }
  return out;
}

function describeAction(ctx: AutomationContext, action: AutomationAction) {
  if (action.type === "set_properties") {
    const values = describeValues(ctx, action.values);
    const parts = Object.entries(values).map(([name, value]) =>
      isDynamicValue(value)
        ? `${quote(name)} to ${value.$ === "now" ? "the day it runs" : "whoever made the change"}`
        : `${quote(name)} to ${JSON.stringify(value)}`,
    );
    return { type: "set_properties", values, summary: `Set ${parts.join(", ")}` };
  }
  if (action.type === "notify") {
    const people = action.userIds.map((u) => personRef(ctx, u));
    const properties = action.propertyIds.map((p) => propertyRef(ctx, p));
    const who = [
      ...people.map((p) => p.name ?? p.id),
      ...properties.map((p) => `the people in ${p.name !== null ? quote(p.name) : "a deleted property"}`),
    ];
    return { type: "notify", people, properties, summary: `Notify ${who.join(", ")}` };
  }
  return { type: "webhook", url: action.url, summary: `POST the row to ${action.url}` };
}

/** An automation as list_automations and the write tools return it. */
export function describeAutomation(ctx: AutomationContext, automation: AutomationView) {
  return {
    id: automation.id,
    name: automation.name,
    enabled: automation.enabled,
    database_id: automation.databaseId,
    trigger: describeTrigger(ctx, automation.trigger),
    actions: automation.actions.map((a) => describeAction(ctx, a)),
    run_as: automation.runAs,
    last_run: automation.lastRun,
    ...(automation.secret ? { webhook_secret: automation.secret } : {}),
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
    status: run.status,
    row: { id: run.rowId, title: run.rowTitle },
    steps: run.steps.map((s) => ({
      type: s.type,
      status: s.status,
      attempts: s.attempts,
      ...(s.code ? { code: s.code } : {}),
      ...(s.error ? { error: s.error } : {}),
      ...(s.httpStatus ? { http_status: s.httpStatus } : {}),
      ...(s.notified !== undefined ? { notified: s.notified } : {}),
    })),
    created_at: run.createdAt,
    finished_at: run.finishedAt,
  };
}

import { and, asc, count, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { automationRun, databaseAutomation, page, user, workspaceAgent } from "@/db/schema";
import { MAX_AGENT_PROMPT } from "@/lib/agents";
import {
  isDynamicValue,
  MAX_AUTOMATION_ACTIONS,
  MAX_AUTOMATION_NAME,
  MAX_AUTOMATIONS,
  MAX_DATE_PASSED_DAYS,
  MAX_NOTIFY_PEOPLE,
  runEvent,
  TO_VALUE_TYPES,
  trashProblem,
  UNSETTABLE_TYPES,
  type AutomationAction,
  type AutomationRunStatus,
  type AutomationStep,
  type AutomationTrigger,
  type DatePassedTrigger,
} from "@/lib/automations";
import { pageLabel } from "@/lib/labels";
import { PropertyValueError } from "@/lib/properties";
import { holdsPeople, STATUS_GROUPS, type StatusGroup } from "@/lib/property-types";
import { isTimeZone } from "@/lib/time-zone";
import { getMembership, pageVisibleTo } from "@/server/access";
import { LinkPreviewError } from "@/server/link-preview";
import { recordAudit } from "@/server/audit";
import { releaseDatabaseFromAgents, shareDatabaseWithAgents } from "@/server/agents/manage";
import { getProperties, normalizeRowProperties, requireDatabase } from "@/server/databases";
import { exportAllowed, workspacePeople } from "@/server/workspaces";
import { countDatePassedMatches, forgetFired } from "./timed";
import { newSecretSalt, parseWebhookUrl, sendWebhook, WebhookError, webhookSecret, webhookTarget } from "./webhook";

/**
 * Managing a database's automations. Only people with full access to the database see or change
 * them (as with its properties' access rules): an automation acts with its saver's access, and its
 * webhooks send rows out of the workspace. Saving one makes the saver the person it runs as.
 *
 * Input names properties by id or (case-insensitive) name, and people by id, email, name or "me",
 * so MCP clients can write them as they read them; what is stored is ids only.
 */

/** An automation as typed: properties and people by id or name (see above). */
export type AutomationInput = {
  name: string;
  enabled?: boolean;
  /**
   * The saver's IANA time zone, which a "date passed" trigger counts days in: UTC for a new
   * automation without one; an update without one keeps the stored zone.
   */
  timeZone?: string;
  trigger:
    | { type: "row_created" }
    | { type: "property_changed"; property?: string | null; to?: unknown }
    /**
     * `date`: a date property, or "created_time" / "last_edited_time" (a created or edited time
     * property names those too). `status`: the status property (the database's only one when left
     * out) and the groups its value is in.
     */
    | { type: "date_passed"; date: string; days: number; status?: { property?: string | null; groups: string[] } | null };
  actions: (
    | { type: "set_properties"; values: Record<string, unknown> }
    | { type: "notify"; people?: string[]; properties?: string[] }
    | { type: "webhook"; url: string }
    /** The agent by id or name; the task it's given. */
    | { type: "run_agent"; agent: string; prompt?: string }
    | { type: "move_to_trash" }
  )[];
};

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

/** A date passing has nobody whose change started it: "actor" would set nobody. */
function checkActorFits(trigger: AutomationTrigger, actions: AutomationAction[]) {
  if (trigger.type !== "date_passed") return;
  const actor = actions.some(
    (a) => a.type === "set_properties" && Object.values(a.values).some((v) => isDynamicValue(v) && v.$ === "actor"),
  );
  if (actor) throw invalid('"actor" is whoever made the change that started the automation, and a date passing has nobody: name people instead');
}

async function checkTrigger(userId: string, databaseId: string, props: Prop[], input: AutomationInput["trigger"]): Promise<AutomationTrigger> {
  if (input?.type === "row_created") return { type: "row_created" };
  if (input?.type === "date_passed") return checkDatePassed(props, input);
  if (input?.type !== "property_changed") throw invalid('The trigger is "row_created", "property_changed" or "date_passed"');
  if (!input.property) {
    if (input.to !== undefined && input.to !== null) throw invalid('"to" needs a property');
    return { type: "property_changed", propertyId: null };
  }
  const prop = findProperty(props, input.property);
  if (input.to === undefined || input.to === null || input.to === "") return { type: "property_changed", propertyId: prop.id };
  if (!(TO_VALUE_TYPES as readonly string[]).includes(prop.type)) {
    throw invalid(`"${prop.name}" is a ${prop.type} property: only select, status, checkbox, person and multi-select properties take a value to change to`);
  }
  const normalized = (await normalizeRowProperties(userId, databaseId, { [prop.id]: input.to }, {}, { check: false }))[prop.id];
  const to = Array.isArray(normalized) ? normalized[0] : normalized;
  if (typeof to !== "string" && typeof to !== "boolean") throw invalid(`"${prop.name}" needs a value to change to`);
  return { type: "property_changed", propertyId: prop.id, to };
}

/** `current`: the automation's actions as saved, which anyone who may change it may keep as they are. */
async function checkActions(
  userId: string,
  databaseId: string,
  workspaceId: string,
  props: Prop[],
  input: AutomationInput["actions"],
  current: AutomationAction[] = [],
) {
  if (!Array.isArray(input) || !input.length) throw invalid("An automation needs at least one action");
  if (input.length > MAX_AUTOMATION_ACTIONS) throw invalid(`At most ${MAX_AUTOMATION_ACTIONS} actions`);
  let people: Awaited<ReturnType<typeof workspacePeople>> | undefined;
  let owner: boolean | undefined;
  const out: AutomationAction[] = [];
  for (const action of input) {
    if (action?.type === "set_properties") {
      const literal: Record<string, unknown> = {};
      const values: Record<string, unknown> = {};
      for (const [ref, value] of Object.entries(action.values ?? {})) {
        const prop = findProperty(props, ref);
        if ((UNSETTABLE_TYPES as readonly string[]).includes(prop.type)) {
          throw new PropertyValueError(`"${prop.name}" is computed and can't be set`, "readOnlyProperty", { property: prop.name });
        }
        if (isDynamicValue(value)) {
          if (value.$ === "now" && prop.type !== "date") throw invalid(`"now" sets date properties; "${prop.name}" is a ${prop.type} property`);
          if (value.$ === "actor" && prop.type !== "person") throw invalid(`"actor" sets person properties; "${prop.name}" is a ${prop.type} property`);
          values[prop.id] = value;
        } else literal[prop.id] = value;
      }
      Object.assign(values, await normalizeRowProperties(userId, databaseId, literal, {}));
      if (!Object.keys(values).length) throw invalid("Setting properties needs at least one value");
      out.push({ type: "set_properties", values });
    } else if (action?.type === "notify") {
      const refs = action.people ?? [];
      people ??= await workspacePeople(workspaceId);
      // Guests name people by id only, as in person properties (resolvePersonValue): matching an
      // address or a name would tell them who is in the workspace, and under which address.
      const byEmailOrName = people.find((p) => p.id === userId)?.role !== "guest";
      const userIds = [
        ...new Set(
          refs.map((ref) => {
            if (ref === "me") return userId;
            const needle = ref.trim().toLowerCase();
            const person =
              people!.find((p) => p.id === ref) ??
              (byEmailOrName
                ? (people!.find((p) => p.email.toLowerCase() === needle) ?? people!.find((p) => p.name.toLowerCase() === needle))
                : undefined);
            if (!person) throw invalid(`"${ref}" is not in this workspace`, { value: ref });
            return person.id;
          }),
        ),
      ];
      const propertyIds = [
        ...new Set(
          (action.properties ?? []).map((ref) => {
            const prop = findProperty(props, ref);
            if (!holdsPeople(prop.type)) throw invalid(`"${prop.name}" is not a person property`);
            return prop.id;
          }),
        ),
      ];
      if (!userIds.length && !propertyIds.length) throw invalid("A notification needs people or a person property");
      if (userIds.length > MAX_NOTIFY_PEOPLE) throw invalid(`At most ${MAX_NOTIFY_PEOPLE} people`);
      out.push({ type: "notify", userIds, propertyIds });
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
      if (!kept && !(await exportAllowed(workspaceId))) {
        throw new PropertyValueError("The workspace's owners turned export off, so automations can't send webhooks", "webhookExportOff", {});
      }
      out.push({ type: "webhook", url: url.toString() });
    } else if (action?.type === "run_agent") {
      const ref = String(action.agent ?? "").trim();
      const agents = await db
        .select({ id: workspaceAgent.id, name: workspaceAgent.name })
        .from(workspaceAgent)
        .where(and(eq(workspaceAgent.workspaceId, workspaceId), isNull(workspaceAgent.archivedAt)));
      const agent = agents.find((a) => a.id === ref) ?? agents.find((a) => a.name.toLowerCase() === ref.toLowerCase());
      if (!agent) throw invalid(`"${ref}" is not an agent of this workspace`, { value: ref });
      const prompt = typeof action.prompt === "string" ? action.prompt.trim() : "";
      if (prompt.length > MAX_AGENT_PROMPT) throw invalid(`An agent's task may have at most ${MAX_AGENT_PROMPT} characters`);
      // The task is written by whoever saves it and the agent may open pages they can't: only
      // owners, who choose what agents may open, give agents tasks. Others may keep one as it is.
      const kept = current.some((a) => a.type === "run_agent" && a.agentId === agent.id && a.prompt === prompt);
      if (!kept) {
        owner ??= (await getMembership(userId, workspaceId))?.role === "owner";
        if (!owner) throw new PropertyValueError("Only owners of the workspace add or change actions that run an agent", "agentOwnersOnly", {});
      }
      out.push({ type: "run_agent", agentId: agent.id, prompt });
    } else if (action?.type === "move_to_trash") {
      out.push({ type: "move_to_trash" });
    } else throw invalid('Each action is "set_properties", "notify", "webhook", "run_agent" or "move_to_trash"');
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

/** The agents the actions run. */
const agentsOf = (actions: AutomationAction[]) => [...new Set(actions.flatMap((a) => (a.type === "run_agent" ? [a.agentId] : [])))];

const auditDetails = (a: { name: string; enabled: boolean; trigger: AutomationTrigger; actions: AutomationAction[] }) => ({
  name: a.name,
  enabled: a.enabled,
  trigger: a.trigger.type,
  actions: a.actions.map((x) => x.type).join(", "),
  webhooks: a.actions.flatMap((x) => (x.type === "webhook" ? [new URL(x.url).host] : [])).join(", ") || undefined,
});

export async function createAutomation(userId: string, databaseId: string, input: AutomationInput) {
  const database = await requireDatabase(userId, databaseId, "full");
  const props = await getProperties(databaseId);
  const name = checkName(input.name);
  const timeZone = checkTimeZone(input.timeZone, "UTC");
  const trigger = await checkTrigger(userId, databaseId, props, input.trigger);
  const actions = await checkActions(userId, databaseId, database.workspaceId, props, input.actions);
  checkActorFits(trigger, actions);
  const [{ n }] = await db.select({ n: count() }).from(databaseAutomation).where(eq(databaseAutomation.databaseId, databaseId));
  if (n >= MAX_AUTOMATIONS) {
    throw new PropertyValueError(`A database has at most ${MAX_AUTOMATIONS} automations`, "tooManyAutomations", { max: String(MAX_AUTOMATIONS) });
  }
  const enabled = input.enabled ?? true;
  const [created] = await db
    .insert(databaseAutomation)
    .values({
      databaseId,
      workspaceId: database.workspaceId,
      name,
      enabled,
      trigger,
      actions,
      timeZone,
      secretSalt: newSecretSalt(),
      runAs: userId,
      createdBy: userId,
    })
    .returning();
  // The agents it runs get edit access to the database, to read and change the rows they run on.
  await shareDatabaseWithAgents(userId, databaseId, agentsOf(actions));
  await recordAudit({
    workspaceId: database.workspaceId,
    actorId: userId,
    action: "automation.created",
    target: { type: "page", id: databaseId },
    details: auditDetails(created),
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

/** Changes an automation; what `patch` leaves out stays as it was. The saver becomes who it runs as. */
export async function updateAutomation(userId: string, automationId: string, patch: Partial<AutomationInput>) {
  const current = await manageable(userId, automationId);
  const props = await getProperties(current.databaseId);
  const name = patch.name !== undefined ? checkName(patch.name) : current.name;
  const timeZone = checkTimeZone(patch.timeZone, current.timeZone);
  const trigger = patch.trigger !== undefined ? await checkTrigger(userId, current.databaseId, props, patch.trigger) : current.trigger;
  const actions =
    patch.actions !== undefined
      ? await checkActions(userId, current.databaseId, current.workspaceId, props, patch.actions, current.actions)
      : current.actions;
  checkActorFits(trigger, actions);
  const enabled = patch.enabled ?? current.enabled;
  const [updated] = await db
    .update(databaseAutomation)
    .set({ name, trigger, actions, enabled, timeZone, runAs: userId, checkError: null })
    .where(eq(databaseAutomation.id, automationId))
    .returning();
  // Counting from another date makes every row new to it; other changes keep what it ran for.
  if (current.trigger.type === "date_passed" && (trigger.type !== "date_passed" || trigger.date !== current.trigger.date)) {
    await forgetFired(automationId);
  }
  if (patch.actions !== undefined) {
    await shareDatabaseWithAgents(userId, current.databaseId, agentsOf(actions));
    const kept = new Set(agentsOf(actions));
    await releaseDatabaseFromAgents(userId, current.databaseId, agentsOf(current.actions).filter((id) => !kept.has(id)));
  }
  await recordAudit({
    workspaceId: current.workspaceId,
    actorId: userId,
    action: "automation.updated",
    target: { type: "page", id: current.databaseId },
    details: { ...auditDetails(updated), previous: auditDetails(current) },
  });
  return (await describe([updated]))[0];
}

export async function deleteAutomation(userId: string, automationId: string) {
  const current = await manageable(userId, automationId);
  await db.delete(databaseAutomation).where(eq(databaseAutomation.id, automationId));
  await releaseDatabaseFromAgents(userId, current.databaseId, agentsOf(current.actions));
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
  for (const action of automation.actions) {
    if (action.type !== "webhook") continue;
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

/** Automations as the settings show them: who they run as, their secret and their latest run. */
async function describe(automations: (typeof databaseAutomation.$inferSelect)[]) {
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
      .where(inArray(automationRun.automationId, ids))
      .orderBy(automationRun.automationId, desc(automationRun.createdAt)),
  ]);
  return automations.map((a) => {
    const last = latest.find((r) => r.automationId === a.id);
    return {
      id: a.id,
      databaseId: a.databaseId,
      name: a.name,
      enabled: a.enabled,
      trigger: a.trigger,
      actions: a.actions,
      /** The time zone a "date passed" trigger counts days in. */
      timeZone: a.timeZone,
      runAs: a.runAs ? { id: a.runAs, name: names.find((n) => n.id === a.runAs)?.name ?? "" } : null,
      /** Only automations with a webhook have one to show. */
      secret: a.actions.some((x) => x.type === "webhook") ? webhookSecret(a.secretSalt) : null,
      lastRun: last ? { status: last.status as AutomationRunStatus, at: last.createdAt.toISOString() } : null,
      /** "Date passed": why the last check couldn't look for rows (see AutomationCheckError). */
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
  rowId: string;
  rowTitle: string;
  event: string;
  /** A "date passed" run: the row's date it ran for. */
  basis: string | null;
  status: AutomationRunStatus;
  steps: AutomationStep[];
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
      status: automationRun.status,
      steps: automationRun.steps,
      createdAt: automationRun.createdAt,
      finishedAt: automationRun.finishedAt,
    })
    .from(automationRun)
    .innerJoin(page, eq(page.id, automationRun.rowId))
    // Rows the person can't see stay out, title and all.
    .where(and(eq(automationRun.automationId, automationId), pageVisibleTo(userId)))
    .orderBy(desc(automationRun.createdAt))
    .limit(Math.min(Math.max(limit, 1), 100));
  return runs.map((r) => ({
    id: r.id,
    rowId: r.rowId,
    rowTitle: pageLabel(r.rowTitle),
    event: runEvent(r),
    basis: r.basis,
    status: r.status,
    steps: r.steps,
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

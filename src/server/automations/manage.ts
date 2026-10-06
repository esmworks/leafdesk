import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { automationRun, databaseAutomation, page, user } from "@/db/schema";
import {
  isDynamicValue,
  MAX_AUTOMATION_ACTIONS,
  MAX_AUTOMATION_NAME,
  MAX_AUTOMATIONS,
  MAX_NOTIFY_PEOPLE,
  TO_VALUE_TYPES,
  UNSETTABLE_TYPES,
  webhookEvent,
  type AutomationAction,
  type AutomationRunStatus,
  type AutomationStep,
  type AutomationTrigger,
} from "@/lib/automations";
import { pageLabel } from "@/lib/labels";
import { PropertyValueError } from "@/lib/properties";
import { holdsPeople } from "@/lib/property-types";
import { pageVisibleTo } from "@/server/access";
import { LinkPreviewError } from "@/server/link-preview";
import { recordAudit } from "@/server/audit";
import { getProperties, normalizeRowProperties, requireDatabase } from "@/server/databases";
import { workspacePeople } from "@/server/workspaces";
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
  trigger:
    | { type: "row_created" }
    | { type: "property_changed"; property?: string | null; to?: unknown };
  actions: (
    | { type: "set_properties"; values: Record<string, unknown> }
    | { type: "notify"; people?: string[]; properties?: string[] }
    | { type: "webhook"; url: string }
  )[];
};

type Prop = Awaited<ReturnType<typeof getProperties>>[number];

const invalid = (message: string, params: Record<string, string> = {}) =>
  new PropertyValueError(message, "invalidAutomation", { reason: message, ...params });

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

async function checkTrigger(userId: string, databaseId: string, props: Prop[], input: AutomationInput["trigger"]): Promise<AutomationTrigger> {
  if (input?.type === "row_created") return { type: "row_created" };
  if (input?.type !== "property_changed") throw invalid('The trigger is "row_created" or "property_changed"');
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

async function checkActions(userId: string, databaseId: string, workspaceId: string, props: Prop[], input: AutomationInput["actions"]) {
  if (!Array.isArray(input) || !input.length) throw invalid("An automation needs at least one action");
  if (input.length > MAX_AUTOMATION_ACTIONS) throw invalid(`At most ${MAX_AUTOMATION_ACTIONS} actions`);
  let people: Awaited<ReturnType<typeof workspacePeople>> | undefined;
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
      const userIds = [
        ...new Set(
          refs.map((ref) => {
            if (ref === "me") return userId;
            const needle = ref.trim().toLowerCase();
            const person =
              people!.find((p) => p.id === ref) ??
              people!.find((p) => p.email.toLowerCase() === needle) ??
              people!.find((p) => p.name.toLowerCase() === needle);
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
      out.push({ type: "webhook", url: url.toString() });
    } else throw invalid('Each action is "set_properties", "notify" or "webhook"');
  }
  return out;
}

function checkName(name: unknown) {
  const text = typeof name === "string" ? name.trim() : "";
  if (!text) throw invalid("An automation needs a name");
  return text.slice(0, MAX_AUTOMATION_NAME);
}

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
  const trigger = await checkTrigger(userId, databaseId, props, input.trigger);
  const actions = await checkActions(userId, databaseId, database.workspaceId, props, input.actions);
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
      secretSalt: newSecretSalt(),
      runAs: userId,
      createdBy: userId,
    })
    .returning();
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
  const trigger = patch.trigger !== undefined ? await checkTrigger(userId, current.databaseId, props, patch.trigger) : current.trigger;
  const actions =
    patch.actions !== undefined
      ? await checkActions(userId, current.databaseId, current.workspaceId, props, patch.actions)
      : current.actions;
  const enabled = patch.enabled ?? current.enabled;
  const [updated] = await db
    .update(databaseAutomation)
    .set({ name, trigger, actions, enabled, runAs: userId })
    .where(eq(databaseAutomation.id, automationId))
    .returning();
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
  await manageable(userId, automationId);
  const [updated] = await db
    .update(databaseAutomation)
    .set({ secretSalt: newSecretSalt() })
    .where(eq(databaseAutomation.id, automationId))
    .returning();
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
      runAs: a.runAs ? { id: a.runAs, name: names.find((n) => n.id === a.runAs)?.name ?? "" } : null,
      /** Only automations with a webhook have one to show. */
      secret: a.actions.some((x) => x.type === "webhook") ? webhookSecret(a.secretSalt) : null,
      lastRun: last ? { status: last.status as AutomationRunStatus, at: last.createdAt.toISOString() } : null,
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
    event: webhookEvent(r.created),
    status: r.status,
    steps: r.steps,
    createdAt: r.createdAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
  }));
}

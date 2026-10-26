"use server";

import { getTranslations } from "next-intl/server";
import type { ActionResult } from "@/app/actions/databases";
import { avatarSrc } from "@/lib/avatar";
import { isDatabaseErrorCode, PropertyValueError } from "@/lib/properties";
import { AccessError, getMembership } from "@/server/access";
import { listAgents } from "@/server/agents/manage";
import {
  createAutomation,
  deleteAutomation,
  discardAutomationDraft,
  listAutomationRuns,
  listAutomations,
  previewDatePassed,
  previewThreshold,
  publishAutomation,
  rotateAutomationHook,
  rotateAutomationSecret,
  testAutomation,
  testAutomationWebhooks,
  updateAutomation,
  type AutomationInput,
  type SaveOptions,
  type TestRunInput,
} from "@/server/automations/manage";
import { createSlackAutomation, slackSetup, type SlackQuickInput } from "@/server/automations/slack-setup";
import { requireDatabase } from "@/server/databases";
import { requireUserId } from "@/server/session";
import { listMembers } from "@/server/workspaces";

// Database automations (see server/automations/manage.ts): full access to the database only.
// Properties and people are sent by id.

/** Translates a domain error for the UI, as the database actions do. */
async function errorMessage(error: Error): Promise<string> {
  const t = await getTranslations();
  const { code, params } = error as { code?: unknown; params?: Record<string, string> };
  if (isDatabaseErrorCode(code)) return t(`database.errors.${code}`, params ?? {});
  if (error instanceof AccessError) return t("database.errors.accessDenied");
  return t("common.genericError");
}

// Domain errors become translated messages; driver/query errors are logged and hidden.
async function run<T>(fn: (userId: string) => Promise<T>): Promise<ActionResult<T>> {
  const userId = await requireUserId();
  try {
    return { ok: true, data: await fn(userId) };
  } catch (error) {
    if (
      error instanceof PropertyValueError ||
      error instanceof AccessError ||
      (error instanceof Error && error.constructor === Error)
    ) {
      return { ok: false, error: await errorMessage(error) };
    }
    console.error("[automation action]", error);
    const t = await getTranslations("common");
    return { ok: false, error: t("genericError") };
  }
}

/**
 * The database's automations, with the workspace's people a notification can go to and the
 * agents shared with the viewer (and whether they own the workspace, or can edit an agent, to make
 * an action that runs one).
 */
export async function listAutomationsAction(databaseId: string) {
  return run(async (userId) => {
    const database = await requireDatabase(userId, databaseId, "full");
    // Guests can't list the workspace's people: the dialog falls back to the database's.
    const noneForGuests = (error: unknown) => {
      if (error instanceof AccessError) return [];
      throw error;
    };
    const [automations, members, agents, membership] = await Promise.all([
      listAutomations(userId, databaseId),
      listMembers(userId, database.workspaceId).catch(noneForGuests),
      listAgents(userId, database.workspaceId).catch(noneForGuests),
      getMembership(userId, database.workspaceId),
    ]);
    return {
      automations,
      members: members.map((m) => ({ id: m.userId, name: m.name, email: m.email, image: avatarSrc(m.image) })),
      // Those who can edit an agent give it tasks too (agents/sharing.ts), not just owners.
      agents: agents.map((a) => ({ id: a.id, name: a.name, icon: a.icon, description: a.description, enabled: a.enabled, canRun: a.access !== "interact" })),
      isOwner: membership?.role === "owner",
    };
  });
}

/** What the quick setup of Slack notifications shows: the properties to watch and the automations that send to Slack. */
export async function slackSetupAction(databaseId: string) {
  return run((userId) => slackSetup(userId, String(databaseId)));
}

/** Makes a "Send to Slack" automation from the quick setup. */
export async function createSlackAutomationAction(databaseId: string, input: SlackQuickInput) {
  return run((userId) =>
    createSlackAutomation(userId, String(databaseId), {
      name: String(input?.name ?? ""),
      url: String(input?.url ?? ""),
      message: String(input?.message ?? ""),
      when: String(input?.when ?? ""),
      to: typeof input?.to === "string" || typeof input?.to === "boolean" ? input.to : null,
      timeZone: typeof input?.timeZone === "string" ? input.timeZone : undefined,
    }),
  );
}

/** Creates an automation, published at once or (`publish: false`) as a draft that doesn't run yet. */
export async function createAutomationAction(databaseId: string, input: AutomationInput, options: SaveOptions = {}) {
  return run((userId) => createAutomation(userId, databaseId, input, options));
}

/**
 * Changes an automation; `{ enabled }` alone turns it on or off. A new trigger or steps are kept
 * as a draft with `publish: false`, else published.
 */
export async function updateAutomationAction(automationId: string, patch: Partial<AutomationInput>, options: SaveOptions = {}) {
  return run((userId) => updateAutomation(userId, automationId, patch, options));
}

/** Makes the automation's draft its next version. */
export async function publishAutomationAction(automationId: string) {
  return run((userId) => publishAutomation(userId, automationId));
}

export async function discardAutomationDraftAction(automationId: string) {
  return run((userId) => discardAutomationDraft(userId, automationId));
}

/** Runs the draft (or the published steps) once, with real effects, marked as a test. */
export async function testAutomationAction(automationId: string, input: TestRunInput) {
  return run((userId) => testAutomation(userId, automationId, input));
}

/** A new address for an incoming webhook trigger. */
export async function rotateAutomationHookAction(automationId: string) {
  return run((userId) => rotateAutomationHook(userId, automationId));
}

export async function deleteAutomationAction(automationId: string) {
  return run((userId) => deleteAutomation(userId, automationId));
}

export async function rotateAutomationSecretAction(automationId: string) {
  return run((userId) => rotateAutomationSecret(userId, automationId));
}

export async function testAutomationWebhooksAction(automationId: string) {
  return run((userId) => testAutomationWebhooks(userId, automationId));
}

export async function listAutomationRunsAction(automationId: string, limit = 20) {
  return run((userId) => listAutomationRuns(userId, automationId, limit));
}

/** How many rows a "date passed" trigger being edited would run for at the next check, days in `timeZone`. */
export async function previewDatePassedAction(databaseId: string, trigger: AutomationInput["trigger"], automationId: string | null, timeZone: string) {
  return run((userId) => previewDatePassed(userId, databaseId, trigger, automationId, timeZone));
}

/** A threshold trigger's value now, as typed (null when its view or property is gone). */
export async function previewThresholdAction(databaseId: string, trigger: AutomationInput["trigger"], timeZone: string) {
  return run((userId) => previewThreshold(userId, databaseId, trigger, timeZone));
}

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
  listAutomationRuns,
  listAutomations,
  rotateAutomationSecret,
  testAutomationWebhooks,
  updateAutomation,
  type AutomationInput,
} from "@/server/automations/manage";
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
 * agents an action can run (and whether the viewer owns the workspace, to make one).
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
      agents: agents.map((a) => ({ id: a.id, name: a.name, icon: a.icon, description: a.description, enabled: a.enabled })),
      isOwner: membership?.role === "owner",
    };
  });
}

export async function createAutomationAction(databaseId: string, input: AutomationInput) {
  return run((userId) => createAutomation(userId, databaseId, input));
}

/** Changes an automation; `{ enabled }` alone turns it on or off. */
export async function updateAutomationAction(automationId: string, patch: Partial<AutomationInput>) {
  return run((userId) => updateAutomation(userId, automationId, patch));
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

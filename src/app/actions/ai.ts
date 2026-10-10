"use server";

import { getTranslations } from "next-intl/server";
import type { AiAutofillConfig } from "@/lib/ai";
import { isDatabaseErrorCode, PropertyValueError } from "@/lib/properties";
import { AccessError } from "@/server/access";
import { isAiError } from "@/server/ai";
import { deleteConversations, getConversation, listConversations } from "@/server/ai-chat";
import { decideChange, type ChatDecision } from "@/server/ai-chat-approvals";
import { AutofillError, requestAutofill, setAutofill } from "@/server/ai-properties";
import { snapshotBeforeAiEdit } from "@/server/ai-writing";
import * as databases from "@/server/databases";
import { requireUserId } from "@/server/session";

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string; code?: string };

/** AI and autofill errors as translated messages (the code rides along for the UI to react to). */
async function run<T>(fn: (userId: string) => Promise<T>): Promise<ActionResult<T>> {
  const userId = await requireUserId();
  try {
    return { ok: true, data: await fn(userId) };
  } catch (error) {
    const t = await getTranslations();
    if (isAiError(error)) {
      const seconds = error.retryAfterMs ? Math.ceil(error.retryAfterMs / 1000) : 0;
      return { ok: false, error: t(`ai.errors.${error.code}`, { seconds }), code: error.code };
    }
    if (error instanceof AutofillError) {
      return { ok: false, error: t(`ai.autofill.errors.${error.code}`, error.params), code: error.code };
    }
    const { code, params } = error as { code?: unknown; params?: Record<string, string> };
    if ((error instanceof PropertyValueError || error instanceof Error) && isDatabaseErrorCode(code)) {
      return { ok: false, error: t(`database.errors.${code}`, params ?? {}) };
    }
    if (error instanceof AccessError) return { ok: false, error: t("database.errors.accessDenied") };
    console.error("[ai action]", error);
    return { ok: false, error: t("common.genericError") };
  }
}

/** Saves the page to its history right before the person applies an AI suggestion. */
export async function snapshotBeforeAiEditAction(pageId: string) {
  return run((userId) => snapshotBeforeAiEdit(userId, pageId));
}

/** Turns AI autofill on, changes it or (with null) turns it off for a text property. */
export async function setAutofillAction(propertyId: string, config: AiAutofillConfig | null) {
  return run((userId) => setAutofill(userId, propertyId, config));
}

/** Adds a text property that AI fills in, and fills it in for `rowIds` (the view's rows). */
export async function addAutofillPropertyAction(databaseId: string, name: string, config: AiAutofillConfig, rowIds: string[] = []) {
  return run(async (userId) => {
    const created = await databases.addProperty(userId, databaseId, { name, type: "text" });
    try {
      await setAutofill(userId, created.id, config);
    } catch (error) {
      // Settings that don't fit: leave no half-made property behind.
      await databases.discardProperty(userId, created.id).catch(() => {});
      throw error;
    }
    const queued = rowIds.length ? await requestAutofill(userId, created.id, rowIds.slice(0, 500)) : { queued: 0, skipped: 0 };
    return { id: created.id, ...queued };
  });
}

/** Works the AI values of these rows out again (a row's refresh, or "Update all rows" of a view). */
export async function refreshAutofillAction(propertyId: string, rowIds: string[]) {
  return run((userId) => requestAutofill(userId, propertyId, Array.isArray(rowIds) ? rowIds.map(String) : []));
}

/** The person's AI chat conversations in a workspace, newest first. */
export async function listConversationsAction(workspaceId: string) {
  return run((userId) => listConversations(userId, String(workspaceId)));
}

/** One of the person's conversations, its sources as they may see them now. */
export async function getConversationAction(workspaceId: string, conversationId: string) {
  return run((userId) => getConversation(userId, String(workspaceId), String(conversationId)));
}

/** Deletes one of the person's conversations, or all of them in the workspace. */
export async function deleteConversationAction(workspaceId: string, conversationId: string | "all") {
  return run((userId) => deleteConversations(userId, String(workspaceId), conversationId === "all" ? "all" : [String(conversationId)]));
}

/**
 * The person's decision on a change the AI chat asked about (its `approval` event): false when it
 * no longer waits (stopped, timed out or decided) or isn't theirs.
 */
export async function decideChangeAction(approvalId: string, decision: ChatDecision) {
  return run(async (userId) => {
    if (decision !== "approve" && decision !== "always" && decision !== "decline") return false;
    return decideChange(userId, String(approvalId), decision);
  });
}

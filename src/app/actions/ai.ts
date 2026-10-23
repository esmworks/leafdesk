"use server";

import { getTranslations } from "next-intl/server";
import type { AiAutofillConfig } from "@/lib/ai";
import { MAX_CONVERSATIONS, MAX_MEMORIES, MAX_MEMORY_CHARS } from "@/lib/ai-chat";
import { isDatabaseErrorCode, PropertyValueError } from "@/lib/properties";
import { AccessError } from "@/server/access";
import { isAiError } from "@/server/ai";
import { deleteConversations, getConversation, listConversations } from "@/server/ai-chat";
import { addMemory, deleteMemories, listMemories, MemoryError, memoryUse, setMemoryUse, updateMemory } from "@/server/ai-memory";
import { decideChange, type ChatDecision } from "@/server/ai-chat-approvals";
import { AutofillError, requestAutofill, setAutofill } from "@/server/ai-properties";
import { snapshotBeforeAiEdit } from "@/server/ai-writing";
import * as databases from "@/server/databases";
import { requireUserId } from "@/server/session";
import {
  getVoiceNoteInstructions,
  saveVoiceNote,
  setVoiceNoteInstructions,
  snapshotBeforeVoiceNote,
  voiceNoteDatabases,
  voiceNoteLimits,
} from "@/server/voice-notes";

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
    if (error instanceof MemoryError) {
      return { ok: false, error: t(`ai.memory.errors.${error.code}`, { max: error.code === "full" ? MAX_MEMORIES : MAX_MEMORY_CHARS }), code: error.code };
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

/**
 * Deletes some of the person's conversations (one id, or the ids picked in the list), or all of them
 * in the workspace. Ids of conversations that aren't theirs are left alone.
 */
export async function deleteConversationAction(workspaceId: string, conversationId: string | string[] | "all") {
  // No list shows more than MAX_CONVERSATIONS.
  const ids = Array.isArray(conversationId) ? [...new Set(conversationId.map(String))].slice(0, MAX_CONVERSATIONS) : [String(conversationId)];
  return run((userId) => deleteConversations(userId, String(workspaceId), conversationId === "all" ? "all" : ids));
}

/** What the AI chat remembers about the person in a workspace, oldest first. */
export async function listMemoriesAction(workspaceId: string) {
  return run((userId) => listMemories(userId, String(workspaceId)));
}

/** Whether the person has the AI chat's memory on in a workspace (their own switch). */
export async function memoryUseAction(workspaceId: string) {
  return run((userId) => memoryUse(userId, String(workspaceId)));
}

/** Turns the AI chat's memory on or off for the person in a workspace; their notes stay. */
export async function setMemoryUseAction(workspaceId: string, on: boolean) {
  return run((userId) => setMemoryUse(userId, String(workspaceId), on === true));
}

/** Adds a note to the person's memory in a workspace. */
export async function addMemoryAction(workspaceId: string, text: string) {
  return run((userId) => addMemory(userId, String(workspaceId), String(text)));
}

/** Changes one of the person's notes. */
export async function updateMemoryAction(workspaceId: string, memoryId: string, text: string) {
  return run((userId) => updateMemory(userId, String(workspaceId), String(memoryId), String(text)));
}

/** Deletes one of the person's notes, or all of them in the workspace. */
export async function deleteMemoryAction(workspaceId: string, memoryId: string | "all") {
  return run((userId) => deleteMemories(userId, String(workspaceId), memoryId === "all" ? "all" : [String(memoryId)]));
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

/** Saves the page to its history right before a voice note is put in at the cursor. */
export async function snapshotBeforeVoiceNoteAction(pageId: string) {
  return run((userId) => snapshotBeforeVoiceNote(userId, String(pageId)));
}

/**
 * Where a quick note can go in a workspace: the databases the person may add it to as a row, and
 * whether voice notes work there (null limits when not).
 */
export async function quickNoteTargetsAction(workspaceId: string) {
  return run(async (userId) => {
    const [limits, databases] = await Promise.all([voiceNoteLimits(String(workspaceId)), voiceNoteDatabases(userId, String(workspaceId))]);
    return { limits, databases };
  });
}

/** A database's writing instructions for voice notes, to edit them (full access). */
export async function getVoiceNoteInstructionsAction(databaseId: string) {
  return run((userId) => getVoiceNoteInstructions(userId, String(databaseId)));
}

/** Sets a database's writing instructions for voice notes; empty removes them. Answers what was stored. */
export async function setVoiceNoteInstructionsAction(databaseId: string, instructions: string) {
  return run((userId) => setVoiceNoteInstructions(userId, String(databaseId), typeof instructions === "string" ? instructions : ""));
}

/** Most characters of a voice note's text saved here (the note and its transcript). */
const MAX_VOICE_NOTE_TEXT = 500_000;

/** Saves a voice note the person reviewed (see server/voice-notes): a private page, or a row of `databaseId`. */
export async function saveVoiceNoteAction(input: {
  workspaceId: string;
  databaseId?: string | null;
  title: string;
  markdown: string;
  transcript: string;
  properties?: Record<string, string | string[]>;
}) {
  return run(async (userId) => {
    const text = (value: unknown) => (typeof value === "string" ? value.slice(0, MAX_VOICE_NOTE_TEXT) : "");
    const properties: Record<string, string | string[]> = {};
    if (input.properties && typeof input.properties === "object") {
      for (const [id, value] of Object.entries(input.properties)) {
        if (typeof value === "string") properties[id] = value;
        else if (Array.isArray(value)) properties[id] = value.filter((v): v is string => typeof v === "string");
      }
    }
    const t = await getTranslations("page.voiceNote");
    return saveVoiceNote(userId, {
      workspaceId: String(input.workspaceId),
      databaseId: typeof input.databaseId === "string" && input.databaseId ? input.databaseId : null,
      title: text(input.title).slice(0, 2000),
      markdown: text(input.markdown),
      transcript: text(input.transcript),
      properties,
      transcriptLabel: t("transcriptToggle"),
    });
  });
}

"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import type { AiAutofillConfig } from "@/lib/ai";
import { isMemoryCategory, MAX_CONVERSATIONS, MAX_MEMORIES, MAX_MEMORY_CHARS, type MemoryCategory, type MemoryLayer, type MemoryView } from "@/lib/ai-chat";
import { isDatabaseErrorCode, PropertyValueError } from "@/lib/properties";
import { AccessError } from "@/server/access";
import { isAiError } from "@/server/ai";
import { decideParkedChange, deleteConversations, getConversation, listConversations, markConversationSeen, saveReportAsPage, undoChatNote } from "@/server/ai-chat";
import { accountNotes, deleteAccountNotes, writeAccountNote } from "@/server/account-memory";
import { addMemory, deleteMemories, listMemories, MemoryError, setMemoryUse, updateMemory } from "@/server/ai-memory";
import { deleteSavedPrompt, listSavedPrompts, renameSavedPrompt, savePrompt, SavedPromptError } from "@/server/ai-saved-prompts";
import { MAX_PROMPT_NAME, MAX_PROMPT_TEXT, MAX_SAVED_PROMPTS } from "@/lib/ai-saved-prompts";
import type { ChatDecision } from "@/server/ai-chat-approvals";
import { isRunId, stopRun } from "@/server/ai-chat-runs";
import { AutofillError, requestAutofill, setAutofill } from "@/server/ai-properties";
import { snapshotBeforeAiEdit } from "@/server/ai-writing";
import * as databases from "@/server/databases";
import { MAX_FORMULA_REQUEST, suggestFormula, type FormulaRequest } from "@/server/formula-ai";
import { requireUserId } from "@/server/session";
import { deleteSharedNotes, placeNotes, writeSharedNote } from "@/server/shared-memory";
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
    if (error instanceof SavedPromptError) {
      const max = error.code === "full" ? MAX_SAVED_PROMPTS : error.code === "nameTooLong" ? MAX_PROMPT_NAME : MAX_PROMPT_TEXT;
      return { ok: false, error: t(`ai.assistant.saved.errors.${error.code}`, { max }), code: error.code };
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

/** The person's saved prompts for the AI assistant in this workspace. */
export async function listSavedPromptsAction(workspaceId: string) {
  return run((userId) => listSavedPrompts(userId, String(workspaceId)));
}

/** Saves a prompt to reuse in the AI assistant. */
export async function savePromptAction(workspaceId: string, input: { name: string; prompt: string }) {
  return run((userId) => savePrompt(userId, String(workspaceId), { name: input?.name, prompt: input?.prompt }));
}

export async function renameSavedPromptAction(id: string, name: string) {
  return run((userId) => renameSavedPrompt(userId, String(id), { name }));
}

export async function deleteSavedPromptAction(id: string) {
  return run((userId) => deleteSavedPrompt(userId, String(id)));
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

/**
 * A formula for what the person describes, checked and with what it gives on the first rows; nothing
 * is saved (see server/formula-ai).
 */
export async function suggestFormulaAction(input: FormulaRequest) {
  return run((userId) => {
    const text = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : "");
    return suggestFormula(userId, {
      databaseId: text(input?.databaseId, 100),
      propertyId: typeof input?.propertyId === "string" ? input.propertyId.slice(0, 100) : null,
      name: text(input?.name, 200),
      description: text(input?.description, MAX_FORMULA_REQUEST),
      titleName: text(input?.titleName, 100),
    });
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

/** The person has one of their conversations in front of them: its answers are no longer new. */
export async function markConversationSeenAction(workspaceId: string, conversationId: string) {
  return run((userId) => markConversationSeen(userId, String(workspaceId), String(conversationId)));
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
/** Saves a research report of the person's conversation (its message at `index`) as a private page. */
export async function saveReportAsPageAction(workspaceId: string, conversationId: string, index: number) {
  return run(async (userId) => {
    if (typeof workspaceId !== "string" || typeof conversationId !== "string" || !Number.isInteger(index) || index < 0) throw new AccessError();
    const t = await getTranslations("ai.chat.research");
    const saved = await saveReportAsPage(userId, workspaceId, conversationId, index, { sources: t("sourcesHeading"), untitled: t("untitled") });
    revalidatePath(`/w/${workspaceId}`, "layout");
    return saved;
  });
}

/** Undo on a note an answer kept, changed or dropped: it goes back to what it was. */
export async function undoChatNoteAction(workspaceId: string, conversationId: string, memoryId: string) {
  return run((userId) => undoChatNote(userId, String(workspaceId), String(conversationId), String(memoryId)));
}

/** Turns the AI chat's memory on or off for the person in a workspace; their notes stay. */
export async function setMemoryUseAction(workspaceId: string, on: boolean) {
  return run((userId) => setMemoryUse(userId, String(workspaceId), on === true));
}

/** A change on the Memory page: a note to add, one changed (its text and what it is about), or some (or all) deleted. */
export type NoteChange = { add: string; category?: MemoryCategory } | { id: string; text: string; category?: MemoryCategory } | { delete: string };

/**
 * Changes the notes of one part of the AI's memory, as the Memory page shows it: the person's own
 * in the workspace, theirs everywhere (`account`), the workspace's or a teamspace's (who may change
 * those is checked in shared-memory.ts). Returns that part's notes as they are now.
 */
export async function changeNoteAction(workspaceId: string, layer: "person" | MemoryLayer, teamspaceId: string | null, change: NoteChange) {
  return run(async (userId): Promise<(MemoryView & { by?: string | null })[]> => {
    const ws = String(workspaceId);
    const c = (change ?? {}) as Record<string, unknown>;
    const add = typeof c.add === "string" ? c.add : null;
    const edit = typeof c.id === "string" && typeof c.text === "string" ? { id: c.id, text: c.text } : null;
    const gone = typeof c.delete === "string" ? (c.delete === "all" ? ("all" as const) : [c.delete]) : null;
    const category = isMemoryCategory(c.category) ? c.category : null;
    if (add === null && !edit && !gone) throw new AccessError();
    if (layer === "person") {
      if (add !== null) await addMemory(userId, ws, add, category);
      else if (edit) await updateMemory(userId, ws, edit.id, edit.text, category);
      else await deleteMemories(userId, ws, gone!);
      return listMemories(userId, ws);
    }
    if (layer === "account") {
      if (add !== null || edit) await writeAccountNote(userId, add ?? edit!.text, { replaces: edit?.id ?? null, category });
      else await deleteAccountNotes(userId, gone!);
      return accountNotes(userId);
    }
    if (layer !== "workspace" && layer !== "teamspace") throw new AccessError();
    const place = layer === "teamspace" ? String(teamspaceId) : null;
    if (add !== null || edit) await writeSharedNote(userId, ws, place, add ?? edit!.text, { replaces: edit?.id ?? null, category });
    else await deleteSharedNotes(userId, ws, place, gone!);
    return placeNotes(userId, ws, place);
  });
}

/**
 * The person's decision on a change the AI chat asked about (its `approval` event): false when it
 * no longer waits (stopped or decided) or isn't theirs.
 */
export async function decideChangeAction(approvalId: string, decision: ChatDecision) {
  return run(async (userId) => {
    if (decision !== "approve" && decision !== "always" && decision !== "decline") return false;
    // Waited on here, or (the server restarted since) parked for the worker to go on with.
    return decideParkedChange(userId, String(approvalId), decision);
  });
}

/**
 * Stops the person's AI chat answer (`runId`, the browser's id for it): what it wrote so far is
 * kept, marked as stopped. False when it was no longer on its way; one not started yet stops as it starts.
 */
export async function stopChatAction(runId: string) {
  return run(async (userId) => isRunId(runId) && stopRun(userId, runId));
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

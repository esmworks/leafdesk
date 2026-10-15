import * as z from "zod";
import { MAX_MEMORIES, MAX_MEMORY_CHARS, type MemoryView } from "@/lib/ai-chat";
import { MemoryError, memoryOff } from "@/server/ai-memory";
import { id } from "@/server/operations";
import { ToolInputError } from "./format";

/**
 * The user's own memory over MCP: the notes about them that the AI chat keeps in each workspace
 * (server/ai-memory.ts), read and kept by every app they connect, the same notes and limits. Only
 * while the memory is on for them there: either switch off, nothing is read or kept.
 */

const noteInput = z.string().min(1).max(MAX_MEMORY_CHARS);
const memoryIdInput = z.string().min(1).max(100).describe("The note's memory_id, from list_memory.");

export const memoryInputs = {
  list: z.object({
    workspace_id: id("workspace").optional().describe("Only this workspace's notes; the notes of every workspace of the user when omitted."),
  }),
  remember: z.object({
    workspace_id: id("workspace"),
    text: noteInput.describe(`The note: one fact about the user, in a sentence of at most ${MAX_MEMORY_CHARS} characters, in the user's language.`),
    replaces: memoryIdInput.optional().describe("The memory_id of an older note this one takes the place of (to correct or update it), if any."),
  }),
  update: z.object({
    workspace_id: id("workspace"),
    memory_id: memoryIdInput,
    text: noteInput.describe(`The note's new text (at most ${MAX_MEMORY_CHARS} characters).`),
  }),
  forget: z.object({
    workspace_id: id("workspace"),
    memory_ids: z.array(memoryIdInput).min(1).max(MAX_MEMORIES).optional().describe("The memory_ids of the notes to forget, from list_memory."),
    all: z.boolean().default(false).describe("Forget every note of the user in the workspace instead (confirm with the user first)."),
  }),
};

/** Why nothing is read or kept, by the switch that has the memory off. */
export const MEMORY_OFF = {
  workspace:
    "The workspace's owners turned the AI memory off (Settings → General → AI → AI memory), so no note about the user is read or kept there. Keep nothing; the notes come back if an owner turns it on again.",
  person:
    "The user turned their memory off in this workspace (the Use memory switch in the AI chat's Memory), so no note about them is read or kept there. Keep nothing; they can turn it back on there.",
} as const;

/** Refused unless the user's memory in the workspace is on (the owners' switch and their own). */
export async function requireMemoryOn(userId: string, workspaceId: string) {
  const off = await memoryOff(userId, workspaceId);
  if (off) throw new ToolInputError(MEMORY_OFF[off]);
}

/** MemoryError as errors with a next step. */
export async function withMemoryErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof MemoryError) {
      switch (error.code) {
        case "notFound":
          throw new ToolInputError("No note with this memory_id in the user's memory in this workspace. Call list_memory to see their notes.");
        case "full":
          throw new ToolInputError(
            `The user's memory in this workspace is full (${MAX_MEMORIES} notes). Forget a note that matters less with forget, or change one with update_memory (or remember with replaces); or tell the user it is full.`,
          );
        case "tooLong":
          throw new ToolInputError(`A note has at most ${MAX_MEMORY_CHARS} characters. Make it shorter.`);
        case "empty":
          throw new ToolInputError("A note needs text.");
        case "off":
          throw new ToolInputError(MEMORY_OFF.workspace);
      }
    }
    throw error;
  }
}

/** A note as list_memory shows it. */
export function describeNote(note: MemoryView) {
  return { memory_id: note.id, text: note.text, created_at: note.createdAt, updated_at: note.updatedAt };
}

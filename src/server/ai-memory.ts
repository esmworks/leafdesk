/**
 * The AI chat's memory: short notes about a person in a workspace (who they are, what they work on,
 * how they want answers) that go with each of their questions there, so later conversations needn't
 * be told again. The chat keeps and drops notes with its `remember` and `forget` tools when the
 * person tells it something about themselves or asks it to (each shows as a step of the answer),
 * and the person lists, writes, changes and deletes them in the chat's Memory view.
 *
 * Notes are the person's own, like their conversations: only they ever see them, other people's
 * questions never carry them, and they go with the person's account, when they leave the workspace
 * and with the workspace. They are notes for the model, sent as data: they never widen what the
 * chat may read or change.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { aiMemory, type ChatMemoryRecord } from "@/db/schema";
import { MAX_MEMORIES, MAX_MEMORY_CHARS, type MemoryView } from "@/lib/ai-chat";
import { requireMembership } from "@/server/access";
import type { AiTool } from "@/server/ai";
import type { ToolOutcome } from "@/server/ai-tools";

export type MemoryErrorCode = "empty" | "tooLong" | "full" | "notFound";

export class MemoryError extends Error {
  constructor(
    readonly code: MemoryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MemoryError";
  }
}

/** A note as kept: one line, trimmed. */
function cleanNote(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) throw new MemoryError("empty", "Write what to remember");
  if (flat.length > MAX_MEMORY_CHARS) throw new MemoryError("tooLong", `A note may have at most ${MAX_MEMORY_CHARS} characters`);
  return flat;
}

const sameNote = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;

/** The person's notes in a workspace, oldest first (no membership check: callers make it). */
async function notesOf(userId: string, workspaceId: string) {
  return db
    .select()
    .from(aiMemory)
    .where(and(eq(aiMemory.userId, userId), eq(aiMemory.workspaceId, workspaceId)))
    .orderBy(asc(aiMemory.createdAt), asc(aiMemory.id));
}

const view = (m: typeof aiMemory.$inferSelect): MemoryView => ({
  id: m.id,
  text: m.text,
  createdAt: m.createdAt.toISOString(),
  updatedAt: m.updatedAt.toISOString(),
});

/** The person's notes in a workspace, oldest first. */
export async function listMemories(userId: string, workspaceId: string): Promise<MemoryView[]> {
  await requireMembership(userId, workspaceId);
  return (await notesOf(userId, workspaceId)).map(view);
}

/**
 * Keeps a note. A note the person already has (same text, case aside) is kept once: that one is
 * returned. Refused with `full` at MAX_MEMORIES.
 */
export async function addMemory(userId: string, workspaceId: string, text: string, conversationId: string | null = null): Promise<MemoryView> {
  await requireMembership(userId, workspaceId);
  const note = cleanNote(text);
  return db.transaction(async (tx) => {
    // One person's notes are added one at a time, so two answers can't both take the last place.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`ai_memory:${userId}:${workspaceId}`}))`);
    const notes = await tx
      .select()
      .from(aiMemory)
      .where(and(eq(aiMemory.userId, userId), eq(aiMemory.workspaceId, workspaceId)));
    const known = notes.find((m) => sameNote(m.text, note));
    if (known) return view(known);
    if (notes.length >= MAX_MEMORIES) throw new MemoryError("full", `The memory holds at most ${MAX_MEMORIES} notes`);
    const [made] = await tx.insert(aiMemory).values({ userId, workspaceId, text: note, conversationId }).returning();
    return view(made);
  });
}

/** Changes the text of one of the person's notes. */
export async function updateMemory(userId: string, workspaceId: string, memoryId: string, text: string): Promise<MemoryView> {
  await requireMembership(userId, workspaceId);
  const note = cleanNote(text);
  const [changed] = await db
    .update(aiMemory)
    .set({ text: note, updatedAt: new Date() })
    .where(and(eq(aiMemory.id, memoryId), eq(aiMemory.userId, userId), eq(aiMemory.workspaceId, workspaceId)))
    .returning();
  if (!changed) throw new MemoryError("notFound", "Note not found");
  return view(changed);
}

/** Deletes notes of the person (only theirs): some, or all of them in the workspace. */
export async function deleteMemories(userId: string, workspaceId: string, memoryIds: string[] | "all") {
  await requireMembership(userId, workspaceId);
  await db
    .delete(aiMemory)
    .where(
      and(
        eq(aiMemory.userId, userId),
        eq(aiMemory.workspaceId, workspaceId),
        memoryIds === "all" ? undefined : inArray(aiMemory.id, memoryIds.length ? memoryIds : [""]),
      ),
    );
}

// --------------------------------------------------------------------------------- the chat

/**
 * The person's notes for a question (their membership was checked with it): newest first as far as
 * `maxChars` takes them, then shown oldest first, each with its id for `forget` and `replaces`.
 */
export async function memoryForPrompt(userId: string, workspaceId: string, maxChars: number): Promise<{ text: string; count: number }> {
  const notes = await notesOf(userId, workspaceId);
  const lines: string[] = [];
  let used = 0;
  for (const note of [...notes].reverse()) {
    const line = `- (memory_id ${note.id}) ${note.text}`;
    if (used + line.length + 1 > maxChars) break;
    used += line.length + 1;
    lines.unshift(line);
  }
  if (lines.length < notes.length) lines.unshift("(Older notes don't fit in this question.)");
  return { text: lines.join("\n"), count: notes.length };
}

export const MEMORY_TOOLS: AiTool[] = [
  {
    name: "remember",
    description:
      "Keeps a short note about the person for later conversations in this workspace: who they are, what they work on, how they want answers. With replaces, the note takes the place of an older one (to correct or update it).",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: `The note: one fact, in a sentence of at most ${MAX_MEMORY_CHARS} characters, in the person's language.` },
        replaces: { type: "string", description: "The memory_id of the note this one takes the place of, if any." },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "forget",
    description: "Drops a note from the memory, by its memory_id.",
    parameters: {
      type: "object",
      properties: { memory_id: { type: "string", description: "The memory_id of the note to drop." } },
      required: ["memory_id"],
      additionalProperties: false,
    },
  },
];
export const MEMORY_TOOL_NAMES = new Set(MEMORY_TOOLS.map((t) => t.name));

const step = (action: ChatMemoryRecord["action"], text: string): ChatMemoryRecord => ({ kind: "memory", action, text });

/** Runs `remember` or `forget` for the person asking, on their own notes in the workspace. */
export async function runMemoryTool(
  userId: string,
  workspaceId: string,
  conversationId: string,
  call: { name: string; arguments: Record<string, unknown> },
): Promise<ToolOutcome> {
  const arg = (name: string) => (typeof call.arguments[name] === "string" ? (call.arguments[name] as string).trim() : "");
  const notFound: ToolOutcome = { content: "There is no note with that memory_id.", isError: true };
  try {
    if (call.name === "forget") {
      const id = arg("memory_id");
      if (!id || id.length > 100) return notFound;
      const [gone] = await db
        .delete(aiMemory)
        .where(and(eq(aiMemory.id, id), eq(aiMemory.userId, userId), eq(aiMemory.workspaceId, workspaceId)))
        .returning();
      if (!gone) return notFound;
      return { content: "Forgotten.", step: step("forget", gone.text) };
    }
    const replaces = arg("replaces");
    if (replaces) {
      if (replaces.length > 100) return notFound;
      const changed = await updateMemory(userId, workspaceId, replaces, arg("text"));
      return { content: `Remembered (memory_id ${changed.id}).`, step: step("remember", changed.text) };
    }
    const made = await addMemory(userId, workspaceId, arg("text"), conversationId);
    return { content: `Remembered (memory_id ${made.id}).`, step: step("remember", made.text) };
  } catch (error) {
    if (!(error instanceof MemoryError)) throw error;
    if (error.code === "notFound") return notFound;
    if (error.code === "full") return { content: `The memory is full (${MAX_MEMORIES} notes): replace or forget a note that matters less, or tell the person it is full.`, isError: true };
    if (error.code === "tooLong") return { content: `Too long: a note may have at most ${MAX_MEMORY_CHARS} characters. Keep it shorter.`, isError: true };
    return { content: "remember needs the text of the note.", isError: true };
  }
}

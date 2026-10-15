/**
 * The AI chat's memory: short notes about a person in a workspace (who they are, what they work on,
 * how they want answers) that go with each of their questions there, so later conversations needn't
 * be told again. The chat keeps and drops notes with its `remember` and `forget` tools when the
 * person tells it something about themselves or asks it to (each shows as a step of the answer),
 * and the person lists, writes, changes and deletes them in the chat's Memory view. Apps the person
 * connected read and keep the same notes over MCP (mcp/memory.ts), while the memory is on. Agents keep
 * notes here too, under their own users, that their runs only propose (server/agents/memory.ts).
 *
 * A note goes with every later question, so text the model read on a page could otherwise pass
 * itself off as a lasting note: unless the chat's mode is `auto`, the person approves each note
 * the chat keeps or drops before it is (ai-chat.ts), as with changes to the workspace.
 *
 * Two switches turn it off without deleting a note: the person's own in the Memory view, for them
 * in the workspace (kept with their membership), and the owners' for the whole workspace (the
 * `aiMemory` workspace setting, which also hides the Memory view). Off, questions carry no notes
 * and the chat isn't offered `remember` or `forget`.
 *
 * Notes are the person's own, like their conversations: only they ever see them, other people's
 * questions never carry them, and they go with the person's account, when they leave the workspace
 * and with the workspace. They are notes for the model, sent as data: they never widen what the
 * chat may read or change.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { aiMemory, oauthClient, type ChatMemoryRecord, type MemoryStatus } from "@/db/schema";
import { MAX_MEMORIES, MAX_MEMORY_CHARS, type ChatActionView, type MemoryView } from "@/lib/ai-chat";
import { AccessError, requireMembership } from "@/server/access";
import type { AiTool } from "@/server/ai";
import type { ChatDecision } from "@/server/ai-chat-approvals";
import type { ToolOutcome } from "@/server/ai-tools";
import { getMemberAiMemory, setMemberAiMemory, workspaceSettings } from "@/server/workspaces";

export type MemoryErrorCode = "empty" | "tooLong" | "full" | "notFound" | "off";

export class MemoryError extends Error {
  constructor(
    readonly code: MemoryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MemoryError";
  }
}

// ------------------------------------------------------------------------------ the switches

/** Whether the workspace has the chat's memory on: owners turn it off for everyone. */
export async function memoryAvailable(workspaceId: string): Promise<boolean> {
  return (await workspaceSettings(workspaceId)).aiMemory !== false;
}

/** Whether the person has the memory on in the workspace (their own switch, on by default). */
export async function memoryUse(userId: string, workspaceId: string): Promise<boolean> {
  const use = await getMemberAiMemory(userId, workspaceId);
  if (use === null) throw new AccessError();
  return use;
}

/** Turns the memory on or off for the person in the workspace; their notes stay either way. */
export async function setMemoryUse(userId: string, workspaceId: string, on: boolean) {
  if (!(await setMemberAiMemory(userId, workspaceId, on))) throw new AccessError();
}

/** Which switch has the person's memory in the workspace off, the owners' first, or null when it is on. */
async function switchedOff(userId: string, workspaceId: string): Promise<"workspace" | "person" | null> {
  const [available, use] = await Promise.all([memoryAvailable(workspaceId), memoryUse(userId, workspaceId)]);
  return !available ? "workspace" : use ? null : "person";
}

/** Whether the person's questions in the workspace carry their notes and may keep new ones. */
export async function memoryOn(userId: string, workspaceId: string): Promise<boolean> {
  return (await switchedOff(userId, workspaceId)) === null;
}

/**
 * Which switch has the person's memory in the workspace off, or null when it is on (see
 * switchedOff), after checking they are in it: for apps the person connected (mcp/memory.ts),
 * which read and keep notes only while it is on.
 */
export async function memoryOff(userId: string, workspaceId: string): Promise<"workspace" | "person" | null> {
  await requireMembership(userId, workspaceId);
  return switchedOff(userId, workspaceId);
}

/**
 * The person's memory in a workspace with one membership check: which switch has it off, if one
 * does, and their notes (also while it is off: callers decide what to show).
 */
export async function memoryState(userId: string, workspaceId: string): Promise<{ off: "workspace" | "person" | null; notes: MemoryView[] }> {
  await requireMembership(userId, workspaceId);
  const [off, notes] = await Promise.all([switchedOff(userId, workspaceId), keptNotes(userId, workspaceId)]);
  return { off, notes };
}

/** A note as kept: one line, trimmed. */
export function cleanNote(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) throw new MemoryError("empty", "Write what to remember");
  if (flat.length > MAX_MEMORY_CHARS) throw new MemoryError("tooLong", `A note may have at most ${MAX_MEMORY_CHARS} characters`);
  return flat;
}

/**
 * Whether two notes say the same, case aside: in Turkish (İ/i, I/ı) or in any other language (I/i),
 * so neither casing keeps a note twice.
 */
export function sameNote(a: string, b: string): boolean {
  return a.toLocaleLowerCase("tr") === b.toLocaleLowerCase("tr") || a.toLowerCase() === b.toLowerCase();
}

type Note = typeof aiMemory.$inferSelect;

/**
 * A user's notes in a workspace, oldest first (no membership check: callers make it): the kept
 * ones, or with `status` null also those an agent's run proposed.
 */
async function notesOf(userId: string, workspaceId: string, reader: Pick<typeof db, "select"> = db, status: MemoryStatus | null = "kept"): Promise<Note[]> {
  return reader
    .select()
    .from(aiMemory)
    .where(and(eq(aiMemory.userId, userId), eq(aiMemory.workspaceId, workspaceId), status ? eq(aiMemory.status, status) : undefined))
    .orderBy(asc(aiMemory.createdAt), asc(aiMemory.id));
}

/** Holds a user's notes in a workspace until the transaction ends: they change one at a time. */
export const lockNotes = (tx: Pick<typeof db, "execute">, userId: string, workspaceId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`ai_memory:${userId}:${workspaceId}`}))`);

const view = (m: Note, app: string | null = null): MemoryView => ({
  id: m.id,
  text: m.text,
  app,
  createdAt: m.createdAt.toISOString(),
  updatedAt: m.updatedAt.toISOString(),
});

/**
 * The person's kept notes in a workspace, oldest first, with the app that kept each, if one did
 * (no membership check: callers make it).
 */
export async function keptNotes(userId: string, workspaceId: string): Promise<MemoryView[]> {
  const rows = await db
    .select({ note: aiMemory, app: oauthClient.name })
    .from(aiMemory)
    .leftJoin(oauthClient, eq(oauthClient.clientId, aiMemory.oauthClientId))
    .where(and(eq(aiMemory.userId, userId), eq(aiMemory.workspaceId, workspaceId), eq(aiMemory.status, "kept")))
    .orderBy(asc(aiMemory.createdAt), asc(aiMemory.id));
  return rows.map((r) => view(r.note, r.app ?? null));
}

/**
 * Keeps a note, or with `replaces` changes that note to it (no membership check: callers make it).
 * A note the person already has (same text, case aside, also one an agent's run proposed) is kept
 * once: that one is returned, marked `known`, and the replaced note, if any, goes. Refused with
 * `full` at MAX_MEMORIES (for an agent's proposal, `status` proposed: at `maxProposed` proposals)
 * and `notFound` when the replaced note isn't the person's. `app`: the connected app writing it,
 * recorded on the note it keeps or changes (none: written in Leafdesk).
 */
export async function writeNote(
  userId: string,
  workspaceId: string,
  text: string,
  {
    replaces = null,
    conversationId = null,
    status = "kept",
    agentRunId = null,
    maxProposed = MAX_MEMORIES,
    app = null,
  }: {
    replaces?: string | null;
    conversationId?: string | null;
    status?: MemoryStatus;
    agentRunId?: string | null;
    maxProposed?: number;
    app?: string | null;
  } = {},
): Promise<Note & { known?: true }> {
  // Written only while the workspace has the memory on (the person's own switch aside).
  if (!(await memoryAvailable(workspaceId))) throw new MemoryError("off", "The AI memory is turned off in this workspace");
  const note = cleanNote(text);
  return db.transaction(async (tx) => {
    // One person's notes change one at a time, so two answers can't both take the last place or
    // write the same note.
    await lockNotes(tx, userId, workspaceId);
    const notes = await notesOf(userId, workspaceId, tx, null);
    const target = replaces ? notes.find((m) => m.id === replaces) : undefined;
    if (replaces && !target) throw new MemoryError("notFound", "Note not found");
    const known = notes.find((m) => m.id !== target?.id && sameNote(m.text, note));
    if (known) {
      if (target) await tx.delete(aiMemory).where(eq(aiMemory.id, target.id));
      return { ...known, known: true as const };
    }
    if (target) {
      const [changed] = await tx.update(aiMemory).set({ text: note, oauthClientId: app, updatedAt: new Date() }).where(eq(aiMemory.id, target.id)).returning();
      return changed;
    }
    const max = status === "kept" ? MAX_MEMORIES : maxProposed;
    if (notes.filter((m) => m.status === status).length >= max) throw new MemoryError("full", `The memory holds at most ${max} notes`);
    const [made] = await tx.insert(aiMemory).values({ userId, workspaceId, text: note, conversationId, status, agentRunId, oauthClientId: app }).returning();
    return made;
  });
}

/** The person's notes in a workspace, oldest first. */
export async function listMemories(userId: string, workspaceId: string): Promise<MemoryView[]> {
  await requireMembership(userId, workspaceId);
  return keptNotes(userId, workspaceId);
}

/** Keeps a note the person wrote (see writeNote). */
export async function addMemory(userId: string, workspaceId: string, text: string): Promise<MemoryView> {
  await requireMembership(userId, workspaceId);
  return view(await writeNote(userId, workspaceId, text));
}

/** Changes the text of one of the person's notes (see writeNote: the same as another merges them). */
export async function updateMemory(userId: string, workspaceId: string, memoryId: string, text: string): Promise<MemoryView> {
  await requireMembership(userId, workspaceId);
  return view(await writeNote(userId, workspaceId, text, { replaces: memoryId }));
}

/** Deletes notes of the person (only theirs): some, or all of them in the workspace. Returns the ids of those that went. */
export async function deleteMemories(userId: string, workspaceId: string, memoryIds: string[] | "all"): Promise<string[]> {
  await requireMembership(userId, workspaceId);
  const gone = await db
    .delete(aiMemory)
    .where(
      and(
        eq(aiMemory.userId, userId),
        eq(aiMemory.workspaceId, workspaceId),
        memoryIds === "all" ? undefined : inArray(aiMemory.id, memoryIds.length ? memoryIds : [""]),
      ),
    )
    .returning({ id: aiMemory.id });
  return gone.map((m) => m.id);
}

// --------------------------------------------------------------------------------- the chat
// The chat checked the person's membership with the question: its tools don't again.

/**
 * The kept notes for a question, or for an agent's run (agents/memory.ts): newest first as far as
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

/** A note the chat is about to keep or drop, checked, for the person to approve (see applyMemory). */
export type PreparedMemory = {
  action: ChatActionView;
  change: { kind: "remember"; text: string; replaces: string | null } | { kind: "forget"; id: string; text: string };
};

const NOT_FOUND: ToolOutcome = { content: "There is no note with that memory_id.", isError: true };

function refused(error: unknown): ToolOutcome {
  if (!(error instanceof MemoryError)) throw error;
  if (error.code === "notFound") return NOT_FOUND;
  if (error.code === "full") return { content: `The memory is full (${MAX_MEMORIES} notes): replace or forget a note that matters less, or tell the person it is full.`, isError: true };
  if (error.code === "off") return { content: "The memory is turned off: keep nothing.", isError: true };
  if (error.code === "tooLong") return { content: `Too long: a note may have at most ${MAX_MEMORY_CHARS} characters. Keep it shorter.`, isError: true };
  return { content: "remember needs the text of the note.", isError: true };
}

const memoryAction = (action: "remember" | "forget", text: string): ChatActionView => ({ action, target: null, title: text, changes: [], content: null });

/**
 * Checks a `remember` or `forget` call on the person's own notes before anything is asked or
 * written: the note it drops or replaces is theirs, the text fits, there is room. A note they
 * already have is answered as such, with nothing to approve.
 */
export async function prepareMemory(
  userId: string,
  workspaceId: string,
  call: { name: string; arguments: Record<string, unknown> },
): Promise<PreparedMemory | ToolOutcome> {
  const arg = (name: string) => (typeof call.arguments[name] === "string" ? (call.arguments[name] as string).trim() : "");
  const notes = await notesOf(userId, workspaceId);
  if (call.name === "forget") {
    const gone = notes.find((m) => m.id === arg("memory_id"));
    if (!gone) return NOT_FOUND;
    return { action: memoryAction("forget", gone.text), change: { kind: "forget", id: gone.id, text: gone.text } };
  }
  let text: string;
  try {
    text = cleanNote(arg("text"));
  } catch (error) {
    return refused(error);
  }
  const replaces = arg("replaces") || null;
  if (replaces && !notes.some((m) => m.id === replaces)) return NOT_FOUND;
  const known = notes.find((m) => m.id !== replaces && sameNote(m.text, text));
  if (known && !replaces) return { content: `Already remembered (memory_id ${known.id}).` };
  if (!replaces && notes.length >= MAX_MEMORIES) return refused(new MemoryError("full", ""));
  return { action: memoryAction("remember", text), change: { kind: "remember", text, replaces } };
}

/** Keeps or drops the note once approved (or without asking, in mode `auto`). */
export async function applyMemory(
  userId: string,
  workspaceId: string,
  conversationId: string,
  prepared: PreparedMemory,
  decision: ChatDecision | "timeout",
): Promise<ToolOutcome> {
  const { change } = prepared;
  const step = (outcome: ChatMemoryRecord["outcome"], text: string): ChatMemoryRecord => ({ kind: "memory", action: change.kind, text, outcome });
  if (decision === "decline" || decision === "timeout") {
    return { content: "The person declined: don't keep or drop this note, and don't ask again.", step: step("declined", change.text) };
  }
  if (change.kind === "forget") {
    const [gone] = await db
      .delete(aiMemory)
      .where(and(eq(aiMemory.id, change.id), eq(aiMemory.userId, userId), eq(aiMemory.workspaceId, workspaceId)))
      .returning();
    if (!gone) return NOT_FOUND;
    return { content: "Forgotten.", step: step("done", gone.text) };
  }
  try {
    const kept = await writeNote(userId, workspaceId, change.text, { replaces: change.replaces, conversationId });
    return { content: `Remembered (memory_id ${kept.id}).`, step: step("done", kept.text) };
  } catch (error) {
    return refused(error);
  }
}

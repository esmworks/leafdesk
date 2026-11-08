/**
 * The AI chat's memory: short notes about a person in a workspace (who they are, what they work on,
 * how they want answers) that go with each of their questions there, so later conversations needn't
 * be told again. The chat keeps and drops notes with its `remember` and `forget` tools when the
 * person tells it something about themselves or asks it to (each shows as a step of the answer),
 * and the person lists, writes, changes and deletes them in the chat's Memory view. Apps the person
 * connected read and keep the same notes over MCP (mcp/memory.ts), while the memory is on. Agents keep
 * notes here too, under their own users, that their runs only propose (server/agents/memory.ts).
 *
 * A note goes with every later question, so text from outside could otherwise pass itself off as
 * a lasting note: the chat keeps or drops a note at once only in a turn that read nothing from
 * outside (lib/memory-rule.ts), with Undo on its step (undoNote), and asks the person otherwise.
 * Notes too many for a question's room are read with `read_memory`, offered only then.
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
import { aiMemory, memorySummary, oauthClient, type ChatMemoryRecord, type MemoryStatus } from "@/db/schema";
import type { MemoryKind } from "@/db/schema/ai";
import { isMemoryCategory, MAX_MEMORIES, MAX_MEMORY_CHARS, MAX_MEMORY_DETAILS_CHARS, MEMORY_CATEGORIES, type ChatActionView, type MemoryCategory, type MemoryLayer, type MemoryView } from "@/lib/ai-chat";
import { accountNotesOf, deleteAccountNotes, writeAccountNote } from "@/server/account-memory";
import { AccessError, requireMembership } from "@/server/access";
import type { AiTool } from "@/server/ai";
import type { ChatDecision } from "@/server/ai-chat-approvals";
import type { ToolOutcome } from "@/server/ai-tools";
import { deleteSharedNotes, mayWriteNotes, notePlace, notesAt, sharedMemoryFor, teamspaceNotesFor, writeSharedNote } from "@/server/shared-memory";
import { teamspaceStanding } from "@/server/teamspaces";
import { getMemberAiMemory, setMemberAiMemory, workspaceSettings } from "@/server/workspaces";
import { matchNotes, MEMORY_SEARCH_LIMIT, queryWords } from "@/lib/memory-search";

export { MEMORY_SEARCH_LIMIT };

export type MemoryErrorCode = "empty" | "tooLong" | "detailsTooLong" | "full" | "notFound" | "off" | "personOff" | "changed" | "busy" | "held" | "noNotes" | "summaryTooLong";

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

/** Text of several lines as the memory keeps it (details, a summary): one kind of line break, no spaces ending a line, at most one empty line in a row, trimmed. */
export function tidyText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * A note's details as kept (tidyText); null when there are none. `undefined` stays undefined (a
 * change that leaves them as they were).
 */
export function cleanDetails(details: string | null | undefined): string | null | undefined {
  if (details === undefined) return undefined;
  const clean = tidyText(details ?? "");
  if (!clean) return null;
  if (clean.length > MAX_MEMORY_DETAILS_CHARS) throw new MemoryError("detailsTooLong", `A note's details may have at most ${MAX_MEMORY_DETAILS_CHARS} characters`);
  return clean;
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
  details: m.details,
  category: m.category,
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
 * recorded on the note it keeps or changes (none: written in Leafdesk). `category`: what the note
 * is about; a changed note keeps its own unless one is given, a new one is `other` without.
 * `details`: what it says in full (cleanDetails); left out, a changed note keeps its own.
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
    category = null,
    details,
  }: {
    replaces?: string | null;
    conversationId?: string | null;
    status?: MemoryStatus;
    agentRunId?: string | null;
    maxProposed?: number;
    app?: string | null;
    category?: MemoryCategory | null;
    details?: string | null;
  } = {},
): Promise<Note & { known?: true }> {
  // Written only while the workspace has the memory on (the person's own switch aside).
  if (!(await memoryAvailable(workspaceId))) throw new MemoryError("off", "The AI memory is turned off in this workspace");
  const note = cleanNote(text);
  const more = cleanDetails(details);
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
      const [changed] = await tx
        .update(aiMemory)
        .set({ text: note, ...(category ? { category } : {}), ...(more !== undefined ? { details: more } : {}), oauthClientId: app, updatedAt: new Date() })
        .where(eq(aiMemory.id, target.id))
        .returning();
      return changed;
    }
    const max = status === "kept" ? MAX_MEMORIES : maxProposed;
    if (notes.filter((m) => m.status === status).length >= max) throw new MemoryError("full", `The memory holds at most ${max} notes`);
    const [made] = await tx.insert(aiMemory).values({ userId, workspaceId, text: note, category: category ?? "other", details: more ?? null, conversationId, status, agentRunId, oauthClientId: app }).returning();
    return made;
  });
}

/** The person's notes in a workspace, oldest first. */
export async function listMemories(userId: string, workspaceId: string): Promise<MemoryView[]> {
  await requireMembership(userId, workspaceId);
  return keptNotes(userId, workspaceId);
}

/** What a note the person writes or changes says beside its line: what it is about and its details (see writeNote). */
type NoteMore = { category?: MemoryCategory | null; details?: string | null };

/** Keeps a note the person wrote (see writeNote). */
export async function addMemory(userId: string, workspaceId: string, text: string, more: NoteMore = {}): Promise<MemoryView> {
  await requireMembership(userId, workspaceId);
  return view(await writeNote(userId, workspaceId, text, more));
}

/** Changes one of the person's notes: its text, and what it is about and its details when given (see writeNote: the same as another merges them). */
export async function updateMemory(userId: string, workspaceId: string, memoryId: string, text: string, more: NoteMore = {}): Promise<MemoryView> {
  await requireMembership(userId, workspaceId);
  return view(await writeNote(userId, workspaceId, text, { replaces: memoryId, ...more }));
}

/**
 * Deletes notes of the person (only theirs): some, or all of them in the workspace, with the summary
 * of them (memory-summary.ts) then too. Returns the ids of the notes that went.
 */
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
  // Forgetting everything here forgets what was summed up from it too.
  if (memoryIds === "all") await db.delete(memorySummary).where(and(eq(memorySummary.userId, userId), eq(memorySummary.workspaceId, workspaceId)));
  return gone.map((m) => m.id);
}

// --------------------------------------------------------------------------------- the chat
// The chat checked the person's membership with the question: its tools don't again.

/** A note as the prompt and read_memory carry it; `layer`, whose it is, in a search of several. */
type PromptNote = { id: string; text: string; kind?: MemoryKind; category?: MemoryCategory; details?: string | null; layer?: string };

/**
 * A note as the model reads it, with its id for `forget` and `replaces`, whose it is in a search of
 * several, what it is about unless `other`, an agent's corrections marked, and whether it has details
 * (read_memory reads them).
 */
const promptLine = (note: PromptNote) =>
  `- (memory_id ${note.id}) ${note.layer ? `(${note.layer}) ` : ""}${note.kind === "correction" ? "(correction) " : ""}${note.category && note.category !== "other" ? `[${note.category}] ` : ""}${note.text}${note.details ? " (has details)" : ""}`;


/**
 * Notes (oldest first) for a prompt: newest first as far as `maxChars` takes them, an agent's
 * corrections before its other notes, then shown oldest first. When some don't fit, `overflow` comes
 * first, saying how to read them. `shown`: how many notes went in; `details`: whether a note shown
 * has details, which read_memory reads. `markDetails` false leaves the mark out, for a reader whose
 * read_memory can't reach these notes (an agent's run, with the workspace's notes).
 */
export function fitNotes(
  all: PromptNote[],
  maxChars: number,
  overflow: string,
  { markDetails = true }: { markDetails?: boolean } = {},
): { text: string; count: number; shown: number; details: boolean } {
  const notes = markDetails ? all : all.map((n) => ({ ...n, details: null }));
  const taken = new Set<string>();
  let used = 0;
  for (const note of [...notes.filter((n) => n.kind === "correction"), ...notes.filter((n) => n.kind !== "correction").reverse()]) {
    const length = promptLine(note).length + 1;
    if (used + length > maxChars) break;
    used += length;
    taken.add(note.id);
  }
  const lines = notes.filter((n) => taken.has(n.id)).map(promptLine);
  if (lines.length < notes.length) lines.unshift(overflow);
  return { text: lines.join("\n"), count: notes.length, shown: taken.size, details: notes.some((n) => taken.has(n.id) && !!n.details) };
}

/**
 * The kept notes for a question, or for an agent's run (agents/memory.ts), as far as `maxChars` takes
 * them (fitNotes); those that don't fit are read with read_memory.
 */
export async function memoryForPrompt(
  userId: string,
  workspaceId: string,
  maxChars: number,
  options: { markDetails?: boolean } = {},
): Promise<{ text: string; count: number; shown: number; details: boolean }> {
  return fitNotes(await notesOf(userId, workspaceId), maxChars, `(Older notes don't fit here: read them with ${READ_MEMORY_TOOL.name}.)`, options);
}

/** How much of each note's details a search of read_memory shows. */
const SEARCH_DETAILS_CHARS = 600;

const QUERY = { type: "string", description: "Words to search the notes and their details for; the notes with most of them come first." };
const MEMORY_ID = { type: "string", description: "One note's memory_id: reads it with all its details." };

/** Reads the notes that didn't fit in the prompt: offered only when some didn't (memoryForPrompt `shown` < `count`). */
export const READ_MEMORY_TOOL: AiTool = {
  name: "read_memory",
  description: `Searches the kept notes, each with its memory_id: with query, the ${MEMORY_SEARCH_LIMIT} that match best, with their details; with memory_id, that note in full; with neither, every note's line, oldest first.`,
  parameters: {
    type: "object",
    properties: { query: QUERY, memory_id: MEMORY_ID },
    additionalProperties: false,
  },
};

/**
 * The chat's read_memory: the person's notes here (as READ_MEMORY_TOOL), or those of another layer
 * that didn't fit in the question or of another teamspace they are in. Offered when one of those
 * has notes the question doesn't carry.
 */
export const CHAT_READ_MEMORY_TOOL: AiTool = {
  name: READ_MEMORY_TOOL.name,
  description: `Searches the memory, for notes the question doesn't carry and for notes' details (a note marked "has details"): with query, the ${MEMORY_SEARCH_LIMIT} notes that match best, with their details; with memory_id, one note in full; with neither, every note's line, oldest first. layer: the person's own here (person), theirs for every workspace (account), the workspace's (workspace), a teamspace's they are in (teamspace, with teamspace_id), or all of these but other teamspaces (all, the default).`,
  parameters: {
    type: "object",
    properties: {
      layer: { type: "string", enum: ["all", "person", "account", "workspace", "teamspace"], description: "Whose notes: all (default), person, account, workspace or teamspace." },
      teamspace_id: { type: "string", description: "teamspace: the teamspace's id, from the list of teamspaces with the question; with layer all, that teamspace's notes are searched too." },
      query: QUERY,
      memory_id: MEMORY_ID,
    },
    additionalProperties: false,
  },
};

/** A note with its details under it, as a search or a read of one note shows it; `max`: how much of the details. */
function withDetails(note: PromptNote, max = Infinity): string {
  const line = promptLine({ ...note, details: null });
  if (!note.details) return line;
  const details = note.details.length > max ? `${note.details.slice(0, max)}… (more: read_memory with this memory_id)` : note.details;
  return `${line}\n${details.replace(/^/gm, "    ")}`;
}

/**
 * read_memory over these notes (oldest first): with `memory_id`, that note in full; with `query`,
 * the notes that match best (words in a note's line count twice those in its details; newer notes
 * first on a tie), at most MEMORY_SEARCH_LIMIT, with their details; with neither, every note's line.
 */
export function searchNotes(notes: PromptNote[], args: Record<string, unknown>): ToolOutcome {
  if (typeof args.memory_id === "string" && args.memory_id.trim()) {
    const found = notes.find((n) => n.id === args.memory_id);
    return found ? { content: withDetails(found) } : { content: "No note you may read has that memory_id.", isError: true };
  }
  const query = typeof args.query === "string" ? args.query : "";
  if (!notes.length) return { content: "No notes are kept." };
  if (!queryWords(query).length) return { content: notes.map(promptLine).join("\n") };
  const found = matchNotes(notes, query);
  if (!found.length) return { content: "No kept note has those words." };
  return { content: found.map((note) => withDetails(note, SEARCH_DETAILS_CHARS)).join("\n") };
}

/** The kept notes for read_memory (the person's own, or an agent's under its user): searchNotes. */
export async function readMemory(userId: string, workspaceId: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  return searchNotes(await notesOf(userId, workspaceId), args);
}

/**
 * The chat's read_memory (CHAT_READ_MEMORY_TOOL): only what the person may read, by the rules of
 * each layer. `own`: the person's memory is on here, so their own notes (here and everywhere) are read.
 */
export async function readChatMemory(userId: string, workspaceId: string, args: Record<string, unknown>, own: boolean): Promise<ToolOutcome> {
  const layer = typeof args.layer === "string" ? args.layer : "all";
  if (!own && (layer === "person" || layer === "account")) return { content: "The person's memory is off: their notes aren't read.", isError: true };
  const teamspaceId = typeof args.teamspace_id === "string" ? args.teamspace_id : "";
  switch (layer) {
    case "account":
      return searchNotes(await accountNotesOf(userId), args);
    case "workspace":
      return searchNotes((await sharedMemoryFor(userId, workspaceId, null)).workspace, args);
    case "teamspace": {
      const found = teamspaceId ? await teamspaceNotesFor(userId, workspaceId, teamspaceId) : null;
      if (!found) return { content: "No notes of a teamspace the person is in with that teamspace_id.", isError: !teamspaceId };
      return searchNotes(found.notes, args);
    }
    case "person":
      return readMemory(userId, workspaceId, args);
    default: {
      // Every layer the question may read, each note saying whose it is; another teamspace only when named.
      const [mine, everywhere, shared] = await Promise.all([
        own ? notesOf(userId, workspaceId) : Promise.resolve([]),
        own ? accountNotesOf(userId) : Promise.resolve([]),
        sharedMemoryFor(userId, workspaceId, teamspaceId || null),
      ]);
      const of = (notes: PromptNote[], name: string) => notes.map((n) => ({ ...n, layer: name }));
      return searchNotes(
        [
          ...of(mine, "person"),
          ...of(everywhere, "account"),
          ...of(shared.workspace, "workspace"),
          ...(shared.teamspace ? of(shared.teamspace.notes, `teamspace ${shared.teamspace.name}`) : []),
        ],
        args,
      );
    }
  }
}

/** Where `remember` keeps a note: the person's own here, or another layer. */
const SCOPES = ["person", "account", "workspace", "teamspace"] as const;
type Scope = (typeof SCOPES)[number];

export const MEMORY_TOOLS: AiTool[] = [
  {
    name: "remember",
    description:
      "Keeps a short note for later conversations. By default about the person, in this workspace: who they are, what they work on, how they want answers. scope account keeps it for all their workspaces (only what is true of them everywhere, such as their language or how they want answers, never this workspace's work); scope workspace keeps it for everyone in the workspace, and scope teamspace (with teamspace_id) for everyone in that teamspace, when the person asks for that and may keep such notes. With replaces, the note takes the place of an older one of the same scope (to correct or update it).",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: `The note: one fact, in a sentence of at most ${MAX_MEMORY_CHARS} characters, in the person's language.` },
        details: {
          type: "string",
          description: `What the note says in full, when one line isn't enough (why, when it applies, the steps), at most ${MAX_MEMORY_DETAILS_CHARS} characters: read with read_memory, not sent with every question. With replaces, the older note's details stay unless given; an empty string drops them.`,
        },
        replaces: { type: "string", description: "The memory_id of the note this one takes the place of, if any." },
        category: {
          type: "string",
          enum: [...MEMORY_CATEGORIES],
          description:
            "What the note is about: profile (who they are: role, team, expertise, goals), preference (how they like to work and be answered, corrections), work (projects, decisions and why, deadlines, where things live), other. A note that replaces another keeps its category unless given.",
        },
        scope: { type: "string", enum: [...SCOPES], description: "Where it is kept: person (default), account, workspace or teamspace." },
        teamspace_id: { type: "string", description: "scope teamspace: the teamspace's id, from the question." },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "forget",
    description: "Drops a note from the memory, by its memory_id (the person's own, or one of the workspace or a teamspace they may change).",
    parameters: {
      type: "object",
      properties: { memory_id: { type: "string", description: "The memory_id of the note to drop." } },
      required: ["memory_id"],
      additionalProperties: false,
    },
  },
];
export const MEMORY_TOOL_NAMES = new Set(MEMORY_TOOLS.map((t) => t.name));

/** Where a note the chat keeps or drops goes, when not among the person's own notes here: `teamspaceId` for a teamspace's. */
type Where = { layer: MemoryLayer; teamspaceId: string | null; place: string | null };

/** A note the chat is about to keep or drop, checked, for the person to approve (see applyMemory). `where` null: the person's own here. */
export type PreparedMemory = {
  action: ChatActionView;
  where: Where | null;
  change:
    | { kind: "remember"; text: string; category: MemoryCategory | null; details: string | null | undefined; replaces: string | null; previous: ChatMemoryRecord["previous"] }
    | { kind: "forget"; id: string; text: string; previous: NonNullable<ChatMemoryRecord["previous"]> };
};

const NOT_FOUND: ToolOutcome = { content: "There is no note with that memory_id.", isError: true };

function refused(error: unknown): ToolOutcome {
  if (error instanceof AccessError) return { content: "The person may no longer change these notes: keep nothing there.", isError: true };
  if (!(error instanceof MemoryError)) throw error;
  if (error.code === "notFound") return NOT_FOUND;
  if (error.code === "full") return { content: `The memory is full (${MAX_MEMORIES} notes): replace or forget a note that matters less, or tell the person it is full.`, isError: true };
  if (error.code === "off") return { content: "The memory is turned off: keep nothing.", isError: true };
  if (error.code === "held") return { content: "A legal hold keeps this note: it can't be dropped while the hold stands. Tell the person.", isError: true };
  if (error.code === "tooLong") return { content: `Too long: a note may have at most ${MAX_MEMORY_CHARS} characters. Keep it shorter.`, isError: true };
  if (error.code === "detailsTooLong") return { content: `Too long: a note's details may have at most ${MAX_MEMORY_DETAILS_CHARS} characters. Keep them shorter.`, isError: true };
  return { content: "remember needs the text of the note.", isError: true };
}

/** What a note said before a change, for Undo. */
const was = (note: { text: string; kind?: MemoryKind; saidBy?: string | null; category?: MemoryCategory; details?: string | null }): NonNullable<ChatMemoryRecord["previous"]> => ({
  text: note.text,
  kind: note.kind ?? "note",
  saidBy: note.saidBy ?? null,
  ...(note.category ? { category: note.category } : {}),
  details: note.details ?? null,
});

const memoryAction = (action: "remember" | "forget", text: string, where: Where | null): ChatActionView => ({
  action,
  target: null,
  title: text,
  changes: [],
  content: null,
  ...(where ? { memoryLayer: { layer: where.layer, place: where.place } } : {}),
});

/** Why a layer's notes may not be changed, for the model to tell the person. */
const NOT_THEIRS = {
  workspace: "Only the workspace's owners keep its notes: say so; the person can ask an owner, or keep it as a note of their own.",
  teamspace: "Only those who manage this teamspace keep its notes (and only in a teamspace the person is in): say so; they can ask its owners, or keep it as a note of their own.",
} as const;

/**
 * The notes `scope` reaches, after checking the person may change them: their own here, theirs for
 * every workspace, the workspace's or a teamspace's. A ToolOutcome when they may not.
 */
async function notesFor(userId: string, workspaceId: string, scope: Scope, teamspaceId: string): Promise<{ where: Where | null; notes: (PromptNote & { saidBy?: string | null })[] } | ToolOutcome> {
  if (scope === "account") return { where: { layer: "account", teamspaceId: null, place: null }, notes: await accountNotesOf(userId) };
  if (scope === "workspace") {
    if (!(await mayWriteNotes(userId, workspaceId, null))) return { content: NOT_THEIRS.workspace, isError: true };
    return { where: { layer: "workspace", teamspaceId: null, place: null }, notes: await notesAt(workspaceId, null) };
  }
  if (scope === "teamspace") {
    if (!teamspaceId) return { content: "scope teamspace needs teamspace_id.", isError: true };
    const room = await teamspaceStanding(userId, teamspaceId);
    if (!room || room.workspaceId !== workspaceId || !room.joined || !(await mayWriteNotes(userId, workspaceId, teamspaceId))) return { content: NOT_THEIRS.teamspace, isError: true };
    return { where: { layer: "teamspace", teamspaceId, place: room.name }, notes: await notesAt(workspaceId, teamspaceId) };
  }
  return { where: null, notes: await notesOf(userId, workspaceId) };
}

/** Where the note to drop is, among the notes the person may change, or a ToolOutcome. */
async function findToForget(userId: string, workspaceId: string, id: string): Promise<{ where: Where | null; note: PromptNote & { saidBy?: string | null } } | ToolOutcome> {
  if (!id) return NOT_FOUND;
  const [mine, everywhere, shared] = await Promise.all([notesOf(userId, workspaceId), accountNotesOf(userId), notePlace(workspaceId, id)]);
  const own = mine.find((m) => m.id === id);
  if (own) return { where: null, note: own };
  const account = everywhere.find((m) => m.id === id);
  if (account) return { where: { layer: "account", teamspaceId: null, place: null }, note: account };
  if (!shared) return NOT_FOUND;
  const found = await notesFor(userId, workspaceId, shared.teamspaceId ? "teamspace" : "workspace", shared.teamspaceId ?? "");
  if (!("notes" in found)) return found;
  return { where: found.where, note: { id, text: shared.text } };
}

/**
 * Checks a `remember` or `forget` call before anything is asked or written: the note it drops or
 * replaces is one the person may change, the text fits, there is room. A note already kept there is
 * answered as such, with nothing to approve.
 */
export async function prepareMemory(
  userId: string,
  workspaceId: string,
  call: { name: string; arguments: Record<string, unknown> },
): Promise<PreparedMemory | ToolOutcome> {
  const arg = (name: string) => (typeof call.arguments[name] === "string" ? (call.arguments[name] as string).trim() : "");
  if (call.name === "forget") {
    const found = await findToForget(userId, workspaceId, arg("memory_id"));
    if (!("note" in found)) return found;
    const { where, note } = found;
    return { action: memoryAction("forget", note.text, where), where, change: { kind: "forget", id: note.id, text: note.text, previous: was(note) } };
  }
  let text: string;
  let details: string | null | undefined;
  try {
    text = cleanNote(arg("text"));
    details = typeof call.arguments.details === "string" ? cleanDetails(call.arguments.details) : undefined;
  } catch (error) {
    return refused(error);
  }
  const scope = (SCOPES as readonly string[]).includes(arg("scope")) ? (arg("scope") as Scope) : "person";
  const found = await notesFor(userId, workspaceId, scope, arg("teamspace_id"));
  if (!("notes" in found)) return found;
  const { where, notes } = found;
  const replaces = arg("replaces") || null;
  const replaced = replaces ? notes.find((m) => m.id === replaces) : undefined;
  if (replaces && !replaced) return NOT_FOUND;
  const known = notes.find((m) => m.id !== replaces && sameNote(m.text, text));
  if (known && !replaces) return { content: `Already remembered (memory_id ${known.id}).` };
  if (!replaces && notes.length >= MAX_MEMORIES) return refused(new MemoryError("full", ""));
  const category = isMemoryCategory(arg("category")) ? (arg("category") as MemoryCategory) : null;
  return { action: memoryAction("remember", text, where), where, change: { kind: "remember", text, category, details, replaces, previous: replaced ? was(replaced) : null } };
}

/**
 * Keeps or drops the note once approved (or, for the person's own notes here, without asking in
 * mode `auto`). Undo is on the step of a note of their own here only: the others were asked about.
 */
export async function applyMemory(
  userId: string,
  workspaceId: string,
  conversationId: string,
  prepared: PreparedMemory,
  decision: ChatDecision,
): Promise<ToolOutcome> {
  const { change, where } = prepared;
  const layer = where ? { layer: where.layer, ...(where.place ? { place: where.place } : {}) } : {};
  const step = (outcome: ChatMemoryRecord["outcome"], text: string): ChatMemoryRecord => ({ kind: "memory", action: change.kind, text, outcome, ...layer });
  if (decision === "decline") {
    return { content: "The person declined: don't keep or drop this note, and don't ask again.", step: step("declined", change.text) };
  }
  try {
    if (change.kind === "forget") {
      if (where?.layer === "account") {
        if (!(await deleteAccountNotes(userId, [change.id])).length) return NOT_FOUND;
        return { content: "Forgotten.", step: step("done", change.text) };
      }
      if (where) {
        if (!(await deleteSharedNotes(userId, workspaceId, where.teamspaceId, [change.id])).length) return NOT_FOUND;
        return { content: "Forgotten.", step: step("done", change.text) };
      }
      const [gone] = await db
        .delete(aiMemory)
        .where(and(eq(aiMemory.id, change.id), eq(aiMemory.userId, userId), eq(aiMemory.workspaceId, workspaceId)))
        .returning();
      if (!gone) return NOT_FOUND;
      return { content: "Forgotten.", step: { ...step("done", gone.text), memoryId: gone.id, previous: change.previous } };
    }
    if (where) {
      const kept =
        where.layer === "account"
          ? await writeAccountNote(userId, change.text, { replaces: change.replaces, category: change.category, details: change.details })
          : await writeSharedNote(userId, workspaceId, where.teamspaceId, change.text, { replaces: change.replaces, category: change.category, details: change.details });
      return { content: `Remembered (memory_id ${kept.id}).`, step: step("done", kept.text) };
    }
    const kept = await writeNote(userId, workspaceId, change.text, { replaces: change.replaces, conversationId, category: change.category, details: change.details });
    // One the person had already is theirs as it was: nothing to undo.
    const undo = kept.known ? {} : { memoryId: kept.id, previous: change.previous };
    return { content: `Remembered (memory_id ${kept.id}).`, step: { ...step("done", kept.text), ...undo } };
  } catch (error) {
    return refused(error);
  }
}

/**
 * Undoes what a step of the chat did to a note (applyMemory): a note it kept goes, one it changed
 * says again what it said, one it dropped comes back. `changed` when the note was changed since
 * (in the Memory view, by a later answer), `full` when a dropped note has no room to come back.
 */
export async function undoNote(userId: string, workspaceId: string, step: ChatMemoryRecord): Promise<"done" | "changed" | "full"> {
  if (!step.memoryId) return "changed";
  const id = step.memoryId;
  return db.transaction(async (tx) => {
    await lockNotes(tx, userId, workspaceId);
    const notes = await notesOf(userId, workspaceId, tx, null);
    const note = notes.find((n) => n.id === id);
    if (step.action === "forget") {
      if (!step.previous || note) return "changed";
      if (notes.some((n) => n.status === "kept" && sameNote(n.text, step.previous!.text))) return "done";
      if (notes.filter((n) => n.status === "kept").length >= MAX_MEMORIES) return "full";
      await tx
        .insert(aiMemory)
        .values({
          id,
          userId,
          workspaceId,
          text: step.previous.text,
          category: step.previous.category ?? "other",
          details: step.previous.details ?? null,
          kind: step.previous.kind,
          saidBy: step.previous.saidBy,
          status: "kept",
        });
      return "done";
    }
    if (!note || note.status !== "kept" || note.text !== step.text) return "changed";
    if (step.previous) {
      await tx
        .update(aiMemory)
        .set({
          text: step.previous.text,
          ...(step.previous.category ? { category: step.previous.category } : {}),
          ...(step.previous.details !== undefined ? { details: step.previous.details } : {}),
          kind: step.previous.kind,
          saidBy: step.previous.saidBy,
          updatedAt: new Date(),
        })
        .where(eq(aiMemory.id, id));
    } else await tx.delete(aiMemory).where(eq(aiMemory.id, id));
    return "done";
  });
}

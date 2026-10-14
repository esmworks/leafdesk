/**
 * An agent's memory: short notes that go with each of its runs, so it needn't learn again what it
 * learned in earlier ones (where things go in the workspace, how its owners want something done).
 * They are kept in ai_memory under the agent's own user (server/ai-memory.ts).
 *
 * Nobody speaks to an agent during a run: all it reads is someone else's writing (the row, pages,
 * an event, what connected services return), so a note a run kept on its own could carry anyone's
 * orders into every later run. A run therefore only proposes notes (`remember`): a proposal goes
 * with no run until one of the workspace's owners keeps it, as it is or changed, in the agent's
 * Memory tab, where they also write, change and delete notes. A run may drop a note at once
 * (`forget`), which loses at most that note. Runs whose input no member stands behind (askEveryTool
 * in run.ts) get neither tool. Proposals are bounded (MAX_AGENT_PROPOSALS) and go with their run
 * when no owner answered them by the time it is pruned.
 *
 * Kept notes go with every later run, whoever starts it: like the agent's instructions, what they
 * say may end up in what it writes. A proposal may quote the row its run was on, so an owner who
 * can't open that row doesn't see its text and may only dismiss it.
 *
 * The workspace's AI memory switch (ai-memory.ts memoryAvailable) holds for agents too: while it
 * is off, runs carry no notes and keep none; owners still see and change them here.
 */
import { and, asc, count, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { agentRun, aiMemory, connection, page, workspaceAgent, type ChatMemoryRecord } from "@/db/schema";
import { isRowRun, MAX_AGENT_PROPOSALS, type AgentMemoryView } from "@/lib/agents";
import { MAX_MEMORIES, MAX_MEMORY_CHARS } from "@/lib/ai-chat";
import { redactText } from "@/lib/redact";
import { pageVisibleTo, requireMembership } from "@/server/access";
import type { AiTool } from "@/server/ai";
import { cleanNote, lockNotes, MemoryError, sameNote, writeNote } from "@/server/ai-memory";
import { recordAudit } from "@/server/audit";
import { AgentError, auditDetails, ownedAgent } from "./manage";

type Agent = Awaited<ReturnType<typeof ownedAgent>>;
type Note = typeof aiMemory.$inferSelect;

/** A MemoryError as the agents' error, for the app and MCP to word. */
function asAgentError(error: unknown): never {
  if (!(error instanceof MemoryError)) throw error;
  if (error.code === "empty") throw new AgentError("noteEmpty", error.message);
  if (error.code === "tooLong") throw new AgentError("noteTooLong", error.message, { max: String(MAX_MEMORY_CHARS) });
  if (error.code === "full") throw new AgentError("memoryFull", error.message, { max: String(MAX_MEMORIES) });
  throw new AgentError("noteNotFound", error.message);
}

const notesOf = (agent: Agent) =>
  db
    .select()
    .from(aiMemory)
    .where(and(eq(aiMemory.userId, agent.userId), eq(aiMemory.workspaceId, agent.workspaceId)))
    .orderBy(asc(aiMemory.createdAt), asc(aiMemory.id));

/** The note of this agent with this id, or a notFound error. */
async function noteOf(agent: Agent, memoryId: string): Promise<Note> {
  const [note] = await db
    .select()
    .from(aiMemory)
    .where(and(eq(aiMemory.id, memoryId), eq(aiMemory.userId, agent.userId), eq(aiMemory.workspaceId, agent.workspaceId)));
  if (!note) throw new AgentError("noteNotFound", "Note not found");
  return note;
}

/** The runs that proposed these notes, as `viewer` may see them: a row's title only when they can open it. */
async function proposingRuns(viewer: string, notes: Note[]): Promise<Map<string, NonNullable<AgentMemoryView["run"]>>> {
  const runIds = [...new Set(notes.flatMap((n) => (n.agentRunId ? [n.agentRunId] : [])))];
  if (!runIds.length) return new Map();
  const runs = await db.select({ id: agentRun.id, source: agentRun.source, createdAt: agentRun.createdAt }).from(agentRun).where(inArray(agentRun.id, runIds));
  const rowIds = runs.flatMap((r) => (isRowRun(r.source) ? [r.source.rowId] : []));
  const connectionIds = runs.flatMap((r) => (isRowRun(r.source) ? [] : [r.source.connectionId]));
  const titles = new Map(
    rowIds.length ? (await db.select({ id: page.id, title: page.title }).from(page).where(and(inArray(page.id, rowIds), pageVisibleTo(viewer)))).map((p) => [p.id, p.title]) : [],
  );
  const names = new Map(
    connectionIds.length ? (await db.select({ id: connection.id, name: connection.name }).from(connection).where(inArray(connection.id, connectionIds))).map((c) => [c.id, c.name]) : [],
  );
  return new Map(
    runs.map((r) => [
      r.id,
      {
        id: r.id,
        createdAt: r.createdAt.toISOString(),
        rowId: isRowRun(r.source) ? r.source.rowId : null,
        rowTitle: isRowRun(r.source) ? (titles.get(r.source.rowId) ?? null) : null,
        connectionName: isRowRun(r.source) ? null : (names.get(r.source.connectionId) ?? ""),
      },
    ]),
  );
}

/** Whether `viewer` may read a proposal: not when it came from a run on a row they can't open. */
const readable = (run: AgentMemoryView["run"] | undefined) => !run || run.rowId === null || run.rowTitle !== null;

function view(note: Note, run: AgentMemoryView["run"] | undefined): AgentMemoryView {
  return {
    id: note.id,
    text: note.status === "proposed" && !readable(run) ? null : note.text,
    status: note.status,
    run: run ?? null,
    createdAt: note.createdAt.toISOString(),
    updatedAt: note.updatedAt.toISOString(),
  };
}

const audit = (userId: string, agent: Agent, memory: Record<string, number>) =>
  recordAudit({
    workspaceId: agent.workspaceId,
    actorId: userId,
    action: "agent.updated",
    target: { type: "user", id: agent.userId, label: agent.name },
    // How many notes, not what they say: notes may quote rows not everyone reading the log can open.
    details: { ...auditDetails(agent), previous: auditDetails(agent), memory },
  });

/** The agent's notes, oldest first: kept ones and proposals waiting for an owner. Owners only. */
export async function listAgentMemory(userId: string, agentId: string): Promise<AgentMemoryView[]> {
  const agent = await ownedAgent(userId, agentId);
  const notes = await notesOf(agent);
  const runs = await proposingRuns(userId, notes);
  return notes.map((n) => view(n, n.agentRunId ? runs.get(n.agentRunId) : undefined));
}

/** An owner writes a note: kept at once (refused at MAX_MEMORIES kept ones). */
export async function addAgentMemory(userId: string, agentId: string, text: string): Promise<AgentMemoryView> {
  const agent = await ownedAgent(userId, agentId);
  if (agent.archivedAt) throw new AgentError("archived", "Restore the agent to change its memory");
  let note = await writeNote(agent.userId, agent.workspaceId, text).catch(asAgentError);
  if (note.status === "proposed") {
    // The same text a run proposed: the owner wrote it themselves, so it is kept (also a proposal
    // they couldn't read: what they wrote hides nothing from them).
    const [kept] = await db.update(aiMemory).set({ status: "kept", agentRunId: null, updatedAt: new Date() }).where(eq(aiMemory.id, note.id)).returning();
    note = kept ?? note;
    await audit(userId, agent, { kept: 1 });
    return view(note, undefined);
  }
  await audit(userId, agent, { added: 1 });
  return view(note, undefined);
}

/** An owner changes a note's text; a proposal stays one (keepAgentMemory keeps it). */
export async function updateAgentMemory(userId: string, agentId: string, memoryId: string, text: string): Promise<AgentMemoryView> {
  const agent = await ownedAgent(userId, agentId);
  if (agent.archivedAt) throw new AgentError("archived", "Restore the agent to change its memory");
  const clean = (() => {
    try {
      return cleanNote(text);
    } catch (error) {
      return asAgentError(error);
    }
  })();
  const note = await noteOf(agent, memoryId);
  const run = (await proposingRuns(userId, [note])).get(note.agentRunId ?? "");
  if (note.status === "proposed" && !readable(run)) throw new AgentError("noteNotFound", "Note not found");
  const [changed] = await db.update(aiMemory).set({ text: clean, updatedAt: new Date() }).where(eq(aiMemory.id, note.id)).returning();
  await audit(userId, agent, { changed: 1 });
  return view(changed, run);
}

/**
 * An owner keeps a proposal (with `text`: changed first), so it goes with the agent's runs from now
 * on. A proposal from a run on a row the owner can't open can't be kept by them. When the agent
 * already keeps the same text, the proposal just goes.
 */
export async function keepAgentMemory(userId: string, agentId: string, memoryId: string, text?: string): Promise<AgentMemoryView> {
  const agent = await ownedAgent(userId, agentId);
  if (agent.archivedAt) throw new AgentError("archived", "Restore the agent to change its memory");
  const proposal = await noteOf(agent, memoryId);
  if (proposal.status !== "proposed") return view(proposal, undefined);
  const run = (await proposingRuns(userId, [proposal])).get(proposal.agentRunId ?? "");
  if (!readable(run)) throw new AgentError("noteNotFound", "Note not found");
  let clean: string;
  try {
    clean = cleanNote(text ?? proposal.text);
  } catch (error) {
    return asAgentError(error);
  }
  const kept = await db.transaction(async (tx) => {
    await lockNotes(tx, agent.userId, agent.workspaceId);
    const notes = await tx
      .select()
      .from(aiMemory)
      .where(and(eq(aiMemory.userId, agent.userId), eq(aiMemory.workspaceId, agent.workspaceId), eq(aiMemory.status, "kept")));
    const known = notes.find((n) => sameNote(n.text, clean));
    if (known) {
      await tx.delete(aiMemory).where(eq(aiMemory.id, proposal.id));
      return known;
    }
    if (notes.length >= MAX_MEMORIES) throw new AgentError("memoryFull", "The memory is full", { max: String(MAX_MEMORIES) });
    // Kept, it no longer hangs on its run: it stays when the run is pruned.
    const [changed] = await tx
      .update(aiMemory)
      .set({ text: clean, status: "kept", agentRunId: null, updatedAt: new Date() })
      .where(and(eq(aiMemory.id, proposal.id), eq(aiMemory.status, "proposed")))
      .returning();
    if (!changed) throw new AgentError("noteNotFound", "Note not found");
    return changed;
  });
  await audit(userId, agent, { kept: 1 });
  return view(kept, undefined);
}

/** An owner deletes notes of the agent (dismissing proposals too): some, every kept one, or every proposal. */
export async function deleteAgentMemory(userId: string, agentId: string, which: string[] | "kept" | "proposed"): Promise<void> {
  const agent = await ownedAgent(userId, agentId);
  const gone = await db
    .delete(aiMemory)
    .where(
      and(
        eq(aiMemory.userId, agent.userId),
        eq(aiMemory.workspaceId, agent.workspaceId),
        Array.isArray(which) ? inArray(aiMemory.id, which.length ? which : [""]) : eq(aiMemory.status, which),
      ),
    )
    .returning({ status: aiMemory.status });
  if (!gone.length) return;
  const deleted = gone.filter((n) => n.status === "kept").length;
  const dismissed = gone.length - deleted;
  await audit(userId, agent, { ...(deleted ? { deleted } : {}), ...(dismissed ? { dismissed } : {}) });
}

// ------------------------------------------------------------------------------------ runs

export const AGENT_MEMORY_TOOLS: AiTool[] = [
  {
    name: "remember",
    description:
      "Proposes a short note for your later runs: something you learned doing this task that will still help (where things go in the workspace, which database holds what, how a recurring case is handled). An owner of the workspace reads each proposal and decides whether you keep it; until then it goes with no run.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: `The note: one fact, in a sentence of at most ${MAX_MEMORY_CHARS} characters, in the language of your instructions.` },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "forget",
    description: "Drops a note from your memory, by its memory_id: one that turned out wrong or out of date.",
    parameters: {
      type: "object",
      properties: { memory_id: { type: "string", description: "The memory_id of the note to drop." } },
      required: ["memory_id"],
      additionalProperties: false,
    },
  },
];
export const AGENT_MEMORY_TOOL_NAMES = new Set(AGENT_MEMORY_TOOLS.map((t) => t.name));

const step = (action: ChatMemoryRecord["action"], text: string): ChatMemoryRecord => ({ kind: "memory", action, text });

/** Runs `remember` (a proposal) or `forget` for a run of the agent, on the agent's own notes. */
export async function runAgentMemoryTool(
  agent: { userId: string; workspaceId: string },
  runId: string,
  call: { name: string; arguments: Record<string, unknown> },
): Promise<{ content: string; isError?: boolean; step?: ChatMemoryRecord }> {
  const arg = (name: string) => (typeof call.arguments[name] === "string" ? (call.arguments[name] as string).trim() : "");
  if (call.name === "forget") {
    const id = arg("memory_id");
    const notFound = { content: "There is no note with that memory_id.", isError: true };
    if (!id || id.length > 100) return notFound;
    const [gone] = await db
      .delete(aiMemory)
      .where(and(eq(aiMemory.id, id), eq(aiMemory.userId, agent.userId), eq(aiMemory.workspaceId, agent.workspaceId)))
      .returning();
    if (!gone) return notFound;
    return { content: "Forgotten.", step: step("forget", gone.text) };
  }
  try {
    // A note outlives the run: a credential the run came across must not.
    const note = await writeNote(agent.userId, agent.workspaceId, redactText(arg("text")), { status: "proposed", agentRunId: runId, maxProposed: MAX_AGENT_PROPOSALS });
    if (note.status === "kept") return { content: `Your memory already has this note (memory_id ${note.id}).` };
    return {
      content: "Proposed. An owner of the workspace will read it and decide whether you keep it: it is not in your memory yet, and nothing in this run changes because of it.",
      step: step("propose", note.text),
    };
  } catch (error) {
    if (!(error instanceof MemoryError)) throw error;
    if (error.code === "full") return { content: `${MAX_AGENT_PROPOSALS} of your notes already wait for an owner: don't propose more now.`, isError: true };
    if (error.code === "tooLong") return { content: `Too long: a note may have at most ${MAX_MEMORY_CHARS} characters. Keep it shorter.`, isError: true };
    return { content: "remember needs the text of the note.", isError: true };
  }
}

/** How many proposals wait for an owner, per agent of the workspace, for its owners' list of agents. */
export async function proposedNoteCounts(userId: string, workspaceId: string): Promise<Record<string, number>> {
  await requireMembership(userId, workspaceId, "owner");
  const rows = await db
    .select({ agentId: workspaceAgent.id, count: count() })
    .from(aiMemory)
    .innerJoin(workspaceAgent, eq(workspaceAgent.userId, aiMemory.userId))
    .where(and(eq(aiMemory.workspaceId, workspaceId), eq(workspaceAgent.workspaceId, workspaceId), eq(aiMemory.status, "proposed")))
    .groupBy(workspaceAgent.id);
  return Object.fromEntries(rows.map((r) => [r.agentId, r.count]));
}

/**
 * An agent's memory: short notes that go with each of its runs, so it needn't learn again what it
 * learned in earlier ones (where things go in the workspace, how its owners want something done).
 * They are kept in ai_memory under the agent's own user (server/ai-memory.ts).
 *
 * Nobody speaks to an agent during a run: all it reads is someone else's writing (the row, pages,
 * an event, what connected services return), so a note a run kept on its own could carry anyone's
 * orders into every later run. A run therefore only proposes notes (`remember`): a proposal goes
 * with no run until someone who can edit the agent (a workspace owner, or someone it is shared
 * with at full access or can edit, see sharing.ts) keeps it, as it is or changed, in the agent's
 * Memory tab, where they also write, change and delete notes. A run may drop a note at once
 * (`forget`), which loses at most that note. Runs whose input no member stands behind (askEveryTool
 * in run.ts) get neither tool. Proposals are bounded (MAX_AGENT_PROPOSALS) and go with their run
 * when no owner answered them by the time it is pruned.
 *
 * A run proposes few notes (MAX_PROPOSALS_PER_RUN), and a correction of a kept note as its new
 * text (`replaces`): kept, it changes that note in place. A schedule's run is shown the proposals
 * of that schedule's earlier runs that still wait, so it changes one rather than proposing it again.
 *
 * Where a schedule's run left off (what it checked, what remains) isn't a note: it goes in the
 * run's `handoff` (`note_for_next_run`), which only the same schedule's next run reads (set by the
 * same owner, on the same database, with the same task), with no owner to approve it. That run
 * reads the same data anyway, so the note carries nothing to runs that read other things.
 *
 * Kept notes go with every later run, whoever starts it: like the agent's instructions, what they
 * say may end up in what it writes. A proposal may quote the row its run was on, so an owner who
 * can't open that row doesn't see its text and may only dismiss it.
 *
 * The workspace's AI memory switch (ai-memory.ts memoryAvailable) holds for agents too: while it
 * is off, runs carry no notes and keep none; owners still see and change them here.
 *
 * A proposal puts an item in each workspace owner's inbox when they have none for the agent yet (one
 * per agent and owner, pushed too), or makes the one they read or archived new again; it counts the
 * agent's waiting proposals, shows the first one's text by the same rule as here, and goes once
 * none waits.
 */
import { and, asc, count, desc, eq, inArray, isNotNull, ne, notExists, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentRun, aiMemory, connection, notification, page, workspaceAgent, type ChatMemoryRecord } from "@/db/schema";
import { hasAgentLevel } from "@/lib/agent-sharing";
import {
  isEventRun,
  isRowRun,
  isScheduleRun,
  MAX_AGENT_PROPOSALS,
  MAX_HANDOFF_CHARS,
  MAX_PROPOSALS_PER_RUN,
  type AgentMemoryView,
  type AgentRunSource,
} from "@/lib/agents";
import { MAX_MEMORIES, MAX_MEMORY_CHARS } from "@/lib/ai-chat";
import { redactError, redactText } from "@/lib/redact";
import { pageVisibleTo, requireMembership, workspaceOwnerIds } from "@/server/access";
import type { AiTool } from "@/server/ai";
import { cleanNote, lockNotes, memoryAvailable, MemoryError, sameNote, writeNote } from "@/server/ai-memory";
import { recordAudit } from "@/server/audit";
import { signalInbox, type InboxAgentMemory } from "@/server/notifications";
import { pushNotifications } from "@/server/push";
import { AgentError, agentFor, auditDetails } from "./manage";
import { agentLevels } from "./sharing";

type Agent = Awaited<ReturnType<typeof agentFor>>;
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
  // A run another owner asked for, or one of their schedules without a database, read with their access (see viewRuns).
  const othersRun = (source: (typeof runs)[number]["source"]) =>
    source.kind === "request"
      ? source.requestedBy !== viewer
      : source.kind === "chat"
        ? source.userId !== viewer
        : isScheduleRun(source) && !source.databaseId && source.scheduledBy !== viewer;
  const databaseIds = runs.flatMap((r) => (isScheduleRun(r.source) && r.source.databaseId ? [r.source.databaseId] : []));
  const openDatabases = new Set(
    databaseIds.length ? (await db.select({ id: page.id }).from(page).where(and(inArray(page.id, databaseIds), pageVisibleTo(viewer)))).map((p) => p.id) : [],
  );
  const connectionIds = runs.flatMap((r) => (isEventRun(r.source) ? [r.source.connectionId] : []));
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
        connectionName: isEventRun(r.source) ? (names.get(r.source.connectionId) ?? "") : null,
        requested: r.source.kind === "request" || r.source.kind === "chat",
        scheduled: isScheduleRun(r.source),
        databaseHidden: isScheduleRun(r.source) && Boolean(r.source.databaseId) && !openDatabases.has(r.source.databaseId!),
        othersRun: othersRun(r.source),
      },
    ]),
  );
}

/**
 * Whether `viewer` may read a proposal: not when it came from a run on a row (or a schedule's
 * database) they can't open, nor from a run another owner started for themselves.
 */
const readable = (run: AgentMemoryView["run"] | undefined) =>
  !run || ((run.rowId === null || run.rowTitle !== null) && !run.databaseHidden && !run.othersRun);

function view(note: Note, run: AgentMemoryView["run"] | undefined, replaced?: Note): AgentMemoryView {
  return {
    id: note.id,
    text: note.status === "proposed" && !readable(run) ? null : note.text,
    status: note.status,
    run: run ?? null,
    replaces: note.status === "proposed" && replaced ? { id: replaced.id, text: replaced.text } : null,
    createdAt: note.createdAt.toISOString(),
    updatedAt: note.updatedAt.toISOString(),
  };
}

/** The kept note a proposal would change, if it still is one. */
async function replacedOf(note: Note): Promise<Note | undefined> {
  if (note.status !== "proposed" || !note.replacesId) return undefined;
  const [replaced] = await db.select().from(aiMemory).where(and(eq(aiMemory.id, note.replacesId), eq(aiMemory.status, "kept")));
  return replaced;
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

/** The agent's notes, oldest first: kept ones and proposals waiting to be kept, for anyone the agent is shared with. */
export async function listAgentMemory(userId: string, agentId: string): Promise<AgentMemoryView[]> {
  const agent = await agentFor(userId, agentId, "interact");
  const notes = await notesOf(agent);
  const runs = await proposingRuns(userId, notes);
  const kept = new Map(notes.filter((n) => n.status === "kept").map((n) => [n.id, n]));
  return notes.map((n) => view(n, n.agentRunId ? runs.get(n.agentRunId) : undefined, n.replacesId ? kept.get(n.replacesId) : undefined));
}

/** An owner writes a note: kept at once (refused at MAX_MEMORIES kept ones). */
export async function addAgentMemory(userId: string, agentId: string, text: string): Promise<AgentMemoryView> {
  const agent = await agentFor(userId, agentId, "edit");
  if (agent.archivedAt) throw new AgentError("archived", "Restore the agent to change its memory");
  let note = await writeNote(agent.userId, agent.workspaceId, text).catch(asAgentError);
  if (note.status === "proposed") {
    // The same text a run proposed: the owner wrote it themselves, so it is kept (also a proposal
    // they couldn't read: what they wrote hides nothing from them).
    const [kept] = await db.update(aiMemory).set({ status: "kept", agentRunId: null, replacesId: null, updatedAt: new Date() }).where(eq(aiMemory.id, note.id)).returning();
    await withdrawNotices([note.agentRunId]);
    note = kept ?? note;
    await audit(userId, agent, { kept: 1 });
    return view(note, undefined);
  }
  await audit(userId, agent, { added: 1 });
  return view(note, undefined);
}

/** An owner changes a note's text; a proposal stays one (keepAgentMemory keeps it). */
export async function updateAgentMemory(userId: string, agentId: string, memoryId: string, text: string): Promise<AgentMemoryView> {
  const agent = await agentFor(userId, agentId, "edit");
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
  return view(changed, run, await replacedOf(changed));
}

/**
 * An owner keeps a proposal (with `text`: changed first), so it goes with the agent's runs from now
 * on: one with `replacesId` changes that kept note to its text instead of adding one. A proposal
 * from a run on a row the owner can't open can't be kept by them. When the agent already keeps the
 * same text, the proposal just goes (and the note it would change, which that one now says).
 */
export async function keepAgentMemory(userId: string, agentId: string, memoryId: string, text?: string): Promise<AgentMemoryView> {
  const agent = await agentFor(userId, agentId, "edit");
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
    const target = proposal.replacesId ? notes.find((n) => n.id === proposal.replacesId) : undefined;
    const known = notes.find((n) => n.id !== target?.id && sameNote(n.text, clean));
    if (known) {
      await tx.delete(aiMemory).where(inArray(aiMemory.id, target ? [proposal.id, target.id] : [proposal.id]));
      return known;
    }
    if (target) {
      await tx.delete(aiMemory).where(eq(aiMemory.id, proposal.id));
      const [changed] = await tx.update(aiMemory).set({ text: clean, updatedAt: new Date() }).where(eq(aiMemory.id, target.id)).returning();
      return changed;
    }
    if (notes.length >= MAX_MEMORIES) throw new AgentError("memoryFull", "The memory is full", { max: String(MAX_MEMORIES) });
    // Kept, it no longer hangs on its run: it stays when the run is pruned.
    const [changed] = await tx
      .update(aiMemory)
      .set({ text: clean, status: "kept", agentRunId: null, replacesId: null, updatedAt: new Date() })
      .where(and(eq(aiMemory.id, proposal.id), eq(aiMemory.status, "proposed")))
      .returning();
    if (!changed) throw new AgentError("noteNotFound", "Note not found");
    return changed;
  });
  await withdrawNotices([proposal.agentRunId]);
  await audit(userId, agent, { kept: 1 });
  return view(kept, undefined);
}

/**
 * An owner deletes notes of the agent (dismissing proposals too): some, every kept one, or every
 * proposal; with `only`, of the given ids just those in that state. Returns how many went.
 */
export async function deleteAgentMemory(userId: string, agentId: string, which: string[] | "kept" | "proposed", only?: "kept" | "proposed"): Promise<number> {
  const agent = await agentFor(userId, agentId, "edit");
  const gone = await db
    .delete(aiMemory)
    .where(
      and(
        eq(aiMemory.userId, agent.userId),
        eq(aiMemory.workspaceId, agent.workspaceId),
        Array.isArray(which) ? inArray(aiMemory.id, which.length ? which : [""]) : eq(aiMemory.status, which),
        only ? eq(aiMemory.status, only) : undefined,
      ),
    )
    .returning({ status: aiMemory.status, agentRunId: aiMemory.agentRunId });
  if (!gone.length) return 0;
  await withdrawNotices(gone.map((n) => n.agentRunId));
  const deleted = gone.filter((n) => n.status === "kept").length;
  const dismissed = gone.length - deleted;
  await audit(userId, agent, { ...(deleted ? { deleted } : {}), ...(dismissed ? { dismissed } : {}) });
  return gone.length;
}

// ------------------------------------------------------------------------------------ inbox

/** Tells the workspace's open sidebars to fetch their inbox again; the items are saved whether or not it reaches them. */
function refreshInboxes(workspaceId: string) {
  try {
    signalInbox(workspaceId);
  } catch (error) {
    console.error("[agents] could not refresh inboxes", redactError(error));
  }
}

/**
 * Tells the workspace's owners a run proposed notes: an inbox item each who has none for the agent
 * yet. One they have already comes back as new (unread, in the inbox, on top) unless they snoozed
 * it, without another push.
 */
async function noticeProposal(agent: { userId: string; workspaceId: string }, runId: string) {
  const owners = await workspaceOwnerIds(agent.workspaceId);
  if (!owners.length) return;
  const ofAgent = and(eq(notification.kind, "agent_memory"), eq(notification.actorId, agent.userId), eq(notification.workspaceId, agent.workspaceId), inArray(notification.userId, owners));
  const told = new Set((await db.select({ userId: notification.userId }).from(notification).where(ofAgent)).map((n) => n.userId));
  const renewed = await db
    .update(notification)
    .set({ readAt: null, archivedAt: null, createdAt: new Date() })
    .where(and(ofAgent, or(isNotNull(notification.readAt), isNotNull(notification.archivedAt)), sql`(${notification.snoozedUntil} is null or ${notification.snoozedUntil} <= now())`))
    .returning({ id: notification.id });
  if (renewed.length) refreshInboxes(agent.workspaceId);
  const untold = owners.filter((userId) => !told.has(userId));
  if (!untold.length) return;
  const inserted = await db
    .insert(notification)
    .values(untold.map((userId) => ({ userId, workspaceId: agent.workspaceId, kind: "agent_memory" as const, actorId: agent.userId, agentRunId: runId })))
    .onConflictDoNothing({ target: [notification.agentRunId, notification.userId], where: sql`${notification.kind} = 'agent_memory'` })
    .returning({ id: notification.id });
  if (!inserted.length) return;
  refreshInboxes(agent.workspaceId);
  pushNotifications(inserted.map((n) => n.id));
}

/**
 * Once none of these runs' proposals waits any more, moves their items to another run of the agent
 * whose proposals wait (the earliest), or takes them out of the inbox when none does.
 */
async function withdrawNotices(runIds: (string | null)[]) {
  const ids = [...new Set(runIds.filter((id): id is string => id !== null))];
  if (!ids.length) return;
  // The earliest run of the item's agent with a proposal waiting, unless the owner has an item there already.
  const next = sql`(
    select m.agent_run_id from ${aiMemory} m
    where m.user_id = ${notification.actorId} and m.workspace_id = ${notification.workspaceId} and m.status = 'proposed' and m.agent_run_id is not null
      and not exists (select 1 from ${notification} o where o.kind = 'agent_memory' and o.agent_run_id = m.agent_run_id and o.user_id = ${notification.userId})
    order by m.created_at, m.id limit 1
  )`;
  const waitsHere = db
    .select({ id: aiMemory.id })
    .from(aiMemory)
    .where(and(eq(aiMemory.agentRunId, notification.agentRunId), eq(aiMemory.status, "proposed")));
  await db
    .update(notification)
    .set({ agentRunId: next })
    .where(and(eq(notification.kind, "agent_memory"), inArray(notification.agentRunId, ids), notExists(waitsHere), sql`${next} is not null`));
  const gone = await db
    .delete(notification)
    .where(
      and(
        eq(notification.kind, "agent_memory"),
        inArray(notification.agentRunId, ids),
        notExists(
          db
            .select({ id: aiMemory.id })
            .from(aiMemory)
            .where(and(eq(aiMemory.agentRunId, notification.agentRunId), eq(aiMemory.status, "proposed"))),
        ),
      ),
    )
    .returning({ workspaceId: notification.workspaceId });
  for (const workspaceId of new Set(gone.map((g) => g.workspaceId))) refreshInboxes(workspaceId);
}

/**
 * For the inbox items of these runs, the proposals of each one's agent that still wait, as
 * `viewer`'s inbox shows them: how many, and the first one's text when the viewer may read it (not
 * from a run on a row they can't open).
 */
export async function inboxProposals(viewer: string, runIds: string[]): Promise<Map<string, InboxAgentMemory>> {
  if (!runIds.length) return new Map();
  const runs = await db
    .select({ id: agentRun.id, agentId: agentRun.agentId })
    .from(agentRun)
    .where(inArray(agentRun.id, runIds));
  const agentIds = [...new Set(runs.map((r) => r.agentId))];
  if (!agentIds.length) return new Map();
  const notes = await db
    .select({ note: aiMemory, agentId: workspaceAgent.id, agentName: workspaceAgent.name })
    .from(aiMemory)
    .innerJoin(workspaceAgent, and(eq(workspaceAgent.userId, aiMemory.userId), eq(workspaceAgent.workspaceId, aiMemory.workspaceId)))
    .where(and(inArray(workspaceAgent.id, agentIds), eq(aiMemory.status, "proposed"), isNotNull(aiMemory.agentRunId)))
    .orderBy(asc(aiMemory.createdAt), asc(aiMemory.id));
  const proposing = await proposingRuns(viewer, notes.map((n) => n.note));
  const byAgent = new Map<string, Omit<InboxAgentMemory, "runId">>();
  for (const { note, agentId, agentName } of notes) {
    const seen = byAgent.get(agentId);
    if (seen) seen.count += 1;
    else byAgent.set(agentId, { agentId, agentName, count: 1, text: readable(proposing.get(note.agentRunId!)) ? note.text : null });
  }
  return new Map(runs.flatMap((r) => {
    const waiting = byAgent.get(r.agentId);
    return waiting ? [[r.id, { runId: r.id, ...waiting }] as const] : [];
  }));
}

// ------------------------------------------------------------------------------------ runs

export const AGENT_MEMORY_TOOLS: AiTool[] = [
  {
    name: "remember",
    description:
      "Proposes a short note for your later runs: a fact about the workspace that will still be true next month (where things go, which database or sheet holds what and how it is laid out, how a recurring case is handled). An owner of the workspace reads each proposal and decides whether you keep it; until then it goes with no run. Never propose progress: what you checked, what remains, counts, positions or dates that change from run to run. With replaces, the note is the new text of a kept note (to correct or complete it) or of one of your proposals still waiting.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: `The note: one fact, in a sentence of at most ${MAX_MEMORY_CHARS} characters, in the language of your instructions.` },
        replaces: { type: "string", description: "The memory_id of the kept note, or of your waiting proposal, this text takes the place of, if any." },
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

/** A schedule's run leaves where it stopped for the schedule's next run. */
export const HANDOFF_TOOL: AiTool = {
  name: "note_for_next_run",
  description:
    "Leaves a note for the next run of this schedule: where you stopped and what it should do first (what you checked, what remains, positions, counts, open questions). It takes the place of the note you were given, goes only to this schedule's next run, and needs no approval. Call it once, at the end, with everything the next run needs.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: `The note, at most ${MAX_HANDOFF_CHARS} characters, in the language of your instructions.` },
    },
    required: ["text"],
    additionalProperties: false,
  },
};

const step = (action: ChatMemoryRecord["action"], text: string): ChatMemoryRecord => ({ kind: "memory", action, text });

type RunRef = { id: string; agentId: string; prompt: string; source: AgentRunSource };
type ScheduleSource = Extract<AgentRunSource, { kind: "schedule" }>;

/** Runs of this schedule as this owner set it, on the same database: what they read and whose access holds them is the same. */
const sameSchedule = (source: ScheduleSource) =>
  and(
    sql`${agentRun.source}->>'kind' = 'schedule'`,
    sql`${agentRun.source}->>'scheduleId' = ${source.scheduleId}`,
    sql`${agentRun.source}->>'scheduledBy' = ${source.scheduledBy}`,
    sql`coalesce(${agentRun.source}->>'databaseId', '') = ${source.databaseId ?? ""}`,
  );

/**
 * The proposals still waiting that a run may see: its own, and on a schedule's run those of the
 * schedule's earlier runs (sameSchedule). Others may quote what this run's person can't open.
 */
async function runProposals(agent: { userId: string; workspaceId: string }, run: RunRef): Promise<Note[]> {
  const rows = await db
    .select({ note: aiMemory })
    .from(aiMemory)
    .innerJoin(agentRun, eq(agentRun.id, aiMemory.agentRunId))
    .where(
      and(
        eq(aiMemory.userId, agent.userId),
        eq(aiMemory.workspaceId, agent.workspaceId),
        eq(aiMemory.status, "proposed"),
        isScheduleRun(run.source) ? or(eq(agentRun.id, run.id), and(eq(agentRun.agentId, run.agentId), sameSchedule(run.source))) : eq(agentRun.id, run.id),
      ),
    )
    .orderBy(asc(aiMemory.createdAt), asc(aiMemory.id));
  return rows.map((r) => r.note);
}

/** The proposals a run sees (runProposals) as lines for its prompt, each with its memory_id for `replaces`. */
export async function proposalsForPrompt(agent: { userId: string; workspaceId: string }, run: RunRef): Promise<string> {
  const notes = await runProposals(agent, run);
  return notes.map((n) => `- (memory_id ${n.id}) ${n.text}${n.replacesId ? ` [new text for memory_id ${n.replacesId}]` : ""}`).join("\n");
}

/** What the latest earlier run of the same schedule, with the same task, left for the next one (`note_for_next_run`). */
export async function lastHandoff(run: RunRef): Promise<{ text: string; at: Date } | null> {
  if (!isScheduleRun(run.source)) return null;
  const [found] = await db
    .select({ text: agentRun.handoff, at: agentRun.createdAt })
    .from(agentRun)
    .where(and(eq(agentRun.agentId, run.agentId), ne(agentRun.id, run.id), isNotNull(agentRun.handoff), eq(agentRun.prompt, run.prompt), sameSchedule(run.source)))
    .orderBy(desc(agentRun.createdAt))
    .limit(1);
  return found?.text ? { text: found.text, at: found.at } : null;
}

/** Runs `note_for_next_run`: the run's note for the schedule's next run, in place of one it left before. */
export async function runHandoffTool(runId: string, call: { arguments: Record<string, unknown> }): Promise<{ content: string; isError?: boolean; step?: ChatMemoryRecord }> {
  const text = typeof call.arguments.text === "string" ? call.arguments.text.trim() : "";
  if (!text) return { content: "note_for_next_run needs the text of the note.", isError: true };
  if (text.length > MAX_HANDOFF_CHARS) return { content: `Too long: the note may have at most ${MAX_HANDOFF_CHARS} characters. Keep it shorter.`, isError: true };
  // It outlives the run: a credential the run came across must not.
  const clean = redactText(text);
  await db.update(agentRun).set({ handoff: clean }).where(eq(agentRun.id, runId));
  return { content: "Left for the next run of this schedule.", step: step("handoff", clean) };
}

type Proposed =
  | { kind: "notFound" | "perRun" | "full" }
  | { kind: "same" | "kept" | "waiting"; id: string }
  | { kind: "made"; note: Note }
  | { kind: "changed"; note: Note; from: string | null };

/** Runs `remember` (a proposal, maybe a new text for a note) or `forget` for a run of the agent, on the agent's own notes. */
export async function runAgentMemoryTool(
  agent: { userId: string; workspaceId: string },
  run: RunRef,
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
    await withdrawNotices([gone.agentRunId]);
    return { content: "Forgotten.", step: step("forget", gone.text) };
  }
  let text: string;
  try {
    // A note outlives the run: a credential the run came across must not.
    text = cleanNote(redactText(arg("text")));
  } catch (error) {
    if (!(error instanceof MemoryError)) throw error;
    if (error.code === "tooLong") return { content: `Too long: a note may have at most ${MAX_MEMORY_CHARS} characters. Keep it shorter.`, isError: true };
    return { content: "remember needs the text of the note.", isError: true };
  }
  if (!(await memoryAvailable(agent.workspaceId))) return { content: "The memory is turned off: propose nothing.", isError: true };
  const replaces = arg("replaces") || null;
  const seen = new Set((await runProposals(agent, run)).map((n) => n.id));
  const outcome = await db.transaction(async (tx): Promise<Proposed> => {
    await lockNotes(tx, agent.userId, agent.workspaceId);
    const notes = await tx
      .select()
      .from(aiMemory)
      .where(and(eq(aiMemory.userId, agent.userId), eq(aiMemory.workspaceId, agent.workspaceId)));
    const target = replaces ? notes.find((n) => n.id === replaces && (n.status === "kept" || seen.has(n.id))) : undefined;
    if (replaces && !target) return { kind: "notFound" };
    // The proposal this one takes the place of: the one named, or one the run sees that already changes the same kept note.
    const waiting = target?.status === "proposed" ? target : target ? notes.find((n) => n.status === "proposed" && n.replacesId === target.id && seen.has(n.id)) : undefined;
    const keptNote = target?.status === "kept" ? target : waiting?.replacesId ? notes.find((n) => n.id === waiting.replacesId && n.status === "kept") : undefined;
    if (keptNote && sameNote(keptNote.text, text)) return { kind: "same", id: keptNote.id };
    const known = notes.find((n) => n.id !== waiting?.id && n.id !== keptNote?.id && sameNote(n.text, text));
    if (known) return { kind: known.status === "kept" ? "kept" : "waiting", id: known.id };
    const ofRun = notes.filter((n) => n.status === "proposed" && n.agentRunId === run.id).length;
    if (ofRun >= MAX_PROPOSALS_PER_RUN && waiting?.agentRunId !== run.id) return { kind: "perRun" };
    if (waiting) {
      // Proposed again: the newer text waits, as this run's.
      const [changed] = await tx.update(aiMemory).set({ text, agentRunId: run.id, updatedAt: new Date() }).where(eq(aiMemory.id, waiting.id)).returning();
      return { kind: "changed", note: changed, from: waiting.agentRunId };
    }
    if (notes.filter((n) => n.status === "proposed").length >= MAX_AGENT_PROPOSALS) return { kind: "full" };
    const [made] = await tx
      .insert(aiMemory)
      .values({ userId: agent.userId, workspaceId: agent.workspaceId, text, status: "proposed", agentRunId: run.id, replacesId: keptNote?.id ?? null })
      .returning();
    return { kind: "made", note: made };
  });
  switch (outcome.kind) {
    case "notFound":
      return { content: "There is no note with that memory_id among your notes and the proposals you were shown.", isError: true };
    case "perRun":
      return { content: `You have proposed ${MAX_PROPOSALS_PER_RUN} notes in this run, the most one run may: propose no more.`, isError: true };
    case "full":
      return { content: `${MAX_AGENT_PROPOSALS} of your notes already wait for an owner: don't propose more now.`, isError: true };
    case "same":
      return { content: `The note memory_id ${outcome.id} already says this: nothing was proposed.` };
    case "kept":
      return { content: `Your memory already has this note (memory_id ${outcome.id}).` };
    case "waiting":
      return { content: `This note already waits for an owner (memory_id ${outcome.id}): don't propose it again.` };
  }
  if (outcome.kind === "changed" && outcome.from !== run.id) await withdrawNotices([outcome.from]);
  // The owners hear of it, unless they already have an item for the agent; the proposal stands
  // whether or not that reaches them.
  await noticeProposal(agent, run.id).catch((error: unknown) => console.error("[agents] could not tell owners of a proposed note", redactError(error)));
  const changes = outcome.note.replacesId ? ` as the new text of memory_id ${outcome.note.replacesId}` : "";
  return {
    content: `${outcome.kind === "changed" ? "Proposed again, in place of the proposal that waited" : "Proposed"}${changes} (memory_id ${outcome.note.id}). An owner of the workspace will read it and decide whether you keep it: it is not in your memory yet, and nothing in this run changes because of it.`,
    step: step("propose", outcome.note.text),
  };
}

/** How many proposals wait, per agent of the workspace the person can edit, for their list of agents. */
export async function proposedNoteCounts(userId: string, workspaceId: string): Promise<Record<string, number>> {
  const membership = await requireMembership(userId, workspaceId);
  const rows = await db
    .select({ agentId: workspaceAgent.id, count: count() })
    .from(aiMemory)
    .innerJoin(workspaceAgent, eq(workspaceAgent.userId, aiMemory.userId))
    .where(and(eq(aiMemory.workspaceId, workspaceId), eq(workspaceAgent.workspaceId, workspaceId), eq(aiMemory.status, "proposed")))
    .groupBy(workspaceAgent.id);
  const levels = await agentLevels(userId, workspaceId, rows.map((r) => r.agentId), membership.role);
  return Object.fromEntries(rows.filter((r) => hasAgentLevel(levels.get(r.agentId) ?? "none", "edit")).map((r) => [r.agentId, r.count]));
}

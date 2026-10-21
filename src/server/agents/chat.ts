/**
 * Chatting with an agent (see lib/agent-chat.ts): where a person stands with an agent's chat, their
 * conversations, and their messages, each queued as one of the agent's runs (source `chat`, done by
 * the agents' worker in run.ts, which writes the answer to the conversation, chat-store.ts). The
 * chat follows a run by asking for it again (`chatTurn`) until it ends: its steps as they come,
 * then its answer, or the call it waits on for the owner whose turn it is.
 *
 * Owners chat in the agent's dialog and in a page's block; anyone else in the workspace (not a
 * guest) only in a block of a page they can open that holds this very chat (`chatId`), read-only:
 * the run's access is the lower of the agent's and theirs (acting-for.ts), and it is offered
 * nothing that changes anything. Conversations are their person's: every query here is held to
 * `userId`, owners' included.
 */
import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentConversation, agentRun, connection, page, workspaceAgent } from "@/db/schema";
import {
  agentChatLine,
  MAX_AGENT_CHAT_MESSAGE,
  MAX_AGENT_CONVERSATIONS,
  type AgentChatError,
  type AgentChatInfo,
  type AgentChatMessageView,
  type AgentChatState,
  type AgentChatStepView,
  type AgentChatTurn,
  type AgentConversationSummary,
  type ChatPlace,
} from "@/lib/agent-chat";
import { callConnectionName, callToSend, type AgentStepRecord } from "@/lib/agents";
import { conversationTitle } from "@/lib/ai-chat";
import { AccessError, isGuest, pageVisibleTo, requireMembership, requirePageAccess, WorkspacePolicyError } from "@/server/access";
import { isAiError, takeRateLimit } from "@/server/ai";
import { viewStep } from "@/server/ai-chat";
import { aiAvailable } from "@/server/ai-writing";
import { kickAgents } from "./kick";
import { overMonthlyLimit } from "./usage";

/** Why a message wasn't taken, or a conversation not shown. */
export class AgentChatRefusal extends Error {
  constructor(
    readonly code: AgentChatError,
    message: string,
  ) {
    super(message);
  }
}

const refuse = (code: AgentChatError, message: string): never => {
  throw new AgentChatRefusal(code, message);
};

type Agent = typeof workspaceAgent.$inferSelect;
export type { ChatPlace };

/**
 * The person's membership (a policy holding back their session says so, as everywhere; not being
 * in the workspace looks like a missing thing) and the agent, when it is still one of the
 * workspace's (not archived).
 */
async function standing(userId: string, workspaceId: string, agentId: string) {
  const membership = await requireMembership(userId, workspaceId).catch((error) => {
    if (error instanceof AccessError && !(error instanceof WorkspacePolicyError)) refuse("noAccess", "Workspace not found");
    throw error;
  });
  const [agent] = await db
    .select()
    .from(workspaceAgent)
    .where(and(eq(workspaceAgent.id, agentId), eq(workspaceAgent.workspaceId, workspaceId)));
  return { role: membership.role, agent: agent && !agent.archivedAt ? agent : null };
}

/**
 * Where a person stands with the chat: guests never chat, nor does anyone with an agent that is
 * gone, paused, out of tokens for the month or in a workspace whose AI is off. In the dialog (no
 * place) only owners chat.
 */
export async function chatState(role: string, agent: Agent | null, workspaceId: string, place: ChatPlace): Promise<AgentChatState> {
  if (isGuest(role as "guest")) return "guest";
  if (!agent) return "gone";
  if (!place && role !== "owner") return "gone";
  if (!agent.enabled) return "paused";
  if (!(await aiAvailable(workspaceId))) return "aiOff";
  if (await overMonthlyLimit(agent)) return "limitReached";
  return role === "owner" ? "full" : "readOnly";
}

/**
 * Whether the page, which the person can open, holds this chat: someone who isn't an owner chats
 * with an agent only where an owner (or an editor) put it. Read from the page's Markdown, which
 * names each chat block's agent and chat id.
 */
async function pageHoldsChat(userId: string, workspaceId: string, agentId: string, place: NonNullable<ChatPlace>) {
  const found = await requirePageAccess(userId, place.pageId, "view").catch((error) => {
    if (error instanceof AccessError && !(error instanceof WorkspacePolicyError)) return null;
    throw error;
  });
  if (!found || found.workspaceId !== workspaceId || found.archivedAt) return false;
  const [held] = await db
    .select({ id: page.id })
    .from(page)
    .where(and(eq(page.id, place.pageId), sql`strpos(${page.contentMarkdown}, ${agentChatLine(agentId, place.chatId)}) > 0`));
  return Boolean(held);
}

/** The person's conversations with the agent in this place, newest first. */
async function conversationsOf(userId: string, agentId: string, chatId: string | null): Promise<AgentConversationSummary[]> {
  const rows = await db
    .select({ id: agentConversation.id, title: agentConversation.title, updatedAt: agentConversation.updatedAt })
    .from(agentConversation)
    .where(and(eq(agentConversation.userId, userId), eq(agentConversation.agentId, agentId), placeIs(chatId)))
    .orderBy(desc(agentConversation.updatedAt));
  return rows.map((r) => ({ id: r.id, title: r.title, updatedAt: r.updatedAt.toISOString() }));
}

const placeIs = (chatId: string | null) => (chatId ? eq(agentConversation.chatId, chatId) : sql`${agentConversation.chatId} is null`);

/** What the chat shows first: where the person stands, the agent (unless it is gone, or they are a guest) and their conversations. */
export async function agentChatInfo(userId: string, workspaceId: string, agentId: string, place: ChatPlace): Promise<AgentChatInfo> {
  const { role, agent } = await standing(userId, workspaceId, agentId);
  const state = await chatState(role, agent, workspaceId, place);
  if (state === "guest" || state === "gone" || !agent) return { state, agent: null, conversations: [] };
  return {
    state,
    agent: { id: agent.id, name: agent.name, icon: agent.icon, description: agent.description },
    conversations: await conversationsOf(userId, agent.id, place?.chatId ?? null),
  };
}

/** A conversation of the person's with this agent, in this place. */
async function ownConversation(userId: string, agentId: string, conversationId: string, chatId: string | null) {
  const [found] = await db
    .select()
    .from(agentConversation)
    .where(and(eq(agentConversation.id, conversationId), eq(agentConversation.userId, userId), eq(agentConversation.agentId, agentId), placeIs(chatId)));
  return found ?? refuse("noAccess", "Conversation not found");
}

/**
 * Sends a message: checks that the person may chat here (as agentChatInfo, and for anyone but an
 * owner that the page holds the chat), that the conversation is theirs and has no answer under way,
 * and their AI allowance; then queues the run with the message, in the conversation (a new one
 * without `conversationId`), and wakes the worker.
 */
export async function sendAgentChat(
  userId: string,
  input: { workspaceId: string; agentId: string; place: ChatPlace; conversationId: string | null; message: string },
): Promise<{ conversation: AgentConversationSummary; runId: string }> {
  const message = input.message.trim();
  if (!message) refuse("invalid", "Write a message");
  if (message.length > MAX_AGENT_CHAT_MESSAGE) refuse("tooLong", `A message has at most ${MAX_AGENT_CHAT_MESSAGE} characters`);
  const { role, agent } = await standing(userId, input.workspaceId, input.agentId);
  const state = await chatState(role, agent, input.workspaceId, input.place);
  if (state !== "full" && state !== "readOnly") return refuse(state, "This chat isn't available");
  if (state === "readOnly" && !(input.place && (await pageHoldsChat(userId, input.workspaceId, agent!.id, input.place)))) refuse("notOnPage", "This chat isn't on the page");
  const chatId = input.place?.chatId ?? null;
  const existing = input.conversationId ? await ownConversation(userId, agent!.id, input.conversationId, chatId) : null;
  const last = existing?.messages.at(-1);
  if (last?.role === "user") {
    // An answer under way: one at a time. A run that ended without writing its answer (it was
    // removed) doesn't hold the conversation up.
    const [run] = await db.select({ status: agentRun.status }).from(agentRun).where(eq(agentRun.id, last.runId));
    if (run && run.status !== "done" && run.status !== "failed") refuse("busy", "The agent is still answering");
  }
  try {
    takeRateLimit({ userId, workspaceId: input.workspaceId });
  } catch (error) {
    if (isAiError(error)) refuse("rateLimited", error.message);
    throw error;
  }
  const now = new Date();
  const { conversation, runId } = await db.transaction(async (tx) => {
    const conversation =
      existing ??
      (
        await tx
          .insert(agentConversation)
          .values({ agentId: agent!.id, workspaceId: input.workspaceId, userId, chatId, title: conversationTitle(message) })
          .returning()
      )[0];
    const [run] = await tx
      .insert(agentRun)
      .values({
        agentId: agent!.id,
        workspaceId: input.workspaceId,
        source: { kind: "chat", userId, conversationId: conversation.id },
        context: { actorId: userId },
        prompt: message,
      })
      .returning({ id: agentRun.id });
    const record = { role: "user" as const, content: message, runId: run.id, at: now.toISOString() };
    const [saved] = await tx
      .update(agentConversation)
      .set({ messages: sql`${agentConversation.messages} || ${JSON.stringify([record])}::jsonb`, updatedAt: now })
      .where(eq(agentConversation.id, conversation.id))
      .returning({ id: agentConversation.id, title: agentConversation.title, updatedAt: agentConversation.updatedAt });
    return { conversation: saved, runId: run.id };
  });
  kickAgents();
  await pruneConversations(userId, agent!.id, chatId);
  return { conversation: { id: conversation.id, title: conversation.title, updatedAt: conversation.updatedAt.toISOString() }, runId };
}

/** Keeps the person's MAX_AGENT_CONVERSATIONS most recent conversations in the place. */
async function pruneConversations(userId: string, agentId: string, chatId: string | null) {
  const keep = await db
    .select({ id: agentConversation.id })
    .from(agentConversation)
    .where(and(eq(agentConversation.userId, userId), eq(agentConversation.agentId, agentId), placeIs(chatId)))
    .orderBy(desc(agentConversation.updatedAt))
    .limit(MAX_AGENT_CONVERSATIONS);
  if (keep.length < MAX_AGENT_CONVERSATIONS) return;
  await db.delete(agentConversation).where(
    and(
      eq(agentConversation.userId, userId),
      eq(agentConversation.agentId, agentId),
      placeIs(chatId),
      notInArray(
        agentConversation.id,
        keep.map((k) => k.id),
      ),
    ),
  );
}

/**
 * Steps as the person may see them now: pages read and changed under the titles they may see (the
 * run read with their access, but access changes), and a skill they can't open unnamed.
 */
async function stepsFor(userId: string, steps: AgentStepRecord[]): Promise<AgentChatStepView[]> {
  const skillIds = [...new Set(steps.flatMap((s) => (s.kind === "skill" ? [s.pageId] : [])))];
  const open = new Set(
    skillIds.length ? (await db.select({ id: page.id }).from(page).where(and(inArray(page.id, skillIds), pageVisibleTo(userId)))).map((p) => p.id) : [],
  );
  return Promise.all(
    steps.map(async (s): Promise<AgentChatStepView> =>
      s.kind === "skill" ? (open.has(s.pageId) ? s : { ...s, title: "" }) : s.kind === "tool" || s.kind === "comment" || s.kind === "handoff" ? s : viewStep(userId, s),
    ),
  );
}

/** The names of the connections steps (and a waiting call) name. */
async function connectionNames(steps: AgentStepRecord[], also: string | null = null): Promise<Record<string, string>> {
  const ids = [...new Set([...steps.flatMap((s) => (s.kind === "tool" && s.connectionId ? [s.connectionId] : [])), ...(also ? [also] : [])])];
  if (!ids.length) return {};
  const rows = await db.select({ id: connection.id, name: connection.name }).from(connection).where(inArray(connection.id, ids));
  return Object.fromEntries(rows.map((r) => [r.id, r.name]));
}

/** One of the person's conversations with the agent in this place, and the run still answering in it, if any. */
export async function getAgentConversation(userId: string, workspaceId: string, agentId: string, conversationId: string, place: ChatPlace) {
  await standing(userId, workspaceId, agentId);
  const found = await ownConversation(userId, agentId, conversationId, place?.chatId ?? null);
  const messages: AgentChatMessageView[] = await Promise.all(
    found.messages.map(async (m) => ({ role: m.role, content: m.content, runId: m.runId, code: m.code ?? null, steps: await stepsFor(userId, m.steps ?? []), at: m.at })),
  );
  const last = found.messages.at(-1);
  const connections = await connectionNames(found.messages.flatMap((m) => m.steps ?? []));
  return { id: found.id, title: found.title, messages, running: last?.role === "user" ? last.runId : null, connections };
}

/** Deletes one of the person's conversations with the agent in this place. */
export async function deleteAgentConversation(userId: string, workspaceId: string, agentId: string, conversationId: string, place: ChatPlace) {
  await standing(userId, workspaceId, agentId);
  await db
    .delete(agentConversation)
    .where(
      and(
        eq(agentConversation.id, conversationId),
        eq(agentConversation.userId, userId),
        eq(agentConversation.agentId, agentId),
        placeIs(place?.chatId ?? null),
      ),
    );
}

/**
 * A run answering the person's message, as their chat follows it. Only theirs: another's chat
 * run, or one that isn't a chat's, looks missing. The call it waits on is shown exactly as it will
 * be sent: only an owner's turn has one, and they answer it.
 */
export async function chatTurn(userId: string, workspaceId: string, runId: string): Promise<AgentChatTurn> {
  await requireMembership(userId, workspaceId);
  const [run] = await db
    .select()
    .from(agentRun)
    .where(and(eq(agentRun.id, runId), eq(agentRun.workspaceId, workspaceId), sql`${agentRun.source}->>'kind' = 'chat'`, sql`${agentRun.source}->>'userId' = ${userId}`));
  if (!run) return refuse("noAccess", "Not found");
  const pendingCall = run.status === "awaiting_approval" ? run.pending : null;
  const connections = await connectionNames(run.steps, pendingCall?.connectionId ?? null);
  return {
    runId: run.id,
    status: run.status,
    code: run.code ?? null,
    answer: run.status === "done" ? run.answer : "",
    steps: await stepsFor(userId, run.steps),
    pending: pendingCall
      ? {
          callId: pendingCall.callId,
          tool: pendingCall.tool,
          connectionName: callConnectionName(pendingCall.connectionId, new Map(Object.entries(connections))),
          input: JSON.stringify(callToSend(pendingCall, run.state?.queue) ?? pendingCall.arguments, null, 2),
        }
      : null,
    connections,
  };
}

/** The workspace's agents a block may show, for anyone but a guest choosing one: names, nothing of their settings. */
export async function chatAgents(userId: string, workspaceId: string) {
  const { role } = await standing(userId, workspaceId, "");
  if (isGuest(role)) return [];
  const rows = await db
    .select({ id: workspaceAgent.id, name: workspaceAgent.name, icon: workspaceAgent.icon, description: workspaceAgent.description, enabled: workspaceAgent.enabled })
    .from(workspaceAgent)
    .where(and(eq(workspaceAgent.workspaceId, workspaceId), sql`${workspaceAgent.archivedAt} is null`))
    .orderBy(workspaceAgent.name);
  return rows;
}

/** The names of these agents of the workspace (archived ones too), for exported Markdown. */
export async function agentNames(workspaceIds: string[], agentIds: string[]): Promise<Map<string, string>> {
  if (!agentIds.length || !workspaceIds.length) return new Map();
  const rows = await db
    .select({ id: workspaceAgent.id, name: workspaceAgent.name })
    .from(workspaceAgent)
    .where(and(inArray(workspaceAgent.id, agentIds), inArray(workspaceAgent.workspaceId, workspaceIds)));
  return new Map(rows.map((r) => [r.id, r.name]));
}

"use server";

import { getTranslations } from "next-intl/server";
import type { ActionResult } from "@/app/actions/workspaces";
import { MAX_AGENT_CHAT_MESSAGE } from "@/lib/agent-chat";
import { AccessError } from "@/server/access";
import {
  AgentChatRefusal,
  agentChatInfo,
  agentThread,
  chatAgents,
  chatTurn,
  deleteAgentConversation,
  getAgentConversation,
  sendAgentChat,
  threadRuns,
  type ChatPlace,
} from "@/server/agents/chat";
import { requireUserId } from "@/server/session";

// Chatting with an agent (server/agents/chat.ts), in its dialog and in a page's block. Refusals
// come back translated, with their code for the chat to react to.

async function run<T>(fn: (userId: string) => Promise<T>): Promise<ActionResult<T>> {
  const userId = await requireUserId();
  try {
    return { ok: true, data: await fn(userId) };
  } catch (error) {
    const t = await getTranslations("page.agentChat.errors");
    if (error instanceof AgentChatRefusal) return { ok: false, error: t(error.code, { max: MAX_AGENT_CHAT_MESSAGE }), code: error.code };
    if (error instanceof AccessError) return { ok: false, error: t("noAccess"), code: "noAccess" };
    console.error("[agent chat action]", error);
    const tc = await getTranslations("common");
    return { ok: false, error: tc("genericError") };
  }
}

/** Only the two strings a place is made of, whatever the browser sent. */
const placeOf = (place: ChatPlace): ChatPlace =>
  place && typeof place.chatId === "string" && place.chatId && typeof place.pageId === "string" && place.pageId
    ? { chatId: place.chatId.slice(0, 100), pageId: place.pageId.slice(0, 100) }
    : null;

export async function agentChatInfoAction(workspaceId: string, agentId: string, place: ChatPlace) {
  return run((userId) => agentChatInfo(userId, workspaceId, agentId, placeOf(place)));
}

export async function sendAgentChatAction(input: { workspaceId: string; agentId: string; place: ChatPlace; conversationId: string | null; message: string }) {
  return run((userId) =>
    sendAgentChat(userId, {
      workspaceId: String(input.workspaceId),
      agentId: String(input.agentId),
      place: placeOf(input.place),
      conversationId: typeof input.conversationId === "string" ? input.conversationId : null,
      message: String(input.message ?? ""),
    }),
  );
}

export async function agentChatTurnAction(workspaceId: string, runId: string) {
  return run((userId) => chatTurn(userId, workspaceId, runId));
}

export async function getAgentConversationAction(workspaceId: string, agentId: string, conversationId: string, place: ChatPlace) {
  return run((userId) => getAgentConversation(userId, workspaceId, agentId, conversationId, placeOf(place)));
}

/** The agent's own chat with the person (its page and dialog): their messages there, and their runs among them. */
export async function agentThreadAction(workspaceId: string, agentId: string) {
  return run((userId) => agentThread(userId, String(workspaceId), String(agentId)));
}

/** The runs of the agent's own chat again, as they go on and new ones start. */
export async function agentThreadRunsAction(workspaceId: string, agentId: string) {
  return run((userId) => threadRuns(userId, String(workspaceId), String(agentId)));
}

export async function deleteAgentConversationAction(workspaceId: string, agentId: string, conversationId: string, place: ChatPlace) {
  return run((userId) => deleteAgentConversation(userId, workspaceId, agentId, conversationId, placeOf(place)));
}

/** The workspace's agents a page's chat block may show (for its picker). */
export async function chatAgentsAction(workspaceId: string) {
  return run((userId) => chatAgents(userId, workspaceId));
}

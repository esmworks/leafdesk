"use server";

import { cookies } from "next/headers";
import { getTranslations } from "next-intl/server";
import { TIME_ZONE_COOKIE } from "@/i18n/config";
import type { ActionResult } from "@/app/actions/workspaces";
import { MAX_AGENT_CHAT_MESSAGE } from "@/lib/agent-chat";
import { AGENT_CHAT_FILE_LIMITS } from "@/lib/agent-chat-files";
import { MAX_QUEUED } from "@/lib/agent-chat-queue";
import { AccessError } from "@/server/access";
import {
  AgentChatRefusal,
  agentChatInfo,
  agentThread,
  chatAgents,
  chatTurn,
  deleteAgentConversation,
  getAgentConversation,
  redoAgentChat,
  removeQueuedAgentChat,
  searchAgentChats,
  sendAgentChat,
  summarizeAgentConversation,
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
    if (error instanceof AgentChatRefusal) {
      const max = error.code === "queueFull" ? MAX_QUEUED : error.code === "badFile" ? AGENT_CHAT_FILE_LIMITS.perMessage : MAX_AGENT_CHAT_MESSAGE;
      return { ok: false, error: t(error.code, { max }), code: error.code };
    }
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

/** Only names and texts of the files a message carries, whatever the browser sent (sendAgentChat checks them). */
const filesOf = (files: unknown): { name: string; text: string }[] =>
  Array.isArray(files)
    ? files
        .slice(0, AGENT_CHAT_FILE_LIMITS.perMessage + 1)
        .filter((f): f is { name: string; text: string } => Boolean(f) && typeof f.name === "string" && typeof f.text === "string")
        .map((f) => ({ name: f.name, text: f.text }))
    : [];

export async function sendAgentChatAction(input: {
  workspaceId: string;
  agentId: string;
  place: ChatPlace;
  conversationId: string | null;
  message: string;
  files?: { name: string; text: string }[];
}) {
  return run(async (userId) =>
    sendAgentChat(userId, {
      workspaceId: String(input.workspaceId),
      agentId: String(input.agentId),
      place: placeOf(input.place),
      conversationId: typeof input.conversationId === "string" ? input.conversationId : null,
      message: String(input.message ?? ""),
      files: filesOf(input.files),
      // The times the agent sets (reminders) read on the writer's clock.
      timeZone: (await cookies()).get(TIME_ZONE_COOKIE)?.value,
    }),
  );
}

/** Takes a message out of the queue before it goes. */
export async function removeQueuedAgentChatAction(workspaceId: string, agentId: string, conversationId: string, queuedId: string, place: ChatPlace) {
  return run((userId) =>
    removeQueuedAgentChat(userId, { workspaceId: String(workspaceId), agentId: String(agentId), place: placeOf(place), conversationId: String(conversationId), queuedId: String(queuedId) }),
  );
}

/** Starts a new conversation from a summary of this one. */
export async function summarizeAgentConversationAction(workspaceId: string, agentId: string, conversationId: string, place: ChatPlace) {
  return run((userId) => summarizeAgentConversation(userId, { workspaceId: String(workspaceId), agentId: String(agentId), place: placeOf(place), conversationId: String(conversationId) }));
}

/** Does the last turn again: Regenerate (no message) or Edit (its last question changed to `message`). */
export async function redoAgentChatAction(workspaceId: string, agentId: string, conversationId: string, message: string | null, place: ChatPlace) {
  return run(async (userId) =>
    redoAgentChat(userId, {
      workspaceId: String(workspaceId),
      agentId: String(agentId),
      place: placeOf(place),
      conversationId: String(conversationId),
      message: typeof message === "string" ? message : null,
      timeZone: (await cookies()).get(TIME_ZONE_COOKIE)?.value,
    }),
  );
}

/** Searches the person's own conversations with the agent, in every place. */
export async function searchAgentChatsAction(workspaceId: string, agentId: string, query: string) {
  return run((userId) => searchAgentChats(userId, String(workspaceId), String(agentId), String(query ?? "")));
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

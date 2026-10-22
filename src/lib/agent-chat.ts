// Client-safe: shared by the agent chat's server side (src/server/agents/chat.ts), the agent
// dialog's Chat tab, the page block (components/page/agent-chat-block.tsx) and the Markdown and
// editor schemas.

import type { AgentCommentRecord, AgentHandoffRecord, AgentRunCode, AgentRunStatus, AgentSkillRecord, AgentStepRecord, AgentToolRecord } from "./agents";
import type { ChatStepView } from "./ai-chat";

/**
 * Chatting with an agent: a person writes to one of the workspace's agents and it answers, each
 * answer one of its runs (source `chat`, in its history, counted in its usage and limits). Anyone
 * the agent is shared with (lib/agent-sharing) chats in its dialog (its Chat tab) or in a page's
 * "Agent chat" block. For those who can edit the agent the run does what a run they ask for may,
 * held to their access as well; for those who can only view and interact with it, it is
 * read-only: the agent reads only pages both it and that person can open, changes nothing and
 * calls no connection tool that changes something.
 *
 * Each person has their own conversations, per block (`chatId`) or in the dialog (no chat id); no
 * one else sees them, owners included (a member's runs show in the history without what was said).
 */

/** The page block. */
export const AGENT_CHAT_BLOCK = "agentChat";

export const agentChatBlockConfig = {
  type: AGENT_CHAT_BLOCK,
  // `chatId` names the block's conversations; it is set when the block is made and stays with it
  // through copies, moves and Markdown rewrites (a block id may not).
  propSchema: { agentId: { default: "" }, chatId: { default: "" } },
  content: "none",
} as const;

/** A new block's chat id. */
export const newChatId = () => crypto.randomUUID();

/** The chat's place: a page's block (its chat id, and the page it is on), or the agent's dialog (null). */
export type ChatPlace = { chatId: string; pageId: string } | null;

/** Conversations kept per person and place (a block, or the dialog); the oldest go first. */
export const MAX_AGENT_CONVERSATIONS = 20;
/** The longest message; longer tasks belong in the agent's instructions or a skill. */
export const MAX_AGENT_CHAT_MESSAGE = 4_000;
/** Earlier messages of the conversation that go with each new one, at most. */
export const AGENT_CHAT_HISTORY = 20;

/**
 * In Markdown (stored for search and history, read and written by MCP) the block is one line
 * naming the agent and its conversations; exported Markdown shows the agent's name instead.
 *
 *   <!-- leafdesk:agent-chat 5b1e… 9c40… -->
 */
const AGENT_CHAT_LINE = /^ {0,3}<!--\s*leafdesk:agent-chat\s+([\w-]{1,64})(?:\s+([\w-]{1,64}))?\s*-->\s*$/;

export const agentChatLine = (agentId: string, chatId: string) => `<!-- leafdesk:agent-chat ${agentId}${chatId ? ` ${chatId}` : ""} -->`;

export function parseAgentChatLine(line: string): { agentId: string; chatId: string } | null {
  const match = AGENT_CHAT_LINE.exec(line);
  return match ? { agentId: match[1], chatId: match[2] ?? "" } : null;
}

/** Replaces each agent chat line of a Markdown body, outside code fences. */
export function mapAgentChatLines(markdown: string, fn: (found: { agentId: string; chatId: string }) => string): string {
  let fence: string | null = null;
  return markdown
    .split("\n")
    .map((line) => {
      const opens = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (fence) {
        if (opens && opens[1][0] === fence[0] && opens[1].length >= fence.length && !line.trim().slice(opens[1].length).trim()) fence = null;
        return line;
      }
      if (opens) {
        fence = opens[1];
        return line;
      }
      const found = parseAgentChatLine(line);
      return found ? fn(found) : line;
    })
    .join("\n");
}

/** An agent's address in the app (its dialog in Settings), which pasted in a page makes a chat with it. */
export const agentPath = (workspaceId: string, agentId: string) => `/w/${workspaceId}/settings?tab=agents&agent=${agentId}`;

/** The agent an app link names (`agentPath`, any tab), when it is one of this origin's. */
export function agentLinkRef(text: string, origin: string): { workspaceId: string; agentId: string } | null {
  let url: URL;
  try {
    url = new URL(text.trim(), origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  const match = /^\/w\/([\w-]{1,100})\/settings\/?$/.exec(url.pathname);
  const agentId = url.searchParams.get("agent");
  if (!match || url.searchParams.get("tab") !== "agents" || !agentId || !/^[\w-]{1,64}$/.test(agentId)) return null;
  return { workspaceId: match[1], agentId };
}

/** A message of a conversation as it is kept: the person's, or the agent's answer (its run's). */
export type AgentChatMessageRecord = {
  role: "user" | "assistant";
  content: string;
  /** The run that answers (on the question) or answered (on the answer). */
  runId: string;
  /** Why the run ended without an answer. */
  code?: AgentRunCode | null;
  steps?: AgentStepRecord[];
  at: string;
};

/** A step of an answer as the reader may see it now (as an agent's run history shows it). */
export type AgentChatStepView = ChatStepView | AgentToolRecord | AgentSkillRecord | AgentHandoffRecord | (Omit<AgentCommentRecord, "text"> & { text: string | null });

/** A message as the chat shows it. */
export type AgentChatMessageView = {
  role: "user" | "assistant";
  content: string;
  runId: string;
  code: AgentRunCode | null;
  steps: AgentChatStepView[];
  at: string;
};

export type AgentConversationSummary = { id: string; title: string; updatedAt: string };

/**
 * A turn under way, as the chat follows it: the run's status, its steps so far, its answer once
 * done (or why it failed), and, for the owner whose turn it is, the call it waits on.
 */
export type AgentChatTurn = {
  runId: string;
  status: AgentRunStatus;
  code: AgentRunCode | null;
  answer: string;
  steps: AgentChatStepView[];
  pending: { callId: string; tool: string; connectionName: string; input: string } | null;
  connections: Record<string, string>;
};

/**
 * Where a person stands with an agent's chat: they may chat (`full` when they can edit the agent,
 * see lib/agent-sharing, else read-only), or not: a guest, the agent is gone (archived, or not of
 * the workspace), not shared with them, paused, the workspace's AI is off, or the agent used its
 * tokens for the month.
 */
export type AgentChatState = "full" | "readOnly" | "guest" | "gone" | "noAccess" | "paused" | "aiOff" | "limitReached";

export type AgentChatInfo = {
  state: AgentChatState;
  /** Null when the agent is gone. */
  agent: { id: string; name: string; icon: string | null; description: string } | null;
  conversations: AgentConversationSummary[];
};

/** Why a message wasn't taken (beyond the chat's states above). */
export const AGENT_CHAT_ERRORS = ["invalid", "tooLong", "busy", "rateLimited", "noAccess", "notOnPage"] as const;
export type AgentChatError = (typeof AGENT_CHAT_ERRORS)[number] | Exclude<AgentChatState, "full" | "readOnly">;

/** Why a chat's run ended without an answer, as the chat says it (others say "error"). */
export const AGENT_CHAT_FAILURES = ["aiOff", "agentDisabled", "noAccess", "provider", "timeout", "tooManyAttempts", "approvalTimeout", "limitReached", "costLimit", "error"] as const;
export const chatFailure = (code: AgentRunCode | null): (typeof AGENT_CHAT_FAILURES)[number] =>
  (AGENT_CHAT_FAILURES as readonly (AgentRunCode | null)[]).includes(code) ? (code as (typeof AGENT_CHAT_FAILURES)[number]) : "error";

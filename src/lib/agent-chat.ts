// Client-safe: shared by the agent chat's server side (src/server/agents/chat.ts), the agent
// dialog's Chat tab, the page block (components/page/agent-chat-block.tsx) and the Markdown and
// editor schemas.

import type { AgentCommentRecord, AgentEmailRecord, AgentHandoffRecord, AgentRunCode, AgentRunStatus, AgentSkillRecord, AgentStepRecord, AgentToolRecord } from "./agents";
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
 * Without a chat id (the agent's page and dialog) they read as one chat that goes on, with the
 * person's other runs of the agent among the messages (`AgentChatThread`).
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

/** A text file the person attached to a message, as the message keeps it (its text went to the run only). */
export type AgentChatFileRef = { name: string; size: number };
/** A text file as it is sent: its name, size in bytes and text (lib/agent-chat-files.ts). */
export type AgentChatFileIn = AgentChatFileRef & { text: string };
/** A file the agent attached to its answer (`attach_file`, a `conversation_file` row), which only the person opens. */
export type AgentChatAnswerFile = { id: string; name: string; size: number; contentType: string };

/**
 * A message of a conversation as it is kept: the person's, or the agent's answer (its run's).
 * Messages that waited in the queue are kept one by one, all with the run that answered them.
 * A conversation started from another's summary begins with it (`summary`, no run).
 */
export type AgentChatMessageRecord = {
  role: "user" | "assistant";
  content: string;
  /** The run that answers (on the question) or answered (on the answer); "" for a summary. */
  runId: string;
  /** Why the run ended without an answer. */
  code?: AgentRunCode | null;
  steps?: AgentStepRecord[];
  /** The person's files on a question. */
  files?: AgentChatFileRef[];
  /** The agent's files on an answer. */
  attached?: AgentChatAnswerFile[];
  /** The summary of an earlier conversation this one started from. */
  summary?: true;
  /** A summary drawn from turns that read files on the person's computer (lib/local-reads.ts). */
  localRead?: true;
  at: string;
};

/** The messages of a conversation with an agent (`conversation.messages` where `agent_id` is set). */
export const agentMessages = (messages: readonly object[]) => messages as AgentChatMessageRecord[];

/**
 * A message written while the conversation's answer was under way: it waits (at most
 * MAX_QUEUED, lib/agent-chat-queue.ts) and goes with the others as the next turn once the answer
 * ends. `fromApp`: sent from a connected app; `via`: the app, when the Telegram bot follows it;
 * `sessionId`: the web session it was sent from in the app (lib/agents.ts AgentRunSource).
 */
export type AgentChatQueuedRecord = {
  id: string;
  content: string;
  at: string;
  fromApp?: true;
  via?: "telegram";
  sessionId?: string;
  files?: AgentChatFileIn[];
  timeZone?: string;
};

/** A message waiting in the queue, as the chat shows it. */
export type AgentChatQueuedView = { id: string; content: string; at: string; files: AgentChatFileRef[] };

/** A step of an answer as the reader may see it now (as an agent's run history shows it). */
export type AgentChatStepView =
  | ChatStepView
  | AgentToolRecord
  | AgentSkillRecord
  | AgentHandoffRecord
  | AgentEmailRecord
  | (Omit<AgentCommentRecord, "text"> & { text: string | null });

/** A message as the chat shows it. */
export type AgentChatMessageView = {
  role: "user" | "assistant";
  content: string;
  runId: string;
  code: AgentRunCode | null;
  steps: AgentChatStepView[];
  files?: AgentChatFileRef[];
  attached?: AgentChatAnswerFile[];
  summary?: boolean;
  /** A summary drawn from turns that read files on the person's computer (AgentChatMessageRecord). */
  localRead?: true;
  at: string;
};

export type AgentConversationSummary = { id: string; title: string; updatedAt: string };

/** Messages the agent's own chat (no chat id) shows at most, its newest. */
export const MAX_THREAD_MESSAGES = 200;
/** The person's own runs (other than the chat's) the agent's own chat shows among its messages, its latest. */
export const THREAD_RUNS = 30;

/**
 * One of the agent's runs that the person started other than by chatting (a schedule they set, a
 * task they asked for, a comment of theirs that mentioned it): in the agent's own chat it reads
 * as the agent speaking up on its own, at the time it started. `label` names where it worked (the
 * database, the page, the row) where the person can open it; `task` and `answer` are empty where
 * they can't see what the run read; `pending` is the call it waits on, for an owner who answers it.
 */
export type AgentChatRunView = {
  id: string;
  kind: "schedule" | "request" | "mention" | "mail";
  status: AgentRunStatus;
  code: AgentRunCode | null;
  label: string | null;
  task: string;
  /** What it said at the end; for a schedule's run ended with finish_run, the reason it gave. */
  answer: string;
  /** A schedule's run that found nothing new: one muted line, its steps folded under it. */
  quiet: boolean;
  steps: AgentChatStepView[];
  pending: AgentChatTurn["pending"];
  at: string;
  /** How long it took, from when it was queued to when it ended; null while it goes on. */
  ms: number | null;
};

/**
 * The agent's own chat with the person (its page and its dialog): all their conversations there
 * as one, the run still answering in it, the conversation a new message joins (the latest), and
 * their own runs to show among the messages.
 */
export type AgentChatThread = {
  conversationId: string | null;
  messages: AgentChatMessageView[];
  running: string | null;
  /** The latest conversation's messages waiting for its answer to end. */
  queued: AgentChatQueuedView[];
  runs: AgentChatRunView[];
  connections: Record<string, string>;
};

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
  /** When a call held for the agent's quiet hours goes on (ISO), for whoever follows the turn; null when none is. */
  deferredUntil: string | null;
  connections: Record<string, string>;
  /** The files the agent attached to its answer so far. */
  attached: AgentChatAnswerFile[];
  /** The conversation's messages waiting for this answer to end. */
  queued: AgentChatQueuedView[];
  /** Once it ended: the run that took the queued messages as the next turn, if any. */
  next: string | null;
};

/** A message of the person's conversations with an agent that a search found (server/agents/chat.ts searchAgentChats). */
export type AgentChatSearchHit = {
  conversationId: string;
  title: string;
  /** The block's chat id; null: the agent's own chat. */
  chatId: string | null;
  /** A page the person can open that holds the block's chat; null for the agent's own chat, or when there is none. */
  pageId: string | null;
  role: "user" | "assistant";
  runId: string;
  at: string;
  snippet: { before: string; match: string; after: string };
};

/**
 * A change to what a turn under way has written so far, as `/api/agents/chat/live` sends it
 * (server/agents/live-text.ts): keep the first `at` letters, then add `add`.
 */
export type LiveTextEdit = { at: number; add: string };

export const applyLiveEdit = (text: string, edit: LiveTextEdit) => text.slice(0, edit.at) + edit.add;

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
  /** The labels of the folders on the person's computer its runs in the app may use now (their desktop app is connected); null when none. */
  computer: string[] | null;
};

/**
 * Why a message wasn't taken (beyond the chat's states above): `queueFull`, MAX_QUEUED messages
 * wait already; `badFile`, a file that isn't one the chat takes; `busy`, a summary or a turn done
 * again while an answer is under way or messages wait; `nothingToRedo`, no answer to do again;
 * `summaryFailed`, the model couldn't write the summary.
 */
export const AGENT_CHAT_ERRORS = ["invalid", "tooLong", "busy", "queueFull", "badFile", "nothingToRedo", "summaryFailed", "rateLimited", "noAccess", "notOnPage"] as const;
export type AgentChatError = (typeof AGENT_CHAT_ERRORS)[number] | Exclude<AgentChatState, "full" | "readOnly">;

/** Why a chat's run ended without an answer, as the chat says it (others say "error"). */
export const AGENT_CHAT_FAILURES = ["aiOff", "agentDisabled", "noAccess", "provider", "timeout", "tooManyAttempts", "approvalTimeout", "limitReached", "costLimit", "selfReported", "stopped", "error"] as const;
export const chatFailure = (code: AgentRunCode | null): (typeof AGENT_CHAT_FAILURES)[number] =>
  (AGENT_CHAT_FAILURES as readonly (AgentRunCode | null)[]).includes(code) ? (code as (typeof AGENT_CHAT_FAILURES)[number]) : "error";

// Client-safe and small: the Agent block's config, its Markdown line and the place its
// conversations are kept in, shared by the editor's schema (components/page/agent-block.tsx), the
// server's (server/blocknote.ts), Markdown (lib/content-markdown.ts), the chat's checks
// (server/agents/chat.ts) and the export (server/export.ts). The chat itself is lib/agent-chat.ts.

import type { ChatPlace } from "./agent-chat";

/**
 * The Agent block: one of the workspace's agents inside a page, a short box to ask it something and
 * the latest answer, for each reader their own. It holds only the agent: asking is a message in a
 * conversation of the reader's with that agent (lib/agent-chat.ts), kept for the page and the
 * agent together (`pageAgentChatId`), so the block on a page, a second block of the same agent
 * there and the full chat the block opens all show the same conversation. Who may ask is the
 * agent's own sharing rule (server/agents/chat.ts `chatState`).
 */
export const AGENT_BLOCK = "agent";

export const agentBlockConfig = {
  type: AGENT_BLOCK,
  propSchema: { agentId: { default: "" } },
  content: "none",
} as const;

/** The chat id of the conversations a page's Agent blocks keep (`conversation.chat_id`), one per person, page and agent. */
export const pageAgentChatId = (pageId: string) => `pageAgent:${pageId}`;

/** The page whose Agent blocks keep conversations under this chat id, or null for any other chat id (or one that is not an id). */
export const pageOfAgentChat = (chatId: string): string | null => /^pageAgent:([\w-]{1,90})$/.exec(chatId)?.[1] ?? null;

/** The place of a page's Agent blocks' conversations. */
export const pageAgentPlace = (pageId: string): NonNullable<ChatPlace> => ({ chatId: pageAgentChatId(pageId), pageId });

/** Whether a place is a page's Agent blocks' (and not a chat block's). */
export const isPageAgentPlace = (place: NonNullable<ChatPlace>) => place.chatId === pageAgentChatId(place.pageId);

/**
 * In Markdown (stored for search and history, read and written by MCP, the AI chat and agents) the
 * block is one line naming its agent; exported Markdown shows the agent's name instead.
 *
 *   <!-- leafdesk:agent 5b1e… -->
 */
const AGENT_LINE = /^ {0,3}<!--\s*leafdesk:agent\s+([\w-]{1,64})\s*-->\s*$/;

export const agentBlockLine = (agentId: string) => `<!-- leafdesk:agent ${agentId} -->`;

/** The agent id a Markdown line names, or null for another line. */
export function parseAgentBlockLine(line: string): string | null {
  const match = AGENT_LINE.exec(line);
  return match ? match[1] : null;
}

/** Replaces each Agent block line of a Markdown body, outside code fences. */
export function mapAgentBlockLines(markdown: string, fn: (agentId: string) => string): string {
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
      const found = parseAgentBlockLine(line);
      return found === null ? line : fn(found);
    })
    .join("\n");
}

/**
 * What a run asked from an Agent block is told about where it was asked (server/agents/run.ts):
 * the page's id, which it reads through its tools with the access it has, and that the answer
 * shows in a small box.
 */
export const pageAgentNote = (pageId: string) =>
  `They wrote from a box in the page ${pageId}, where your answer shows in a small card: keep it short, in plain Markdown. The page is the one they are looking at: read it with your tools (read_page) when the question is about it, and don't otherwise.`;

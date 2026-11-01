// Client-safe: searching a person's chats with an agent (server/agents/chat.ts searchAgentChats),
// from the box the agent chat opens (components/agent-chat/chat-search.tsx).

/** The shortest and longest search, and the most messages one finds. */
export const AGENT_CHAT_SEARCH = { minChars: 2, maxChars: 100, hits: 30 };

/** Letters a snippet shows on each side of what it found, about. */
const SIDE = 60;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Where `query` is in `text` (ignoring case), with some of the text on each side, cut at a space
 * where one is near and marked with "…" where it was cut; the text's start when it isn't there.
 * Whitespace runs read as one space.
 */
export function searchSnippet(text: string, query: string, side = SIDE): { before: string; match: string; after: string } {
  const flat = text.replace(/\s+/g, " ").trim();
  const found = query.trim() ? new RegExp(escape(query.trim().replace(/\s+/g, " ")), "iu").exec(flat) : null;
  if (!found) return { before: "", match: "", after: cutAfter(flat, side * 2) };
  const start = found.index;
  const end = start + found[0].length;
  return { before: cutBefore(flat.slice(0, start), side), match: found[0], after: cutAfter(flat.slice(end), side) };
}

function cutBefore(text: string, side: number) {
  if (text.length <= side) return text;
  const part = text.slice(-side);
  const space = part.indexOf(" ");
  return `…${space >= 0 && space < side / 3 ? part.slice(space + 1) : part}`;
}

function cutAfter(text: string, side: number) {
  if (text.length <= side) return text;
  const part = text.slice(0, side);
  const space = part.lastIndexOf(" ");
  return `${space > (side * 2) / 3 ? part.slice(0, space) : part}…`;
}

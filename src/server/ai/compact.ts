// Making room when a conversation with the model outgrows its context window (the provider, or our
// estimate in stream, answers "tooLarge"): the chat and agents drop old tool results first, which
// the model can fetch again, and ask once more.

import type { AiMessage } from "./index";

/** The newest tool results are what the model is working on: they're kept. */
export const KEEP_RECENT_TOOL_RESULTS = 5;

/** Shorter results are kept: a placeholder would save next to nothing. */
const MIN_DROPPABLE_CHARS = 400;

const dropped = (name: string) => `(This result of ${name} was dropped to make room. Call the tool again if you still need it.)`;

/**
 * Replaces the content of all but the newest `keep` tool results with a note saying which tool's
 * result was dropped, so the model can call it again. Failed calls are kept: what went wrong may
 * matter for the next step. Changes `messages` in place and returns the characters saved.
 */
export function dropOldToolResults(messages: AiMessage[], keep = KEEP_RECENT_TOOL_RESULTS): number {
  const results = messages.flatMap((m, i) => (m.role === "tool" ? [i] : []));
  let saved = 0;
  for (const i of results.slice(0, Math.max(0, results.length - keep))) {
    const m = messages[i];
    if (m.role !== "tool" || m.isError || m.content.length < MIN_DROPPABLE_CHARS) continue;
    const content = dropped(m.name);
    saved += m.content.length - content.length;
    messages[i] = { ...m, content };
  }
  return saved;
}

/** Room under which a tool call first makes some by dropping older results. */
export const READ_ROOM = 10_000;

/**
 * The room a tool call's result may take (`left`, worked out from `messages`): with less than
 * READ_ROOM, every tool result but the newest is dropped first, so a long read goes on part after
 * part instead of running out of room.
 */
export function roomToRead(messages: AiMessage[], left: () => number): number {
  if (left() < READ_ROOM) dropOldToolResults(messages, 1);
  return left();
}

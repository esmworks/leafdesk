// Client-safe: messages written to an agent while it answers (lib/agent-chat.ts). They wait with
// the conversation (`agent_conversation.queue`), at most MAX_QUEUED, and when the answer ends
// (however it ends, server/agents/chat-store.ts closeChatTurn) they go together as the next turn:
// one run whose prompt is each of them in order, kept in the conversation one by one.

import { uniqueAttachmentName } from "./chat-attachments";
import type { AgentChatFileIn, AgentChatMessageRecord, AgentChatQueuedRecord, AgentChatQueuedView } from "./agent-chat";

/** Messages that may wait for an answer, at most. */
export const MAX_QUEUED = 5;

/** A run's prompt for messages that go as one turn: each in order, a blank line apart. */
export const turnPrompt = (messages: readonly string[]) =>
  messages
    .map((m) => m.trim())
    .filter(Boolean)
    .join("\n\n");

export const queueView = (queue: readonly AgentChatQueuedRecord[]): AgentChatQueuedView[] =>
  queue.map((q) => ({ id: q.id, content: q.content, at: q.at, files: (q.files ?? []).map((f) => ({ name: f.name, size: f.size })) }));

/**
 * The turn the queued messages make once the answer before them ends at `at` (ms): each as a
 * question of the run `runId`, a moment after the answer and in order; the run's prompt and files
 * (named apart from one another); whether a connected app sent one (the run is then one from an
 * app: no mail tools) and whether the Telegram bot did (it follows the answer); and the clock the
 * last one was written on.
 */
export function queuedTurn(queue: readonly AgentChatQueuedRecord[], runId: string, at: number) {
  const names: string[] = [];
  const files: AgentChatFileIn[] = [];
  const records: AgentChatMessageRecord[] = queue.map((q, i) => {
    const own = (q.files ?? []).map((f) => {
      const name = uniqueAttachmentName(names, f.name);
      names.push(name);
      files.push({ ...f, name });
      return { name, size: f.size };
    });
    return { role: "user", content: q.content, runId, at: new Date(at + 1 + i).toISOString(), ...(own.length ? { files: own } : {}) };
  });
  return {
    records,
    prompt: turnPrompt(queue.map((q) => q.content)),
    files,
    fromApp: queue.some((q) => q.fromApp),
    telegram: queue.some((q) => q.via === "telegram"),
    timeZone: queue.findLast((q) => q.timeZone)?.timeZone,
  };
}

/**
 * A conversation's records with each turn's questions as one (messages that waited in the queue
 * share their run): what the model's history pairs with the answer.
 */
export function mergeTurnQuestions<T extends Pick<AgentChatMessageRecord, "role" | "content" | "runId" | "files" | "summary">>(records: readonly T[]): T[] {
  const out: T[] = [];
  for (const record of records) {
    const last = out.at(-1);
    if (last && record.role === "user" && last.role === "user" && last.runId === record.runId && !record.summary && !last.summary) {
      const files = [...(last.files ?? []), ...(record.files ?? [])];
      out[out.length - 1] = { ...last, content: turnPrompt([last.content, record.content]), ...(files.length ? { files } : {}) };
    } else out.push(record);
  }
  return out;
}

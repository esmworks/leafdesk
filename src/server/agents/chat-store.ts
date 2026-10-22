/**
 * Where a chat's runs keep what was said (`agent_conversation`, see lib/agent-chat.ts): the run
 * reads the conversation before its message, and writes its answer there when it ends, however it
 * ends. Kept apart from chat.ts (the chat's checks and lists), which queues runs: the worker
 * (run.ts) imports this.
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentConversation, type agentRun } from "@/db/schema";
import type { ChatStepRecord } from "@/db/schema/ai";
import { AGENT_CHAT_HISTORY, type AgentChatMessageRecord } from "@/lib/agent-chat";
import type { AgentRunCode, AgentStepRecord } from "@/lib/agents";
import { redactError, redactText, redactValue } from "@/lib/redact";
import { chatHistory } from "@/server/ai/prompts";

type Run = Pick<typeof agentRun.$inferSelect, "id" | "source" | "steps">;

/** The steps the people's chat knows how to put into a conversation's history (changes made, connection calls). */
const chatSteps = (steps: AgentStepRecord[] | undefined): ChatStepRecord[] =>
  (steps ?? []).filter((s): s is ChatStepRecord => s.kind !== "comment" && s.kind !== "email" && s.kind !== "tool" && s.kind !== "skill");

/**
 * The conversation before a chat run's message, for the model: whole turns, newest kept first,
 * within `budget` characters, AGENT_CHAT_HISTORY messages at most. Empty for other runs.
 */
export async function chatRunHistory(run: Run, budget: number): Promise<{ role: "user" | "assistant"; content: string }[]> {
  if (run.source.kind !== "chat") return [];
  const [found] = await db.select({ messages: agentConversation.messages }).from(agentConversation).where(eq(agentConversation.id, run.source.conversationId));
  if (!found) return [];
  const at = found.messages.findIndex((m) => m.role === "user" && m.runId === run.id);
  const before = (at >= 0 ? found.messages.slice(0, at) : found.messages).slice(-AGENT_CHAT_HISTORY);
  return chatHistory(
    before.map((m) => ({ role: m.role, content: m.code && !m.content ? "(No answer: the run failed.)" : m.content, steps: chatSteps(m.steps) })),
    budget,
  );
}

/**
 * Writes a chat run's answer (or that it failed, and why) to its conversation, once: a run ended
 * twice (its worker stopped as it finished) adds nothing the second time. Never throws: the run's
 * ending is saved either way.
 */
export async function closeChatTurn(run: Run, ending: { answer?: string; code?: AgentRunCode | null; steps?: AgentStepRecord[] }) {
  if (run.source.kind !== "chat") return;
  try {
    const record: AgentChatMessageRecord = {
      role: "assistant",
      content: redactText(ending.answer ?? "").slice(0, 8_000),
      runId: run.id,
      ...(ending.code ? { code: ending.code } : {}),
      steps: redactValue(ending.steps ?? run.steps),
      at: new Date().toISOString(),
    };
    await db
      .update(agentConversation)
      .set({ messages: sql`${agentConversation.messages} || ${JSON.stringify([record])}::jsonb`, updatedAt: new Date() })
      .where(
        and(
          eq(agentConversation.id, run.source.conversationId),
          sql`not (${agentConversation.messages} @> ${JSON.stringify([{ role: "assistant", runId: run.id }])}::jsonb)`,
        ),
      );
  } catch (error) {
    console.error("[agents] could not keep a chat's answer", redactError(error));
  }
}

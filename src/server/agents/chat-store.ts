/**
 * Where a chat's runs keep what was said (`agent_conversation`, see lib/agent-chat.ts): the run
 * reads the conversation before its message, and writes its answer there when it ends, however it
 * ends. Kept apart from chat.ts (the chat's checks and lists), which queues runs: the worker
 * (run.ts) imports this.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentConversation, agentRun } from "@/db/schema";
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
 * within `budget` characters, AGENT_CHAT_HISTORY messages at most. In the agent's own chat (no chat
 * id) the person's other runs of the agent in that time (ownRunTurns) come in among them, so that
 * what it did on its own can be talked about. Empty for other runs.
 */
export async function chatRunHistory(run: Run, budget: number): Promise<{ role: "user" | "assistant"; content: string }[]> {
  if (run.source.kind !== "chat") return [];
  const [found] = await db
    .select({ messages: agentConversation.messages, chatId: agentConversation.chatId, agentId: agentConversation.agentId })
    .from(agentConversation)
    .where(eq(agentConversation.id, run.source.conversationId));
  if (!found) return [];
  const at = found.messages.findIndex((m) => m.role === "user" && m.runId === run.id);
  const before = (at >= 0 ? found.messages.slice(0, at) : found.messages).slice(-AGENT_CHAT_HISTORY);
  const turns = before.map((m) => ({ role: m.role, content: m.code && !m.content ? "(No answer: the run failed.)" : m.content, steps: chatSteps(m.steps), at: m.at }));
  const own = found.chatId === null ? await ownRunTurns(found.agentId, run.source.userId, before[0]?.at ?? null, at >= 0 ? found.messages[at].at : null) : [];
  if (!own.length) return chatHistory(turns, budget);
  // Turns stay whole (a question, then its answer): a run that started while one was answered goes after it.
  const units: (typeof turns)[] = [];
  for (const turn of turns) {
    if (turn.role === "user" || !units.length) units.push([turn]);
    else units.at(-1)!.push(turn);
  }
  for (let i = 0; i < own.length; i += 2) units.push(own.slice(i, i + 2));
  return chatHistory(
    units.sort((a, b) => a[0].at.localeCompare(b[0].at)).flat(),
    budget,
  );
}

/** Runs of the person's own (other than chats) the history takes, at most. */
const OWN_RUN_TURNS = 5;

/**
 * The agent's finished runs the person started other than by chatting (a schedule they set last, a
 * task they asked for, a comment of theirs that mentioned it), since `from` (or the latest few) and
 * before `until`, each as a turn: what started it, then what it answered. They read with that
 * person's access (or the agent's lower one), as the chat does.
 */
async function ownRunTurns(agentId: string, userId: string, from: string | null, until: string | null) {
  const rows = await db
    .select({ source: agentRun.source, prompt: agentRun.prompt, answer: agentRun.answer, steps: agentRun.steps, createdAt: agentRun.createdAt })
    .from(agentRun)
    .where(
      and(
        eq(agentRun.agentId, agentId),
        eq(agentRun.status, "done"),
        sql`(${agentRun.source}->>'scheduledBy' = ${userId} or ${agentRun.source}->>'requestedBy' = ${userId} or ${agentRun.source}->>'mentionedBy' = ${userId})`,
        from ? sql`${agentRun.createdAt} >= ${from}::timestamptz` : undefined,
        until ? sql`${agentRun.createdAt} < ${until}::timestamptz` : undefined,
      ),
    )
    .orderBy(desc(agentRun.createdAt))
    .limit(OWN_RUN_TURNS);
  return rows
    .filter((r) => r.answer.trim())
    .flatMap((r) => {
      const at = r.createdAt.toISOString();
      const started = r.source.kind === "schedule" ? "on a schedule they set" : r.source.kind === "mention" ? "when they mentioned you in a comment" : "on a task they asked for";
      return [
        { role: "user" as const, content: `(Not a message: you ran ${started}, at ${at}. The task: ${r.prompt.slice(0, 1_000)})`, steps: [], at },
        { role: "assistant" as const, content: r.answer, steps: chatSteps(r.steps), at },
      ];
    });
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

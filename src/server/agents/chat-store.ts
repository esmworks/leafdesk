/**
 * Where a chat's runs keep what was said (`agent_conversation`, see lib/agent-chat.ts): the run
 * reads the conversation before its message, and writes its answer there when it ends, however it
 * ends, with the files it attached; the messages that waited meanwhile (lib/agent-chat-queue.ts)
 * then go as the next turn. Kept apart from chat.ts (the chat's checks and lists), which queues
 * runs: the worker (run.ts) imports this.
 */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentChatFile, agentConversation, agentRun, file } from "@/db/schema";
import type { ChatStepRecord } from "@/db/schema/ai";
import { AGENT_CHAT_HISTORY, type AgentChatAnswerFile, type AgentChatMessageRecord } from "@/lib/agent-chat";
import { mergeTurnQuestions, queuedTurn } from "@/lib/agent-chat-queue";
import { summaryTurn } from "@/lib/agent-chat-summary";
import { readEmail, type AgentRunCode, type AgentStepRecord } from "@/lib/agents";
import { redactError, redactText, redactValue } from "@/lib/redact";
import { chatHistory } from "@/server/ai/prompts";
import { kickAgents } from "./kick";

type Run = Pick<typeof agentRun.$inferSelect, "id" | "source" | "steps">;
type EndedRun = Run & Pick<typeof agentRun.$inferSelect, "agentId" | "workspaceId" | "context">;

/** The steps the people's chat knows how to put into a conversation's history (changes made, connection calls). */
const chatSteps = (steps: AgentStepRecord[] | undefined): ChatStepRecord[] =>
  (steps ?? []).filter((s): s is ChatStepRecord => s.kind !== "comment" && s.kind !== "email" && s.kind !== "tool" && s.kind !== "skill");

/**
 * The conversation before a chat run's message, for the model: whole turns, newest kept first,
 * within `budget` characters, AGENT_CHAT_HISTORY messages at most. In the agent's own chat (no chat
 * id) the person's other runs of the agent in that time (ownRunTurns) come in among them, so that
 * what it did on its own can be talked about. Empty for other runs. `mailRead`: a turn it takes
 * read email (lib/agents.ts readEmail), so the run is held as one that read it; a run sent from a
 * connected app leaves such turns out instead, as it may not have what they say.
 */
export async function chatRunHistory(run: Run, budget: number): Promise<{ messages: { role: "user" | "assistant"; content: string }[]; mailRead: boolean }> {
  if (run.source.kind !== "chat") return { messages: [], mailRead: false };
  const fromApp = Boolean(run.source.fromApp);
  const [found] = await db
    .select({ messages: agentConversation.messages, chatId: agentConversation.chatId, agentId: agentConversation.agentId })
    .from(agentConversation)
    .where(eq(agentConversation.id, run.source.conversationId));
  if (!found) return { messages: [], mailRead: false };
  const at = found.messages.findIndex((m) => m.role === "user" && m.runId === run.id);
  // Messages that waited in the queue go with their answer as one question.
  const before = mergeTurnQuestions(at >= 0 ? found.messages.slice(0, at) : found.messages).slice(-AGENT_CHAT_HISTORY);
  const turns = before.flatMap((m) => {
    const mail = readEmail(m.steps);
    // A summary the conversation started from: what was said before it.
    if (m.summary) return summaryTurn(m.content).map((t) => ({ ...t, steps: [] as ChatStepRecord[], attachments: undefined, at: m.at, mail }));
    const failed = m.code && !m.content ? "(No answer: the run failed.)" : m.content;
    const attached = m.attached?.length ? `\n\n(You attached the files ${m.attached.map((f) => `"${f.name}"`).join(", ")} to this answer.)` : "";
    // The files' text went to that run only: later ones know their names.
    const attachments = m.files?.map((f) => ({ id: "", name: f.name, contentType: "text/plain", size: f.size }));
    return [{ role: m.role, content: `${failed}${attached}`, steps: chatSteps(m.steps), attachments, at: m.at, mail }];
  });
  const own = found.chatId === null ? await ownRunTurns(found.agentId, run.source.userId, before[0]?.at ?? null, at >= 0 ? found.messages[at].at : null) : [];
  // Turns stay whole (a question, then its answer): a run that started while one was answered goes after it.
  const units: (typeof turns)[] = [];
  for (const turn of turns) {
    if (turn.role === "user" || !units.length) units.push([turn]);
    else units.at(-1)!.push(turn);
  }
  for (let i = 0; i < own.length; i += 2) units.push(own.slice(i, i + 2));
  const mailed = (unit: typeof turns) => unit.some((t) => t.mail);
  const kept = fromApp ? units.filter((unit) => !mailed(unit)) : units;
  return {
    messages: chatHistory(
      kept.sort((a, b) => a[0].at.localeCompare(b[0].at)).flat(),
      budget,
    ),
    mailRead: kept.some(mailed),
  };
}

/** What the person wrote earlier in a chat run's conversation: the addresses there are theirs to write to (ai-chat-mail.ts). */
export async function chatRunTyped(run: Run): Promise<string[]> {
  if (run.source.kind !== "chat") return [];
  const [found] = await db.select({ messages: agentConversation.messages }).from(agentConversation).where(eq(agentConversation.id, run.source.conversationId));
  return (found?.messages ?? []).filter((m) => m.role === "user" && m.runId !== run.id).map((m) => m.content);
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
        { role: "user" as const, content: `(Not a message: you ran ${started}, at ${at}. The task: ${r.prompt.slice(0, 1_000)})`, steps: [], attachments: undefined, at, mail: false },
        { role: "assistant" as const, content: r.answer, steps: chatSteps(r.steps), attachments: undefined, at, mail: readEmail(r.steps) },
      ];
    });
}

/** The files the agent attached to a chat run's answer (`attach_file`), oldest first. */
export async function answerFiles(runId: string): Promise<AgentChatAnswerFile[]> {
  return db
    .select({ id: file.id, name: file.name, size: file.size, contentType: file.contentType })
    .from(agentChatFile)
    .innerJoin(file, eq(file.id, agentChatFile.fileId))
    .where(eq(agentChatFile.runId, runId))
    .orderBy(asc(agentChatFile.createdAt));
}

/**
 * Writes a chat run's answer (or that it failed, and why) to its conversation, with the files it
 * attached, once: a run ended twice (its worker stopped as it finished) adds nothing the second
 * time. The messages that waited for it go on at once as the next turn: one run (source `after`
 * this one), each kept as a question of it after the answer. The conversation's row is locked
 * meanwhile, as chat.ts locks it to queue a message, so none slips between. Called before the
 * run's status changes (run.ts finish): once a run reads as ended, its answer and the next turn
 * are there. Never throws: the run's ending is saved either way.
 */
export async function closeChatTurn(run: EndedRun, ending: { answer?: string; code?: AgentRunCode | null; steps?: AgentStepRecord[] }) {
  if (run.source.kind !== "chat") return;
  const source = run.source;
  try {
    const attached = await answerFiles(run.id);
    const next = await db.transaction(async (tx) => {
      const [found] = await tx
        .select({ messages: agentConversation.messages, queue: agentConversation.queue })
        .from(agentConversation)
        .where(eq(agentConversation.id, source.conversationId))
        .for("update");
      if (!found || found.messages.some((m) => m.role === "assistant" && m.runId === run.id)) return null;
      const now = Date.now();
      const record: AgentChatMessageRecord = {
        role: "assistant",
        content: redactText(ending.answer ?? "").slice(0, 8_000),
        runId: run.id,
        ...(ending.code ? { code: ending.code } : {}),
        steps: redactValue(ending.steps ?? run.steps),
        ...(attached.length ? { attached } : {}),
        at: new Date(now).toISOString(),
      };
      let added: AgentChatMessageRecord[] = [record];
      let nextRun: string | null = null;
      if (found.queue.length) {
        const turn = queuedTurn(found.queue, "", now);
        const zone = turn.timeZone ?? ("timeZone" in run.context ? run.context.timeZone : undefined);
        const [queued] = await tx
          .insert(agentRun)
          .values({
            agentId: run.agentId,
            workspaceId: run.workspaceId,
            source: { kind: "chat", userId: source.userId, conversationId: source.conversationId, ...(turn.fromApp ? { fromApp: true } : {}), after: run.id, ...(turn.telegram ? { telegram: true as const } : {}) },
            context: { actorId: source.userId, ...(zone ? { timeZone: zone } : {}), ...(turn.files.length ? { files: turn.files } : {}) },
            prompt: turn.prompt,
          })
          .returning({ id: agentRun.id });
        nextRun = queued.id;
        added = [record, ...turn.records.map((r) => ({ ...r, runId: queued.id }))];
      }
      await tx
        .update(agentConversation)
        .set({ messages: sql`${agentConversation.messages} || ${JSON.stringify(added)}::jsonb`, queue: [], updatedAt: new Date(now) })
        .where(eq(agentConversation.id, source.conversationId));
      return nextRun;
    });
    if (next) kickAgents();
  } catch (error) {
    console.error("[agents] could not keep a chat's answer", redactError(error));
  }
}

/**
 * AI chat over workspace pages (#41): answers a person's questions from the pages they can read,
 * citing them. Each question:
 *
 * 1. is checked (membership and the workspace's two-step policy, AI on in the workspace, the scope
 *    page readable, size and rate limits) before anything is sent;
 * 2. goes to the model with a map of the workspace as the person can see it (its databases with
 *    their properties, and its pages), so the model decides what to look at;
 * 3. may make the model call `search_pages` (hybrid full-text and semantic search), `read_page`
 *    and `query_database`, which run as the person through operations.ts with their access
 *    checked on every call: a page they lost access to since can't be read, whatever the
 *    conversation said before;
 * 4. unless the chat's mode is `read`, may make it change things as the person (`create_row`,
 *    `update_row`, `create_page`, with their edit access checked): in mode `ask` the answer waits
 *    for the person to approve each change (ai-chat-approvals.ts), in `auto` it doesn't;
 * 5. streams the answer; citations ([n]) link to the pages (and the block a passage starts at).
 *
 * Conversations are kept per person (ai_conversation) and only ever shown to them; cited pages are
 * looked up again with their current access whenever a conversation is shown.
 */
import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  aiConversation,
  type ChatMessageRecord,
  type ChatSourceRef,
  type ChatStepRecord,
} from "@/db/schema";
import type { AiErrorCode } from "@/lib/ai";
import {
  citedNumbers,
  conversationTitle,
  MAX_CHAT_MESSAGE,
  MAX_CHAT_TURNS,
  MAX_CONVERSATIONS,
  type ChatEvent,
  type ChatMessageView,
  type ChatMode,
  type ChatPageView,
  type ChatScope,
  type ChatSourceView,
  type ChatStepView,
  type ConversationSummary,
  stripCitations,
} from "@/lib/ai-chat";
import { pageLabel } from "@/lib/labels";
import { AccessError, requireMembership, requirePageAccess, WorkspacePolicyError } from "@/server/access";
import { aiConfig, AiError, isAiError, stream, takeRateLimit, takeWorkspaceCapacity, type AiMessage } from "@/server/ai";
import { chatHistory, chatQuestionPrompt, chatSystemPrompt } from "@/server/ai/prompts";
import { aiAvailable } from "@/server/ai-writing";
import { awaitDecision, type ChatDecision } from "@/server/ai-chat-approvals";
import * as ops from "@/server/operations";
import {
  applyWrite,
  CHAT_TOOLS,
  MAP_CHARS,
  prepareWrite,
  runTool,
  visiblePages,
  workspaceMap,
  WRITE_TOOL_NAMES,
  WRITE_TOOLS,
  type Registry,
  type ToolOutcome,
} from "@/server/ai-tools";

/** Model turns per question: searches, reads and queries, then the answer. */
export const MAX_ROUNDS = 6;
/** The most of what the model says before a search or read that is kept as a step. */
const THOUGHT_CHARS = 300;
/** Share of the prompt that earlier questions and answers may take. */
const HISTORY_SHARE = 0.25;
/** How often a stream waiting on the person's decision sends a ping. */
const PING_MS = 20_000;

export type ChatInput = {
  workspaceId: string;
  /** Continues this conversation; a new one starts without. */
  conversationId?: string | null;
  message: string;
  scope?: ChatScope;
  /** What the chat may change (ask before each change when left out). */
  mode?: ChatMode;
  /**
   * Asks again in place of the conversation's last question and answer (answer again, or an edited
   * question): they are replaced once the new answer is kept, and left as they were otherwise.
   */
  replaceLast?: boolean;
};

/** Refusals before anything is sent: access problems look like missing things. */
function refuse(code: AiErrorCode, message: string): never {
  throw new AiError(code, message);
}

async function scopePage(userId: string, workspaceId: string, scope: ChatScope | undefined) {
  if (!scope) return null;
  const found = await requirePageAccess(userId, scope.pageId, "view").catch((error) => {
    if (error instanceof AccessError && !(error instanceof WorkspacePolicyError)) refuse("noAccess", "Page not found");
    throw error;
  });
  if (found.workspaceId !== workspaceId || found.archivedAt || found.inTemplate) refuse("noAccess", "Page not found");
  return found;
}

/** The person's conversation (theirs, in this workspace), or noAccess. */
async function ownConversation(userId: string, workspaceId: string, conversationId: string) {
  const [found] = await db
    .select()
    .from(aiConversation)
    .where(and(eq(aiConversation.id, conversationId), eq(aiConversation.userId, userId), eq(aiConversation.workspaceId, workspaceId)))
    .limit(1);
  if (!found) refuse("noAccess", "Conversation not found");
  return found;
}

/** Characters a list of messages takes in a prompt (as the AI layer counts them). */
const sizeOf = (messages: AiMessage[]) => messages.reduce((n, m) => n + m.content.length, 0);

/**
 * Starts answering a question. Checks and limits run first and throw AiError (nothing is sent
 * then); the returned events stream the work. `signal` cancels it: what was written so far is kept
 * in the conversation, marked as stopped.
 */
export async function startChat(userId: string, input: ChatInput, signal?: AbortSignal): Promise<AsyncIterable<ChatEvent>> {
  const message = input.message.trim();
  if (!message) refuse("invalid", "Ask a question");
  if (message.length > MAX_CHAT_MESSAGE) refuse("tooLarge", `A question may have at most ${MAX_CHAT_MESSAGE} characters`);
  await requireMembership(userId, input.workspaceId).catch((error) => {
    if (error instanceof AccessError && !(error instanceof WorkspacePolicyError)) refuse("noAccess", "Workspace not found");
    throw error;
  });
  if (!(await aiAvailable(input.workspaceId))) refuse("disabled", "AI is off for this workspace");
  const scope = await scopePage(userId, input.workspaceId, input.scope);
  const existing = input.conversationId ? await ownConversation(userId, input.workspaceId, input.conversationId) : null;
  const replaced = input.replaceLast ? lastTurn(existing) : 0;
  if (existing && existing.messages.filter((m) => m.role === "user").length - (replaced ? 1 : 0) >= MAX_CHAT_TURNS) {
    refuse("tooLarge", "This conversation is full; start a new one");
  }
  takeRateLimit({ userId, workspaceId: input.workspaceId });
  return runChat(userId, input.workspaceId, message, scope ? { id: scope.id, title: scope.title } : null, existing, input.mode ?? "ask", replaced, signal);
}

/**
 * The records the last question and its answer take (2), to be asked again; refused when there is
 * none, or when that answer changed things (asking again would make them twice).
 */
function lastTurn(existing: typeof aiConversation.$inferSelect | null): number {
  const [question, answer] = existing?.messages.slice(-2) ?? [];
  if (question?.role !== "user" || answer?.role !== "assistant") refuse("invalid", "There is no answer to ask again");
  if (answer.steps?.some((s) => s.kind === "write" && s.outcome === "done")) refuse("invalid", "An answer that changed things can't be asked again");
  return 2;
}

async function* runChat(
  userId: string,
  workspaceId: string,
  message: string,
  scope: { id: string; title: string } | null,
  existing: typeof aiConversation.$inferSelect | null,
  initialMode: ChatMode,
  /** Records at the end of the conversation the new turn replaces. */
  replaced: number,
  signal?: AbortSignal,
): AsyncGenerator<ChatEvent> {
  const ctx: ops.OperationContext = { userId, actor: { userId } };
  const limits = aiConfig().limits;
  // "Don't ask again" makes the rest of this answer `auto`.
  let mode = initialMode;
  const tools = mode === "read" ? CHAT_TOOLS : [...CHAT_TOOLS, ...WRITE_TOOLS];
  const system = chatSystemPrompt(scope ? pageLabel(scope.title) : null, mode !== "read");
  const toolsSize = tools.reduce((n, t) => n + t.description.length + JSON.stringify(t.parameters).length, 0);
  const room = () => limits.maxInputChars - system.length - toolsSize - 200;

  const conversation =
    existing ??
    (
      await db
        .insert(aiConversation)
        .values({ userId, workspaceId, title: conversationTitle(message), messages: [] })
        .returning()
    )[0];
  yield { type: "conversation", id: conversation.id, title: conversation.title };

  const registry: Registry = { sources: [], byKey: new Map() };
  const started = Date.now();
  const steps: ChatStepRecord[] = [];
  const step = async (record: ChatStepRecord): Promise<ChatEvent> => {
    steps.push(record);
    return { type: "step", step: await viewStep(userId, record) };
  };
  let answer = "";
  let stopReason: "stop" | "length" = "stop";
  let failure: AiErrorCode | null = null;
  try {
    // ---------------------------------------------------------------------------- the question
    // Nothing is searched for the model: it gets the map of what there is and decides itself.
    const earlier = existing?.messages.slice(0, existing.messages.length - replaced) ?? [];
    const history: AiMessage[] = chatHistory(earlier, Math.floor(room() * HISTORY_SHARE));
    const mapRoom = Math.min(MAP_CHARS, room() - sizeOf(history) - message.length - 2_000);
    const map = mapRoom >= 500 ? await workspaceMap(ctx, workspaceId, scope?.id ?? null, mapRoom) : "";
    const messages: AiMessage[] = [...history, { role: "user", content: chatQuestionPrompt(message, map) }];

    // ------------------------------------------------------------------------------ model turns
    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (round > 0) {
        const wait = takeWorkspaceCapacity(workspaceId);
        if (wait > 0) throw new AiError("rateLimited", "The workspace's AI allowance is used up for now", wait);
      }
      const last = round === MAX_ROUNDS - 1;
      yield { type: "thinking" };
      const turn = stream({
        feature: "chat",
        userId,
        workspaceId,
        skipRateLimit: true,
        system,
        messages,
        // Tools stay declared (providers want them while the conversation has tool calls); the
        // last turn is told to answer instead, and what it writes is the answer.
        tools,
        signal,
        sessionId: conversation.id,
      });
      let streamed = "";
      for await (const event of turn) {
        streamed += event.delta;
        answer = streamed;
        yield { type: "text", text: event.delta };
      }
      const result = await turn.result();
      if (!result.toolCalls.length || last) {
        answer = result.text;
        stopReason = result.stopReason === "length" ? "length" : "stop";
        break;
      }
      // Text before a tool call is the model thinking aloud, not the answer: it's kept as a step.
      if (streamed) yield { type: "reset" };
      const thought = stripCitations(streamed).replace(/\s+/g, " ").trim();
      if (thought) yield await step({ kind: "thought", text: thought.length > THOUGHT_CHARS ? `${thought.slice(0, THOUGHT_CHARS - 1).trimEnd()}…` : thought });
      answer = "";
      messages.push(result.message);
      const answerNext = round === MAX_ROUNDS - 2;
      for (const call of result.toolCalls) {
        const left = room() - sizeOf(messages) - 300;
        let out: ToolOutcome;
        if (!WRITE_TOOL_NAMES.has(call.name)) out = await runTool(ctx, workspaceId, scope?.id, call, registry, left);
        else if (mode === "read") out = { content: "Changes are off in this chat: say what you would change instead.", isError: true };
        else {
          const prepared = await prepareWrite(ctx, workspaceId, scope?.id ?? null, call);
          let decision: ChatDecision | "timeout" = "approve";
          if ("action" in prepared && mode === "ask") {
            const waiting = awaitDecision(userId, signal);
            yield { type: "approval", id: waiting.id, action: prepared.action };
            for (;;) {
              let timer: ReturnType<typeof setTimeout> | undefined;
              const next = await Promise.race([waiting.decision, new Promise<"ping">((r) => (timer = setTimeout(() => r("ping"), PING_MS)))]);
              clearTimeout(timer);
              if (next !== "ping") {
                decision = next;
                break;
              }
              yield { type: "ping" };
            }
            if (decision === "always") mode = "auto";
          }
          out = "action" in prepared ? await applyWrite(prepared, decision, registry) : prepared;
        }
        if (out.step) yield await step(out.step);
        const content = answerNext ? `${out.content}\n\n(No more searching or reading: answer now with the sources you have.)` : out.content;
        messages.push({ role: "tool", toolCallId: call.id, name: call.name, content, isError: out.isError });
      }
    }
    if (!answer.trim()) throw new AiError("empty", "The model gave no answer");
  } catch (error) {
    failure = isAiError(error) ? error.code : "provider";
    if (!isAiError(error)) console.error("[ai] chat failed", error);
  }

  // ------------------------------------------------------------------------------ the answer
  // Changes made are kept in the conversation, also when the answer didn't come.
  const changed = steps.some((s) => s.kind === "write" && s.outcome === "done");
  const stopped = failure === "aborted" && (answer.trim().length > 0 || changed);
  if (!failure || stopped || changed) {
    const cited = new Set(citedNumbers(answer));
    const refs: ChatSourceRef[] = registry.sources.filter((s) => cited.has(s.n)).map((s) => ({ n: s.n, pageId: s.pageId, blockId: s.blockId }));
    const now = new Date().toISOString();
    const note = stopped ? "stopped" : failure ? undefined : stopReason === "length" ? "cutOff" : undefined;
    const ms = Date.now() - started;
    await saveTurn(
      conversation.id,
      [
        { role: "user", content: message, at: now },
        { role: "assistant", content: answer, sources: refs, ...(note ? { note } : {}), steps, ms, at: now },
      ],
      replaced,
    );
    await pruneConversations(userId, workspaceId);
    yield { type: "sources", sources: await viewSources(userId, refs) };
    if (!failure) yield { type: "done", stopReason, ms };
    else yield { type: "error", code: failure };
    return;
  }
  // Nothing to keep: a conversation this question started goes again.
  if (!existing) await db.delete(aiConversation).where(and(eq(aiConversation.id, conversation.id), sql`jsonb_array_length(${aiConversation.messages}) = 0`));
  yield { type: "error", code: failure };
}

// ---------------------------------------------------------------------------- conversations

/** Adds a question and its answer to a conversation, in place of its last `replace` records. */
async function saveTurn(conversationId: string, records: ChatMessageRecord[], replace = 0) {
  // Keeps the records before the replaced ones (a jsonb array's elements, in order).
  const kept = replace
    ? sql`coalesce((select jsonb_agg(e order by i) from jsonb_array_elements(${aiConversation.messages}) with ordinality as t(e, i) where i <= jsonb_array_length(${aiConversation.messages}) - ${replace}), '[]'::jsonb)`
    : sql`${aiConversation.messages}`;
  await db
    .update(aiConversation)
    .set({ messages: sql`${kept} || ${JSON.stringify(records)}::jsonb`, updatedAt: new Date() })
    .where(eq(aiConversation.id, conversationId));
}

/** Keeps the person's MAX_CONVERSATIONS most recent conversations in the workspace. */
async function pruneConversations(userId: string, workspaceId: string) {
  const keep = await db
    .select({ id: aiConversation.id })
    .from(aiConversation)
    .where(and(eq(aiConversation.userId, userId), eq(aiConversation.workspaceId, workspaceId)))
    .orderBy(desc(aiConversation.updatedAt))
    .limit(MAX_CONVERSATIONS);
  if (keep.length < MAX_CONVERSATIONS) return;
  await db.delete(aiConversation).where(
    and(
      eq(aiConversation.userId, userId),
      eq(aiConversation.workspaceId, workspaceId),
      notInArray(
        aiConversation.id,
        keep.map((k) => k.id),
      ),
    ),
  );
}

/** A step as the person may see it now: a page read that they can't open has no title. */
export async function viewStep(userId: string, record: ChatStepRecord, pages?: Awaited<ReturnType<typeof visiblePages>>): Promise<ChatStepView> {
  if (record.kind === "write") {
    const ids = [record.targetId, record.pageId].filter((id): id is string => Boolean(id));
    const seen = pages ?? (await visiblePages(userId, ids));
    const viewOf = (id: string | null): ChatPageView => {
      const found = id ? seen.get(id) : undefined;
      return id && found ? { pageId: id, ...found } : null;
    };
    const target = viewOf(record.targetId);
    const made = viewOf(record.pageId);
    // What was set in a page they can't open any more isn't shown either.
    const hidden = (record.targetId && !target) || (record.pageId && !made);
    return { kind: "write", action: record.action, outcome: record.outcome, target, page: made, title: hidden ? null : record.title, changes: hidden ? [] : record.changes };
  }
  if (record.kind !== "read" && record.kind !== "query") return record;
  const id = record.kind === "read" ? record.pageId : record.databaseId;
  const seen = (pages ?? (await visiblePages(userId, [id]))).get(id);
  const view = seen ? { pageId: id, ...seen } : null;
  // A database they can't open any more keeps neither its name nor what was asked of it.
  if (record.kind === "query") {
    return { kind: "query", database: view, conditions: view ? record.conditions : [], ...(view && record.any ? { any: true } : {}), results: record.results };
  }
  return { kind: "read", page: view };
}

/** Cited pages as the person may see them now: pages they can't open lose id and title. */
export async function viewSources(userId: string, refs: ChatSourceRef[]): Promise<ChatSourceView[]> {
  const visible = await visiblePages(userId, refs.map((r) => r.pageId));
  return refs.map((r) => {
    const seen = visible.get(r.pageId);
    return seen
      ? { n: r.n, pageId: r.pageId, workspaceId: seen.workspaceId, title: seen.title, icon: seen.icon, kind: seen.kind, blockId: r.blockId }
      : { n: r.n, pageId: null, workspaceId: null, title: null, icon: null, kind: null, blockId: null };
  });
}

/** The person's conversations in a workspace, newest first. */
export async function listConversations(userId: string, workspaceId: string): Promise<ConversationSummary[]> {
  await requireMembership(userId, workspaceId);
  const rows = await db
    .select({ id: aiConversation.id, title: aiConversation.title, updatedAt: aiConversation.updatedAt })
    .from(aiConversation)
    .where(and(eq(aiConversation.userId, userId), eq(aiConversation.workspaceId, workspaceId)))
    .orderBy(desc(aiConversation.updatedAt));
  return rows.map((r) => ({ id: r.id, title: r.title, updatedAt: r.updatedAt.toISOString() }));
}

/** One of the person's conversations, with its sources as they may see them now. */
export async function getConversation(userId: string, workspaceId: string, conversationId: string) {
  await requireMembership(userId, workspaceId);
  const found = await ownConversation(userId, workspaceId, conversationId).catch(() => {
    throw new AccessError();
  });
  const refs = found.messages.flatMap((m) => m.sources ?? []);
  const views = await viewSources(userId, refs);
  const read = await visiblePages(
    userId,
    found.messages.flatMap((m) =>
      (m.steps ?? []).flatMap((s) =>
        s.kind === "read" ? [s.pageId] : s.kind === "query" ? [s.databaseId] : s.kind === "write" ? [s.targetId, s.pageId].filter((id): id is string => Boolean(id)) : [],
      ),
    ),
  );
  let i = 0;
  const messages: ChatMessageView[] = await Promise.all(
    found.messages.map(async (m) => {
      const sources = m.sources?.map(() => views[i++]);
      const steps = m.steps ? await Promise.all(m.steps.map((s) => viewStep(userId, s, read))) : undefined;
      return {
        role: m.role,
        content: m.content,
        ...(sources ? { sources } : {}),
        ...(m.note ? { note: m.note } : {}),
        ...(steps ? { steps } : {}),
        ...(m.ms !== undefined ? { ms: m.ms } : {}),
        at: m.at,
      };
    }),
  );
  return { id: found.id, title: found.title, messages };
}

/** Deletes conversations of the person (only theirs). */
export async function deleteConversations(userId: string, workspaceId: string, conversationIds: string[] | "all") {
  await requireMembership(userId, workspaceId);
  await db
    .delete(aiConversation)
    .where(
      and(
        eq(aiConversation.userId, userId),
        eq(aiConversation.workspaceId, workspaceId),
        conversationIds === "all" ? undefined : inArray(aiConversation.id, conversationIds.length ? conversationIds : [""]),
      ),
    );
}

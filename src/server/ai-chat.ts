/**
 * AI chat over workspace pages (#41): answers a person's questions from the pages they can read,
 * citing them. Each question:
 *
 * 1. is checked (membership and the workspace's two-step policy, AI on in the workspace, the scope
 *    page readable, size and rate limits) before anything is sent;
 * 2. goes to the model with a map of the workspace as the person can see it (its databases with
 *    their properties, and its pages), so the model decides what to look at;
 * 3. may make the model call `search_pages` (hybrid full-text and semantic search), `read_page`,
 *    `query_database`, `list_comments`, `page_history` and `page_version`, which run as the person
 *    through operations.ts with their access checked on every call: a page they lost access to
 *    since can't be read, whatever the conversation said before;
 * 4. unless the chat's mode is `read`, may make it change things as the person (`create_row`,
 *    `update_row`, `create_page`, `edit_page`, `create_pdf`, `add_comment`, `create_database`,
 *    `create_form`, with their access checked): in mode `ask` the answer waits
 *    for the person to approve each change (ai-chat-approvals.ts), in `auto` it doesn't; asked
 *    through a connected app (the Telegram bot, server/telegram) in a workspace that lets apps only
 *    read, the mode is `read` and no notes are kept or dropped;
 * 5. in every mode, may make it keep or drop notes about the person (`remember`, `forget`): what
 *    it remembers goes with their later questions in the workspace (ai-memory.ts), unless the
 *    person or the workspace's owners turned the memory off;
 * 6. for members (not guests), may make it call the tools of the workspace's connections that its
 *    owners allowed the chat (server/connections): they run with the connection's credentials,
 *    their answers reach the model framed as outside data, and one that changes something there
 *    waits for the person's approval each time, in every mode (and isn't offered in `read`);
 * 7. carries the CSV files attached to its questions (at most 1,000 rows and 1 MB each, kept with
 *    the conversation in the question's record): every later question sends them again, cut to
 *    fit, with `read_attachment` to read further and `create_database_from_csv` to import one;
 * 8. streams the answer; citations ([n]) link to the pages (and the block a passage starts at).
 *
 * Conversations are kept per person (ai_conversation) and only ever shown to them; cited pages are
 * looked up again with their current access whenever a conversation is shown.
 */
import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  aiConversation,
  type ChatAttachmentRecord,
  type ChatMessageRecord,
  type ChatSourceRef,
  type ChatStepRecord,
} from "@/db/schema";
import type { AiErrorCode } from "@/lib/ai";
import {
  changedMemory,
  changedThings,
  citedNumbers,
  conversationTitle,
  MAX_CONVERSATIONS,
  type ChatActionView,
  type ChatConnectionRecord,
  type ChatEvent,
  type ChatMessageView,
  type ChatMode,
  type ChatPageView,
  type ChatScope,
  type ChatSourceView,
  type ChatStepView,
  type ConversationSummary,
  thoughtText,
} from "@/lib/ai-chat";
import { attachmentCsv, readCsvAttachment } from "@/lib/chat-attachment-table";
import { CHAT_MAX_ATTACHMENTS, cleanAttachmentName, uniqueAttachmentName } from "@/lib/chat-attachments";
import { pageLabel } from "@/lib/labels";
import { AccessError, connectedAppHold, isGuest, requireMembership, requirePageAccess, WorkspacePolicyError } from "@/server/access";
import { asWrite } from "@/server/connected-app";
import { AiError, isAiError, promptRoomFor, stream, takeRateLimit, takeWorkspaceCapacity, type AiMessage, type AiResult } from "@/server/ai";
import { dropOldToolResults } from "@/server/ai/compact";
import { browserTimeZone, isTimeZone } from "@/lib/time-zone";
import { attachmentBlock, chatHistory, chatQuestionPrompt, chatSystemPrompt } from "@/server/ai/prompts";
import { getSkillContent, SkillError } from "@/server/skills";
import { aiAvailable } from "@/server/ai-writing";
import { applyMemory, memoryForPrompt, memoryOn, MEMORY_TOOL_NAMES, MEMORY_TOOLS, prepareMemory } from "@/server/ai-memory";
import { awaitDecision, type ChatDecision } from "@/server/ai-chat-approvals";
import { chatToolNow, chatToolset, inputSummary, runConnectionTool, type ConnectionToolEntry } from "@/server/connections/tools";
import * as ops from "@/server/operations";
import { activeVerifications } from "@/server/verification";
import {
  applyWrite,
  ATTACHMENT_TOOLS,
  ATTACHMENT_WRITE_TOOL_NAMES,
  ATTACHMENT_WRITE_TOOLS,
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
/** Share of the prompt that earlier questions and answers may take, and what the chat remembers. */
const HISTORY_SHARE = 0.25;
const MEMORY_SHARE = 0.2;
/** How often a stream waiting on the person's decision sends a ping. */
const PING_MS = 20_000;
/** The longest skill a question can use: its instructions go with the question whole. */
export const MAX_CHAT_SKILL = 20_000;
/** Share of the prompt the conversation's attached files may take (the newest first). */
const FILES_SHARE = 0.4;

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
  /** A skill of the workspace whose instructions the answer follows (server/skills). */
  skillId?: string | null;
  /** The person's IANA time zone, for what today is (the server's when missing or unknown). */
  timeZone?: string | null;
  /** CSV files attached to the question: each file's name and text (lib/chat-attachments.ts). */
  attachments?: { name: string; text: string }[] | null;
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

/** The skill a question uses: one of the workspace the person can open, not too long to send. */
async function chatSkill(userId: string, workspaceId: string, skillId: string): Promise<ChatSkill> {
  const found = await getSkillContent(userId, skillId).catch((error) => {
    if ((error instanceof AccessError && !(error instanceof WorkspacePolicyError)) || error instanceof SkillError) refuse("noAccess", "Skill not found");
    throw error;
  });
  if (found.workspaceId !== workspaceId) refuse("noAccess", "Skill not found");
  if (found.body.length > MAX_CHAT_SKILL) refuse("tooLarge", `A skill used in the chat may have at most ${MAX_CHAT_SKILL} characters`);
  return { id: found.id, title: found.title, body: found.body };
}

type ChatSkill = { id: string; title: string; body: string };

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
  const files = input.attachments ?? [];
  if (!message && !files.length) refuse("invalid", "Ask a question");
  if (files.length > CHAT_MAX_ATTACHMENTS) refuse("tooLarge", `A question may have at most ${CHAT_MAX_ATTACHMENTS} files`);
  const membership = await requireMembership(userId, input.workspaceId).catch((error) => {
    if (error instanceof AccessError && !(error instanceof WorkspacePolicyError)) refuse("noAccess", "Workspace not found");
    throw error;
  });
  if (!(await aiAvailable(input.workspaceId))) refuse("disabled", "AI is off for this workspace");
  // A question is as long as the model's context window takes; nothing else bounds it.
  if (message.length > (await promptRoomFor(input.workspaceId))) refuse("tooLarge", "The question is longer than the model takes");
  const scope = await scopePage(userId, input.workspaceId, input.scope);
  const skill = input.skillId ? await chatSkill(userId, input.workspaceId, input.skillId) : null;
  const existing = input.conversationId ? await ownConversation(userId, input.workspaceId, input.conversationId) : null;
  const replaced = input.replaceLast ? lastTurn(existing) : 0;
  const attachments = attachedFiles(existing, files, replaced);
  takeRateLimit({ userId, workspaceId: input.workspaceId });
  // Asked through a connected app (the Telegram bot) where the workspace lets apps only read:
  // nothing is changed, notes about the person included.
  const appReadOnly = (await asWrite(() => connectedAppHold(userId, input.workspaceId))) === "readOnly";
  const chat = {
    scope: scope ? { id: scope.id, title: scope.title } : null,
    skill,
    existing,
    mode: appReadOnly ? "read" : (input.mode ?? "ask"),
    replaced,
    connections: !isGuest(membership.role),
    memoryChanges: !appReadOnly,
    timeZone: isTimeZone(input.timeZone) ? input.timeZone : browserTimeZone(),
    attachments,
  } as const;
  return runChat(userId, input.workspaceId, message, chat, signal);
}

/**
 * The question's files, read again as the box read them (lib/chat-attachments.ts) and named apart
 * from the conversation's other files. Asked again without files, a question keeps those it had.
 */
function attachedFiles(existing: typeof aiConversation.$inferSelect | null, files: { name: string; text: string }[], replaced: number): ChatAttachmentRecord[] {
  const kept = existing?.messages ?? [];
  if (replaced && !files.length) return kept.at(-replaced)?.attachments ?? [];
  const taken = kept.slice(0, kept.length - replaced).flatMap((m) => (m.attachments ?? []).map((a) => a.name));
  return files.map((file) => {
    const read = readCsvAttachment(file.text);
    if (!read.ok) refuse(read.problem === "empty" ? "invalid" : "tooLarge", `The file ${cleanAttachmentName(file.name)} can't be attached (${read.problem})`);
    const name = uniqueAttachmentName(taken, cleanAttachmentName(file.name));
    taken.push(name);
    return { kind: "csv", name, ...read.table };
  });
}

/**
 * The conversation's files for the model, newest first while there is room: each with its header
 * and as many rows as fit its share, saying when some are left out (read_attachment reads them).
 */
function filesPrompt(files: ChatAttachmentRecord[], room: number): string {
  const blocks: string[] = [];
  let left = room;
  for (const [i, file] of [...files].reverse().entries()) {
    const share = Math.floor(left / (files.length - i));
    if (share < 300) break;
    const { text, shown } = attachmentCsv(file, { maxChars: share - 200 });
    const note = shown < file.rows.length ? `only the first ${shown} of its ${file.rows.length} rows are here: read_attachment reads the others` : undefined;
    const block = attachmentBlock(file, text, note);
    blocks.unshift(block);
    left -= block.length;
  }
  return blocks.join("\n");
}

/**
 * The records the last question and its answer take (2), to be asked again; refused when there is
 * none, or when that answer changed things (asking again would make them twice).
 */
function lastTurn(existing: typeof aiConversation.$inferSelect | null): number {
  const [question, answer] = existing?.messages.slice(-2) ?? [];
  if (question?.role !== "user" || answer?.role !== "assistant") refuse("invalid", "There is no answer to ask again");
  if (answer.steps?.some(changedThings)) refuse("invalid", "An answer that changed things can't be asked again");
  return 2;
}

async function* runChat(
  userId: string,
  workspaceId: string,
  message: string,
  {
    scope,
    skill,
    existing,
    mode: initialMode,
    replaced,
    connections,
    memoryChanges,
    timeZone,
    attachments,
  }: {
    scope: { id: string; title: string } | null;
    skill: ChatSkill | null;
    existing: typeof aiConversation.$inferSelect | null;
    mode: ChatMode;
    /** Records at the end of the conversation the new turn replaces. */
    replaced: number;
    /** The connections' tools allowed the chat are offered (not to guests). */
    connections: boolean;
    /** Notes about the person may be kept or dropped (not where a connected app may only read). */
    memoryChanges: boolean;
    /** The person's time zone, for what today is. */
    timeZone: string;
    /** The question's own files (read and named). */
    attachments: ChatAttachmentRecord[];
  },
  signal?: AbortSignal,
): AsyncGenerator<ChatEvent> {
  const ctx: ops.OperationContext = { userId, actor: { userId } };
  // "Don't ask again" makes the rest of this answer `auto`.
  let mode = initialMode;
  // Keeping notes about the person changes nothing in the workspace: it's offered in every mode,
  // and asked about unless the mode is `auto` (a read-only chat asks too), while both the person and
  // the workspace have the memory on.
  const remembers = memoryChanges && (await memoryOn(userId, workspaceId));
  // Tools of connections that change something are left out of a read-only chat.
  const external = connections ? await chatToolset(workspaceId, { writes: mode !== "read" }) : null;
  const services = [...new Set([...(external?.byName.values() ?? [])].map((e) => e.connection.name))];
  // The files of the whole conversation: questions asked later still see what was attached before.
  const earlierFiles = (existing?.messages.slice(0, existing.messages.length - replaced) ?? []).flatMap((m) => m.attachments ?? []);
  const files = [...earlierFiles, ...attachments];
  const extra = { attachments: files, timeZone };
  const fileTools = files.length ? [...ATTACHMENT_TOOLS, ...(mode === "read" ? [] : ATTACHMENT_WRITE_TOOLS)] : [];
  const tools = [...CHAT_TOOLS, ...(mode === "read" ? [] : WRITE_TOOLS), ...fileTools, ...(remembers ? MEMORY_TOOLS : []), ...(external?.tools ?? [])];
  const writeTools = new Set([...WRITE_TOOL_NAMES, ...ATTACHMENT_WRITE_TOOL_NAMES]);
  const system = chatSystemPrompt(scope ? pageLabel(scope.title) : null, mode !== "read", skill ? pageLabel(skill.title) : null, remembers, services, files.length > 0);
  const toolsSize = tools.reduce((n, t) => n + t.description.length + JSON.stringify(t.parameters).length, 0);
  // What the model takes, less what every turn sends: the history, the map, memory and tool results
  // share the rest.
  const budget = await promptRoomFor(workspaceId);
  const room = () => Math.max(0, budget - system.length - toolsSize - 200);

  const conversation =
    existing ??
    (
      await db
        .insert(aiConversation)
        .values({ userId, workspaceId, title: conversationTitle(message || attachments.map((a) => a.name).join(", ")), messages: [] })
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
  /** Asks the person about a change or note, pinging while the answer waits; their decision. */
  async function* decide(action: ChatActionView): AsyncGenerator<ChatEvent, ChatDecision | "timeout"> {
    const waiting = awaitDecision(userId, signal);
    yield { type: "approval", id: waiting.id, action };
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const next = await Promise.race([waiting.decision, new Promise<"ping">((r) => (timer = setTimeout(() => r("ping"), PING_MS)))]);
      clearTimeout(timer);
      if (next !== "ping") return next;
      yield { type: "ping" };
    }
  }
  /**
   * Calls a connection's tool. One that changes something there is asked about first, in every
   * mode and each time ("don't ask again" doesn't cover it): what it sends comes from the model.
   */
  async function* callConnection(entry: ConnectionToolEntry, args: Record<string, unknown>, left: number): AsyncGenerator<ChatEvent, ToolOutcome> {
    const { connection: conn, tool } = entry;
    const writes = tool.kind === "write";
    const record = (outcome: ChatConnectionRecord["outcome"]): ChatConnectionRecord => ({
      kind: "connection",
      connectionId: conn.id,
      connection: conn.name,
      tool: tool.name,
      writes,
      input: inputSummary(args),
      outcome,
    });
    if (left <= 200) return { content: "There's no room left in this answer for more from connected services: answer with what you have.", isError: true };
    if (writes) {
      const action: ChatActionView = { action: "connection", connection: { name: conn.name, icon: conn.icon }, target: null, title: tool.title || tool.name, changes: [], content: inputSummary(args, 2_000) };
      const decision = yield* decide(action);
      if (decision === "decline" || decision === "timeout") {
        return {
          content:
            decision === "timeout"
              ? "The person didn't answer in time, so the call wasn't sent. Say what you would have done."
              : "The person declined this call: it wasn't sent. Don't try it again; say what you would have done, or ask what they want instead.",
          step: record("declined"),
        };
      }
      const now = await chatToolNow(entry);
      if (!now) return { content: "This tool is no longer allowed in the chat, so the call wasn't sent. Say what you would have done.", isError: true, step: record("declined") };
      entry = now;
    }
    const out = await runConnectionTool({ entry, args, actorId: userId, chat: true, approvedBy: writes ? userId : null, room: left, signal });
    return { content: out.content, isError: out.isError, step: record(out.step.outcome === "done" ? "done" : "failed") };
  }
  // Notes the answer asked again kept or dropped: they stay done, so they go with the new answer
  // (shown first), not with the records it replaces.
  const carried = replaced ? (existing?.messages.at(-1)?.steps ?? []).filter((s) => s.kind === "memory" && s.outcome !== "declined") : [];
  for (const record of carried) yield { type: "step", step: await viewStep(userId, record) };
  let answer = "";
  let stopReason: "stop" | "length" = "stop";
  let failure: AiErrorCode | null = null;
  try {
    // ---------------------------------------------------------------------------- the question
    // Nothing is searched for the model: it gets the map of what there is and decides itself.
    const earlier = existing?.messages.slice(0, existing.messages.length - replaced) ?? [];
    const history: AiMessage[] = chatHistory(earlier, Math.floor(room() * HISTORY_SHARE));
    const memory = remembers ? await memoryForPrompt(userId, workspaceId, Math.floor(room() * MEMORY_SHARE)) : { text: "", count: 0 };
    const filesText = files.length ? filesPrompt(files, Math.floor(room() * FILES_SHARE)) : "";
    const mapRoom = Math.min(MAP_CHARS, room() - sizeOf(history) - message.length - (skill?.body.length ?? 0) - memory.text.length - filesText.length - 2_000);
    const map = mapRoom >= 500 ? await workspaceMap(ctx, workspaceId, scope?.id ?? null, mapRoom) : "";
    // A question that is only a file asks about the file.
    const asked = message || "(The person attached the file without a question: say briefly what it holds and what you could do with it.)";
    const question: AiMessage = { role: "user", content: chatQuestionPrompt(asked, map, skill?.body, memory.text, { now: new Date(), timeZone }, filesText) };
    const messages: AiMessage[] = [...history, question];
    // When the model finds it all too long: old tool results go first (it can call the tool again),
    // then the earlier conversation. False when there's nothing left to drop.
    const makeRoom = () => {
      if (dropOldToolResults(messages) > 0) return true;
      const earlier = messages.indexOf(question);
      if (earlier > 0) messages.splice(0, earlier);
      return earlier > 0;
    };
    let roomMade = 0;

    // ------------------------------------------------------------------------------ model turns
    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (round > 0) {
        const wait = takeWorkspaceCapacity(workspaceId);
        if (wait > 0) throw new AiError("rateLimited", "The workspace's AI allowance is used up for now", wait);
      }
      const last = round === MAX_ROUNDS - 1;
      yield { type: "thinking" };
      let streamed = "";
      let result: AiResult;
      try {
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
          thinkingEvents: true,
        });
        for await (const event of turn) {
          // The model's thinking is shown as it comes, and not kept.
          if (event.type === "thinking") {
            yield { type: "reasoning", text: event.delta };
            continue;
          }
          streamed += event.delta;
          answer = streamed;
          yield { type: "text", text: event.delta };
        }
        result = await turn.result();
      } catch (error) {
        // Too long for the model: the same turn is asked again with room made, twice at most.
        if (isAiError(error) && error.code === "tooLarge" && !streamed && roomMade < 2 && makeRoom()) {
          roomMade += 1;
          round -= 1;
          continue;
        }
        throw error;
      }
      if (!result.toolCalls.length || last) {
        answer = result.text;
        stopReason = result.stopReason === "length" ? "length" : "stop";
        break;
      }
      // Text before a tool call is the model thinking aloud, not the answer: it's kept as a step.
      if (streamed) yield { type: "reset" };
      const thought = thoughtText(streamed);
      if (thought) yield await step({ kind: "thought", text: thought.length > THOUGHT_CHARS ? `${thought.slice(0, THOUGHT_CHARS - 1).trimEnd()}…` : thought });
      answer = "";
      messages.push(result.message);
      const answerNext = round === MAX_ROUNDS - 2;
      for (const call of result.toolCalls) {
        const left = room() - sizeOf(messages) - 300;
        let out: ToolOutcome;
        const entry = external?.byName.get(call.name);
        if (entry) out = yield* callConnection(entry, call.arguments, left);
        // With the memory off, remember and forget aren't offered: called anyway, they're unknown.
        else if (remembers && MEMORY_TOOL_NAMES.has(call.name)) {
          // Text the model read could pass itself off as a lasting note: the person approves each.
          const prepared = await prepareMemory(userId, workspaceId, call);
          let decision: ChatDecision | "timeout" = "approve";
          if ("action" in prepared && mode !== "auto") decision = yield* decide(prepared.action);
          out = "action" in prepared ? await applyMemory(userId, workspaceId, conversation.id, prepared, decision) : prepared;
        } else if (!writeTools.has(call.name)) out = await runTool(ctx, workspaceId, scope?.id, call, registry, left, extra);
        else if (mode === "read") out = { content: "Changes are off in this chat: say what you would change instead.", isError: true };
        else {
          const prepared = await prepareWrite(ctx, workspaceId, scope?.id ?? null, call, extra);
          let decision: ChatDecision | "timeout" = "approve";
          if ("action" in prepared && mode === "ask") {
            decision = yield* decide(prepared.action);
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
  // Changes made and notes kept or dropped are kept in the conversation, also when the answer
  // didn't come.
  const changed = steps.some((s) => changedThings(s) || (s.kind === "memory" && changedMemory(s)));
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
        {
          role: "user",
          content: message,
          ...(skill ? { skill: { id: skill.id, title: skill.title } } : {}),
          ...(attachments.length ? { attachments } : {}),
          at: now,
        },
        { role: "assistant", content: answer, sources: refs, ...(note ? { note } : {}), steps: [...carried, ...steps], ms, at: now },
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
  // Verified as of now, not when the answer was written.
  const verified = await activeVerifications([...visible.keys()]);
  return refs.map((r) => {
    const seen = visible.get(r.pageId);
    return seen
      ? { n: r.n, pageId: r.pageId, workspaceId: seen.workspaceId, title: seen.title, icon: seen.icon, kind: seen.kind, blockId: r.blockId, verified: verified.has(r.pageId) }
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
        ...(m.skill ? { skill: m.skill } : {}),
        ...(m.attachments?.length ? { attachments: m.attachments.map((a) => ({ name: a.name, rows: a.rows.length, columns: a.headers.length })) } : {}),
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

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
 *    `update_row`, `create_page`, `edit_page`, `create_pdf`, `create_docx`, `create_xlsx`,
 *    `add_comment`, `create_database`, `create_form`, with their access checked): in mode `ask` the answer waits
 *    for the person to approve each change (assistant/chat-dispatch.ts, ai-chat-approvals.ts), in `auto` it doesn't; asked
 *    through a connected app (the Telegram bot, server/telegram) in a workspace that lets apps only
 *    read, the mode is `read` and no notes are kept or dropped;
 * 5. in every mode, may make it keep or drop notes about the person (`remember`, `forget`): what
 *    it remembers goes with their later questions in the workspace (ai-memory.ts), unless the
 *    person or the workspace's owners turned the memory off;
 * 6. for members (not guests), may make it call the tools of the workspace's connections that its
 *    owners allowed the chat (server/connections): they run with the connection's credentials,
 *    their answers reach the model framed as outside data, and one that changes something there
 *    waits for the person's approval each time, in every mode (and isn't offered in `read`); once
 *    a service answered, every change and note is asked about for the rest of the answer, also in
 *    `auto`, as after reading the web;
 * 7. where the workspace's owners turned web search on, may make it search the web and read web
 *    pages (ai-chat-web.ts), read-only: what a call carries leaves the workspace, so each waits for
 *    the person's approval, in every mode, showing the address or the words (lib/web-calls.ts),
 *    except a read of an address they wrote in the conversation; once it read from the web, every
 *    change and note is asked about for the rest of the answer, also in `auto`;
 * 8. carries the files attached to its questions (ai-chat-files.ts) with the conversation: every
 *    later question sends their text again (a CSV file as a table), cut to fit, with
 *    `read_attachment` to read further and `create_database_from_csv` to import a CSV file; images
 *    go to models that take them, with their own question only;
 * 9. streams the answer; citations ([n]) link to the pages (and the block a passage starts at), or
 *    to the web pages read.
 *
 * A question may pick the model that answers it (one of those the workspace's AI offers the chat,
 * kept with the conversation; a new one starts with the person's latest) and how much it thinks
 * (kept the same way), and may be only files. In
 * research mode it plans sub-questions, searches and reads (the web too, where on) and writes a
 * long cited report, with read-only tools, more turns and a token budget of its own.
 *
 * Conversations are kept per person (ai_conversation) and only ever shown to them; cited pages are
 * looked up again with their current access whenever a conversation is shown.
 */
import { and, desc, eq, inArray, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  agentRun,
  aiConversation,
  type AgentRunState,
  type ChatAttachmentRecord,
  type ChatMessageRecord,
  type ChatSourceRef,
  type ChatStepRecord,
} from "@/db/schema";
import { readEmail, type AssistantRunSource } from "@/lib/agents";
import { redactValue } from "@/lib/redact";
import type { AiErrorCode } from "@/lib/ai";
import {
  changedMemory,
  changedThings,
  citedNumbers,
  conversationTitle,
  isChatThinking,
  MAX_CONVERSATIONS,
  reportMarkdown,
  type ChatOptions,
  type ChatActionView,
  type ChatEvent,
  type ChatMessageView,
  type ChatMode,
  type ChatPageView,
  type ChatScope,
  type ChatScopeView,
  type ChatSourceView,
  type ChatStepView,
  type ChatThinking,
  type ConversationSummary,
  thoughtText,
} from "@/lib/ai-chat";
import { attachmentCsv } from "@/lib/chat-attachment-table";
import { CHAT_FILE_LIMITS, chatFileKind, chatFileUrl, type ChatAttachmentView } from "@/lib/chat-attachments";
import { pageLabel } from "@/lib/labels";
import { createPage } from "@/server/pages";
import { AccessError, connectedAppHold, isGuest, requireMembership, requirePageAccess, WorkspacePolicyError } from "@/server/access";
import { asWrite, connectedAppCall, runAsConnectedApp } from "@/server/connected-app";
import {
  AiError,
  aiConfig,
  chatModelsFor,
  IMAGE_CHARS,
  isAiError,
  promptRoomFor,
  stream,
  takeRateLimit,
  takeWorkspaceCapacity,
  type AiMessage,
  type AiResult,
  type AiToolCall,
  type AiRequest,
  type ChatModelOption,
} from "@/server/ai";
import { setTimeout as sleep } from "node:timers/promises";
import { dropOldToolResults, roomToRead } from "@/server/ai/compact";
import { browserTimeZone, isTimeZone } from "@/lib/time-zone";
import { attachmentBlock, chatHistory, chatQuestionPrompt, chatSystemPrompt, researchSystemPrompt } from "@/server/ai/prompts";
import { ANSWER_NOW, isLastTurn, refuseLastCalls } from "@/server/ai/turns";
import { attachmentRecords, deleteConversationFiles, keepQuestionFiles, questionFiles, readConversationFiles, type ChatFileContent } from "@/server/ai-chat-files";
import { chatMailToolset } from "@/server/ai-chat-mail";
import { chatWebOn, chatWebToolset, PLAN_TOOL } from "@/server/ai-chat-web";
import type { FileRow } from "@/server/files";
import { getSkillContent, SkillError } from "@/server/skills";
import { teamspaceLabel } from "@/server/teamspaces";
import { aiAvailable } from "@/server/ai-writing";
import { memoryForPrompt, memoryOn, MEMORY_TOOLS } from "@/server/ai-memory";
import { remindTool } from "@/server/ai-reminders";
import { awaitDecision, runsWaitingHere, type ChatDecision } from "@/server/ai-chat-approvals";
import { answeringIn, conversationBusy, runningIn, stopRunsIn } from "@/server/ai-chat-runs";
import { FIND_TOOLS, lazyMoreTools, USE_TOOL } from "@/server/ai-more-tools";
import { chatToolset } from "@/server/connections/tools";
import { createChatDispatch, type ResolvedScope } from "@/server/assistant/chat-dispatch";
import { kickAgents } from "@/server/agents/kick";
import * as ops from "@/server/operations";
import { activeVerifications } from "@/server/verification";
import { ATTACHMENT_TOOLS, ATTACHMENT_WRITE_TOOLS, CHAT_TOOLS, MAP_CHARS, visiblePages, workspaceMap, WRITE_TOOLS, type Registry } from "@/server/ai-tools";

/** The most of what the model says before a search or read that is kept as a step. */
const THOUGHT_CHARS = 300;
/** Share of the prompt that earlier questions and answers may take, and what the chat remembers. */
const HISTORY_SHARE = 0.25;
const MEMORY_SHARE = 0.2;
/** How often a stream waiting on the person's decision sends a ping. */
const PING_MS = 20_000;
/** How often an answer under way says so, well within the worker's STALE_MS (server/agents/run.ts). */
const HEARTBEAT_MS = 60_000;
/** Times the worker may take an answer up again before it is given up. */
const MAX_RESUMES = 10;
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
  /**
   * The model to answer with, one of chatModelsFor's: else the conversation's, else (a new one) the
   * person's latest conversation's, else the workspace's main model.
   */
  model?: string | null;
  /**
   * How much the model thinks (models that think): else the conversation's, else (a new one) the
   * person's latest conversation's, else `balanced`. Research thinks as it does regardless.
   */
  thinking?: ChatThinking | null;
  /**
   * Files the person attached (uploadChatFile), in order: not sent before, or sent in this
   * conversation. A question may be only files. Asked again without files, a question keeps those it had.
   */
  attachments?: string[] | null;
  /** Research mode: a plan, searches and reads, then a long cited report; nothing is changed. */
  research?: boolean;
  /** The person's choice: what the chat writes in page bodies goes in as the AI's suggested edits. */
  asSuggestions?: boolean;
};

/** Refusals before anything is sent: access problems look like missing things. */
function refuse(code: AiErrorCode, message: string): never {
  throw new AiError(code, message);
}

/** What a question keeps to, checked: a page of the workspace the person can open, or a teamspace of it they can see. */
async function chatScope(userId: string, workspaceId: string, scope: ChatScope | undefined): Promise<ResolvedScope | null> {
  if (!scope) return null;
  if ("teamspaceId" in scope) {
    const found = await teamspaceLabel(userId, scope.teamspaceId);
    if (!found || found.workspaceId !== workspaceId) refuse("noAccess", "Teamspace not found");
    return { kind: "teamspace", id: found.id, title: found.name };
  }
  const found = await requirePageAccess(userId, scope.pageId, "view").catch((error) => {
    if (error instanceof AccessError && !(error instanceof WorkspacePolicyError)) refuse("noAccess", "Page not found");
    throw error;
  });
  if (found.workspaceId !== workspaceId || found.archivedAt || found.inTemplate) refuse("noAccess", "Page not found");
  return { kind: "page", id: found.id, title: found.title };
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

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Characters a list of messages takes in a prompt (as the AI layer counts them). */
const sizeOf = (messages: AiMessage[]) => messages.reduce((n, m) => n + m.content.length, 0);

/**
 * Starts answering a question. Checks and limits run first and throw AiError (nothing is sent
 * then); the returned events stream the work. The answer is a run of its own (`agent_run`, source
 * `assistant`), kept as it goes: one parked for the person's decision waits here for it, and one
 * a server that stopped left behind is taken up again by the agents' worker (resumeChatRun).
 * `signal` cancels it: what was written so far is kept in the conversation, marked as stopped. The
 * chat's route runs it apart from its request (ai-chat-runs.ts), so only Stop cancels it there.
 */
export async function startChat(userId: string, input: ChatInput, signal?: AbortSignal): Promise<AsyncIterable<ChatEvent>> {
  const message = input.message.trim();
  const attached = input.attachments ?? [];
  if (!message && !attached.length) refuse("invalid", "Ask a question");
  if (attached.length > CHAT_FILE_LIMITS.perQuestion) refuse("invalid", `A question can attach at most ${CHAT_FILE_LIMITS.perQuestion} files`);
  const membership = await requireMembership(userId, input.workspaceId).catch((error) => {
    if (error instanceof AccessError && !(error instanceof WorkspacePolicyError)) refuse("noAccess", "Workspace not found");
    throw error;
  });
  if (!(await aiAvailable(input.workspaceId))) refuse("disabled", "AI is off for this workspace");
  const existing = input.conversationId ? await ownConversation(userId, input.workspaceId, input.conversationId) : null;
  const model = await pickModel(userId, input.workspaceId, input.model ?? existing?.model ?? (existing ? null : await latestModel(userId, input.workspaceId)));
  const thinking = isChatThinking(input.thinking) ? input.thinking : existing ? (existing.thinking ?? "balanced") : await latestThinking(userId, input.workspaceId);
  const feature = input.research ? "chat.research" : "chat";
  // A question is as long as the model's context window takes; nothing else bounds it.
  if (message.length > (await promptRoomFor(input.workspaceId, feature, model?.id))) refuse("tooLarge", "The question is longer than the model takes");
  const scope = await chatScope(userId, input.workspaceId, input.scope);
  const skill = input.skillId ? await chatSkill(userId, input.workspaceId, input.skillId) : null;
  const replaced = input.replaceLast ? lastTurn(existing) : 0;
  const files = await askedFiles(userId, input.workspaceId, existing, attached, replaced);
  // The chat box says so before sending; an image the model can't see is never sent.
  if (files.records.some((f) => chatFileKind(f.contentType, f.name) === "image") && !model?.images) refuse("invalid", "This model doesn't take images");
  takeRateLimit({ userId, workspaceId: input.workspaceId });
  // Asked through a connected app (the Telegram bot) where the workspace lets apps only read:
  // nothing is changed, notes about the person included.
  const appReadOnly = (await asWrite(() => connectedAppHold(userId, input.workspaceId))) === "readOnly";
  const timeZone = isTimeZone(input.timeZone) ? input.timeZone : browserTimeZone();
  // An answer a server that stopped left waiting on the person: no one can answer it now.
  if (existing) await dropLeftBehind(userId, existing.id);
  const conversation =
    existing ??
    (
      await db
        .insert(aiConversation)
        .values({ userId, workspaceId: input.workspaceId, title: conversationTitle(message || files.records.map((a) => a.name).join(", ")), model: model?.id ?? null, thinking, messages: [] })
        .returning()
    )[0];
  const source: AssistantRunSource = {
    kind: "assistant",
    userId,
    conversationId: conversation.id,
    scope: scope ? (scope.kind === "page" ? { pageId: scope.id } : { teamspaceId: scope.id }) : null,
    skillId: skill?.id ?? null,
    model: model?.id ?? null,
    thinking,
    // Research only reads.
    mode: appReadOnly || input.research ? "read" : (input.mode ?? "ask"),
    timeZone,
    ...(input.research ? { research: true as const } : {}),
    ...(input.asSuggestions ? { asSuggestions: true as const } : {}),
    ...(connectedAppCall(userId) ? { fromApp: true as const } : {}),
    ...(appReadOnly ? { appReadOnly: true as const } : {}),
    files: files.records,
    replaced,
    ...(existing ? {} : { started: true as const }),
  };
  const [run] = await db
    .insert(agentRun)
    .values({ agentId: null, workspaceId: input.workspaceId, source, context: { actorId: userId, timeZone }, prompt: message, status: "running", attempts: 1, startedAt: new Date() })
    .returning();
  const setup: ChatSetup = { scope, skill, conversation, connections: !isGuest(membership.role), files, web: await chatWebOn(input.workspaceId) };
  return converseChat({ ...run, source }, setup, signal, true);
}

/** The model a question asks for, when the workspace's AI offers it; else its main model (null without AI). */
async function pickModel(userId: string, workspaceId: string, wanted: string | null): Promise<ChatModelOption | null> {
  const offered = await chatModelsFor(workspaceId);
  return offered.find((m) => m.id === wanted) ?? offered[0] ?? null;
}

/** The model of the person's latest conversation in the workspace that names one. */
async function latestModel(userId: string, workspaceId: string): Promise<string | null> {
  const [row] = await db
    .select({ model: aiConversation.model })
    .from(aiConversation)
    .where(and(eq(aiConversation.userId, userId), eq(aiConversation.workspaceId, workspaceId), isNotNull(aiConversation.model)))
    .orderBy(desc(aiConversation.updatedAt))
    .limit(1);
  return row?.model ?? null;
}

/** How much the person's latest conversation in the workspace that says so thinks; `balanced` without one. */
async function latestThinking(userId: string, workspaceId: string): Promise<ChatThinking> {
  const [row] = await db
    .select({ thinking: aiConversation.thinking })
    .from(aiConversation)
    .where(and(eq(aiConversation.userId, userId), eq(aiConversation.workspaceId, workspaceId), isNotNull(aiConversation.thinking)))
    .orderBy(desc(aiConversation.updatedAt))
    .limit(1);
  return isChatThinking(row?.thinking) ? row.thinking : "balanced";
}

/**
 * What the chat box offers the person in the workspace (see ChatOptions): the models, the one and
 * the thinking a new conversation starts with, and whether the chat searches the web there.
 */
export async function chatOptionsFor(userId: string, workspaceId: string): Promise<ChatOptions> {
  const [models, latest, defaultThinking, webSearch] = await Promise.all([
    chatModelsFor(workspaceId),
    latestModel(userId, workspaceId),
    latestThinking(userId, workspaceId),
    chatWebOn(workspaceId),
  ]);
  return { models, defaultModel: models.find((m) => m.id === latest)?.id ?? models[0]?.id ?? null, defaultThinking, webSearch };
}

/**
 * What each choice asks of the AI layer: `fast` as little thinking as the model allows, `balanced`
 * the chat feature's own (features.ts), `deep` the model's own default.
 */
const THINKING_LEVELS: Record<ChatThinking, AiRequest["thinking"]> = { fast: "off", balanced: undefined, deep: "model" };

/**
 * The question's files: the person's own, not sent yet or sent before in this conversation, named
 * apart from the conversation's other files. Asked again without files, a question keeps those it
 * had (those still there).
 */
async function askedFiles(
  userId: string,
  workspaceId: string,
  existing: typeof aiConversation.$inferSelect | null,
  ids: string[],
  replaced: number,
): Promise<{ records: ChatAttachmentRecord[]; rows: FileRow[] }> {
  const kept = existing?.messages ?? [];
  if (replaced && !ids.length) {
    const records = kept.at(-replaced)?.attachments ?? [];
    const rows = (await questionFiles(userId, workspaceId, existing?.id ?? null, records.map((r) => r.id), { all: false })) ?? [];
    const there = new Set(rows.map((r) => r.id));
    return { records: records.filter((r) => there.has(r.id)), rows };
  }
  const rows = await questionFiles(userId, workspaceId, existing?.id ?? null, ids);
  if (!rows) refuse("noAccess", "File not found");
  const taken = kept.slice(0, kept.length - replaced).flatMap((m) => (m.attachments ?? []).map((a) => a.name));
  const records = await attachmentRecords(rows, taken);
  if (!records) refuse("invalid", "An attached file can't be read");
  return { records, rows };
}

/**
 * The conversation's files for the model, newest first while there is room: each CSV file with its
 * header and as many rows as fit its share, each document with as much of its text, saying when
 * some is left out (read_attachment reads on); then the question's images and what couldn't be read.
 */
function filesPrompt(files: { contents: ChatFileContent[]; imageNames: string[]; unread: string[] }, room: number): string {
  const blocks: string[] = [];
  let left = room;
  for (const [i, file] of [...files.contents].reverse().entries()) {
    const share = Math.floor(left / (files.contents.length - i));
    if (share < 300) break;
    let block: string;
    if (file.kind === "csv") {
      const { text, shown } = attachmentCsv(file, { maxChars: share - 200 });
      const note = shown < file.rows.length ? `only the first ${shown} of its ${file.rows.length} rows are here: read_attachment reads the others` : undefined;
      block = attachmentBlock(file, text, note);
    } else {
      const cut = file.text.length > share - 200;
      const text = cut ? file.text.slice(0, share - 200) : file.text;
      const note = cut ? `only its first ${text.length} characters are here: read_attachment reads on` : file.partial ? "only the start of a long document was read" : undefined;
      block = attachmentBlock(file, text, note);
    }
    blocks.unshift(block);
    left -= block.length;
  }
  if (files.imageNames.length) blocks.push(`The images attached to the question (${files.imageNames.map((n) => `"${n.replace(/["\n]/g, " ")}"`).join(", ")}) come with it.`);
  if (files.unread.length) blocks.push(`These attached files have nothing that could be read (a scan, a damaged or locked file): ${files.unread.map((n) => `"${n.replace(/["\n]/g, " ")}"`).join(", ")}.`);
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

/** A run of a person's own AI chat. */
type AssistantRun = typeof agentRun.$inferSelect & { source: AssistantRunSource };

/** What an answer works with besides its run, checked as it (re)starts. */
type ChatSetup = {
  scope: ResolvedScope | null;
  skill: ChatSkill | null;
  conversation: typeof aiConversation.$inferSelect;
  /** The connections' tools allowed the chat are offered (not to guests). */
  connections: boolean;
  /** The question's own files: their records (named apart from the conversation's others) and rows. */
  files: { records: ChatAttachmentRecord[]; rows: FileRow[] };
  /** The chat may search the web and read web pages. */
  web: boolean;
};

/**
 * The answer's turns with the model, from the start or from where its run left off (`run.state`).
 * `here`: someone in this process follows it, so a change it asks about waits here for the
 * person's decision; without (the worker), the run is left parked and the generator ends.
 */
async function* converseChat(run: AssistantRun, setup: ChatSetup, signal: AbortSignal | undefined, here: boolean): AsyncGenerator<ChatEvent> {
  const { source } = run;
  const { userId, timeZone, thinking, replaced } = source;
  const workspaceId = run.workspaceId;
  const research = source.research === true;
  const initialMode = source.mode;
  const model = source.model;
  const { scope, skill, conversation, files } = setup;
  const message = run.prompt;
  const saved = run.state?.chat ? run.state : null;
  const ctx: ops.OperationContext = { userId, actor: { userId, model: true, ...(source.asSuggestions ? { asSuggestions: true } : {}) }, timeZone };
  const promptScope = scope ? { kind: scope.kind, title: scope.kind === "page" ? pageLabel(scope.title) : scope.title } : null;
  const started = saved?.chat?.startedAt ?? Date.now();
  const scopeView: ChatScopeView | null = promptScope && scope ? { kind: scope.kind, id: scope.id, title: promptScope.title } : null;
  yield {
    type: "conversation",
    id: conversation.id,
    title: conversation.title,
    ...(scopeView ? { scope: scopeView } : {}),
    // For a page following the answer again (ai-chat-runs.ts): the turn is saved only at its end.
    question: {
      role: "user",
      content: message,
      ...(skill ? { skill: { id: skill.id, title: skill.title } } : {}),
      ...(scopeView ? { scope: scopeView } : {}),
      ...(files.records.length ? { attachments: files.records.map(attachmentView) } : {}),
      ...(research ? { research: true } : {}),
      at: new Date(started).toISOString(),
    },
    startedAt: started,
    ...(replaced ? { replaceLast: true } : {}),
  };

  const registry = registryOf((saved?.chat?.sources ?? []) as Registry["sources"]);
  const steps: ChatStepRecord[] = [...(saved?.chat?.steps ?? [])];
  const step = async (record: ChatStepRecord): Promise<ChatEvent> => {
    steps.push(record);
    return { type: "step", step: await viewStep(userId, record) };
  };
  const earlier = conversation.messages.slice(0, conversation.messages.length - replaced);
  // Notes the answer asked again kept or dropped: they stay done, so they go with the new answer
  // (shown first), not with the records it replaces.
  const carried = replaced ? (conversation.messages.at(-1)?.steps ?? []).filter((s) => s.kind === "memory" && s.outcome !== "declined") : [];
  if (!saved) for (const record of carried) yield { type: "step", step: await viewStep(userId, record) };
  // Leafdesk's further tools, started when the model first looks for one; a read-only chat gets
  // those that only read.
  const moreTools = lazyMoreTools(userId, { writes: initialMode !== "read" });
  let answer = "";
  let stopReason: "stop" | "length" = "stop";
  let failure: AiErrorCode | null = null;
  // The model that answered, and what the answer's turns cost.
  let answeredBy: string | null = saved?.chat?.answeredBy ?? null;
  let spentUsd = saved?.chat?.spentUsd ?? 0;
  const limitUsd = aiConfig().limits.runLimitUsd;
  // While it goes on, the worker doesn't take it as left behind (server/agents/run.ts STALE_MS).
  const heartbeat = setInterval(() => {
    db.update(agentRun)
      .set({ nextAt: new Date() })
      .where(and(eq(agentRun.id, run.id), eq(agentRun.status, "running")))
      .catch((error: unknown) => console.error("[ai] could not mark a chat run as under way", error));
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  try {
    // Keeping notes about the person changes nothing in the workspace: it's offered in every mode,
    // and asked about unless the mode is `auto` (a read-only chat asks too), while both the person and
    // the workspace have the memory on.
    // Research only reads: no changes, notes or other services.
    const remembers = !research && !source.appReadOnly && (await memoryOn(userId, workspaceId));
    // Tools of connections that change something are left out of a read-only chat.
    const external = setup.connections && !research ? await chatToolset(workspaceId, { writes: initialMode !== "read" }) : null;
    const services = [...new Set([...(external?.byName.values() ?? [])].map((e) => e.connection.name))];
    // The files of the whole conversation: questions asked later still see what was attached before.
    const earlierFiles = earlier.flatMap((m) => m.attachments ?? []);
    const read = await readConversationFiles(userId, workspaceId, conversation.id, earlierFiles, files);
    const extra = { attachments: read.contents, timeZone };
    const hasFiles = earlierFiles.length + files.records.length > 0;
    // Reading files is offered wherever there are some; a database of a CSV file only where changes are.
    const fileTools = read.contents.length ? [...ATTACHMENT_TOOLS, ...(initialMode === "read" || research || !read.contents.some((c) => c.kind === "csv") ? [] : ATTACHMENT_WRITE_TOOLS)] : [];
    const webTools = setup.web ? chatWebToolset() : [];
    // The person's own mail, where they may use the Mail tab; research only reads the workspace.
    const mailTools = research ? [] : await chatMailToolset(userId, workspaceId, { writes: initialMode !== "read" });
    // Reminding the person of something changes nothing in the workspace: offered in every mode but research.
    const tools = research
      ? [PLAN_TOOL, ...CHAT_TOOLS, ...fileTools, ...webTools]
      : [
          ...CHAT_TOOLS,
          ...(initialMode === "read" ? [] : WRITE_TOOLS),
          FIND_TOOLS,
          USE_TOOL,
          ...fileTools,
          ...(remembers ? MEMORY_TOOLS : []),
          remindTool(new Date(), timeZone, true),
          ...webTools,
          ...mailTools,
          ...(external?.tools ?? []),
        ];
    const skillTitle = skill ? pageLabel(skill.title) : null;
    const system = research
      ? researchSystemPrompt(promptScope, webTools.length > 0, skillTitle, hasFiles)
      : chatSystemPrompt(promptScope, initialMode !== "read", skillTitle, remembers, services, webTools.length > 0, hasFiles, mailTools.length > 0);
    const toolsSize = tools.reduce((n, t) => n + t.description.length + JSON.stringify(t.parameters).length, 0);
    const feature = research ? "chat.research" : "chat";
    // What the model takes, less what every turn sends: the history, the map, memory and tool results
    // share the rest.
    const budget = await promptRoomFor(workspaceId, feature, model);
    const room = () => Math.max(0, budget - system.length - toolsSize - 200);
    // What the person wrote in the conversation: a web page whose address they gave is read without asking.
    const typed = [message, ...earlier.filter((m) => m.role === "user").map((m) => m.content)];
    const dispatch = createChatDispatch({
      userId,
      workspaceId,
      conversationId: conversation.id,
      ctx,
      scope,
      registry,
      initialMode,
      mode: saved?.mode ?? initialMode,
      research,
      external,
      moreTools,
      web: webTools.length > 0,
      mailTools: new Set(mailTools.map((t) => t.name)),
      remembers,
      typed,
      timeZone,
      extra,
      steps,
      signal,
    });

    // ---------------------------------------------------------------------------- the question
    let messages: AiMessage[];
    let question: AiMessage;
    if (saved?.chat) {
      messages = saved.messages as AiMessage[];
      question = messages[saved.chat.question];
      // Images aren't kept with the run: read again with the files.
      if (read.images.length && question.role === "user") question.images = read.images;
    } else {
      // Nothing is searched for the model: it gets the map of what there is and decides itself.
      // Asked from a connected app (the Telegram bot), which gets no mail tools: nor what turns that read mail said.
      const history: AiMessage[] = chatHistory(source.fromApp ? withoutMailTurns(earlier) : earlier, Math.floor(room() * HISTORY_SHARE));
      const memory = remembers ? await memoryForPrompt(userId, workspaceId, Math.floor(room() * MEMORY_SHARE)) : { text: "", count: 0 };
      const filesText = hasFiles ? filesPrompt(read, Math.floor((room() - sizeOf(history) - message.length - memory.text.length) * FILES_SHARE)) : "";
      const imagesSize = read.images.length * IMAGE_CHARS;
      const mapRoom = Math.min(MAP_CHARS, room() - sizeOf(history) - message.length - (skill?.body.length ?? 0) - memory.text.length - filesText.length - imagesSize - 2_000);
      const map = mapRoom >= 500 ? await workspaceMap(ctx, workspaceId, scope, mapRoom) : "";
      // A question that is only files asks about the files.
      const asked = message || "(The person attached the files without a question: say briefly what they hold and what you could do with them.)";
      question = {
        role: "user",
        content: chatQuestionPrompt(asked, map, skill?.body, memory.text, { now: new Date(), timeZone }, filesText),
        ...(read.images.length ? { images: read.images } : {}),
      };
      messages = [...history, question];
    }
    // When the model finds it all too long: old tool results go first (it can call the tool again),
    // then the earlier conversation. False when there's nothing left to drop.
    const makeRoom = () => {
      if (dropOldToolResults(messages) > 0) return true;
      const earlierMessages = messages.indexOf(question);
      if (earlierMessages > 0) messages.splice(0, earlierMessages);
      return earlierMessages > 0;
    };
    let roomMade = 0;
    // The last turn called tools instead of answering: it's asked once more, with none run.
    let closing = false;
    // Turns with the model so far, and the calls of the latest still to answer (the first one, the
    // person decided on while the run was parked).
    let round = saved?.rounds ?? 0;
    let queue: AiToolCall[] = saved?.queue ?? [];
    let decided = (saved?.decision?.decision ?? null) as ChatDecision | null;

    /** Where the answer stands, for going on from there. */
    const snapshot = (): AgentRunState => ({
      // Images are read again with the files.
      messages: messages.map((m) => (m.role === "user" && m.images ? { ...m, images: undefined } : m)),
      queue: queue.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })),
      rounds: round,
      writes: 0,
      externalChars: 0,
      mode: dispatch.mode,
      chat: { question: messages.indexOf(question), sources: registry.sources, steps, spentUsd, answeredBy, startedAt: started },
    });
    /**
     * Asks the person about a change, a note or a web call: the run is parked with what it asks,
     * and waits here for their decision (pinging meanwhile), however long it takes. Null without
     * anyone here: the run stays parked until decideParkedChange.
     */
    async function* park(call: AiToolCall, action: ChatActionView): AsyncGenerator<ChatEvent, ChatDecision | null> {
      // Waiting before the run is parked: the person may answer as soon as they are asked.
      const waiting = here ? awaitDecision(userId, run.id, signal) : null;
      const id = waiting?.id ?? crypto.randomUUID();
      try {
        await db
          .update(agentRun)
          .set({
            status: "awaiting_approval",
            state: snapshot(),
            pending: { callId: call.id, connectionId: null, tool: call.name, arguments: redactValue(call.arguments), askedAt: new Date().toISOString(), action, askId: id },
            nextAt: new Date(),
          })
          .where(eq(agentRun.id, run.id));
        if (!waiting) return null;
        yield { type: "approval", id, action };
        let decision: ChatDecision;
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
        const [taken] = await db
          .update(agentRun)
          .set({ status: "running", pending: null, nextAt: new Date() })
          .where(and(eq(agentRun.id, run.id), eq(agentRun.status, "awaiting_approval")))
          .returning({ id: agentRun.id });
        // Gone meanwhile: its conversation was deleted.
        if (!taken) throw new AiError("aborted", "The answer was stopped");
        return decision;
      } finally {
        waiting?.cancel();
      }
    }
    /** Keeps where the answer stands after each call: a run taken up again doesn't make a change twice. */
    const checkpoint = () =>
      db
        .update(agentRun)
        .set({ state: snapshot(), nextAt: new Date() })
        .where(and(eq(agentRun.id, run.id), eq(agentRun.status, "running")));

    // ------------------------------------------------------------------------------ model turns
    // Turns go on until the model answers; the last (turns.ts) answers with what it has (research
    // writes its report). Each turn also counts against the workspace's rate and cost limits, and
    // the person can stop the answer.
    for (;;) {
      if (!queue.length) {
        // A long answer waits for the workspace's AI allowance rather than failing.
        for (let wait = round > 0 ? takeWorkspaceCapacity(workspaceId) : 0; wait > 0; wait = takeWorkspaceCapacity(workspaceId)) {
          yield { type: "ping" };
          try {
            await sleep(Math.min(wait, PING_MS), undefined, { signal });
          } catch {
            throw new AiError("aborted", "The answer was stopped");
          }
        }
        const last = isLastTurn(round, spentUsd, limitUsd);
        yield { type: "thinking" };
        let streamed = "";
        // Text shown since the last reset: once a tool call starts, it was the model thinking aloud.
        let shown = false;
        let result: AiResult;
        try {
          const turn = stream({
            feature,
            model,
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
            ...(research ? {} : { thinking: THINKING_LEVELS[thinking] }),
            thinkingEvents: true,
            toolEvents: true,
          });
          for await (const event of turn) {
            // The model's thinking is shown as it comes, and not kept.
            if (event.type === "thinking") {
              yield { type: "reasoning", text: event.delta };
              continue;
            }
            // Writing a tool call's arguments (rows to add) can take minutes: the page shows it works.
            if (event.type === "toolCall") {
              if (shown) yield { type: "reset" };
              shown = false;
              yield { type: "thinking" };
              continue;
            }
            streamed += event.delta;
            answer = streamed;
            shown = true;
            yield { type: "text", text: event.delta };
          }
          result = await turn.result();
        } catch (error) {
          // Too long for the model: the same turn is asked again with room made, twice at most.
          if (isAiError(error) && error.code === "tooLarge" && !streamed && roomMade < 2 && makeRoom()) {
            roomMade += 1;
            continue;
          }
          throw error;
        }
        answeredBy = result.model;
        spentUsd += result.usage.costUsd;
        if (last && result.toolCalls.length && !closing) {
          closing = true;
          if (shown) yield { type: "reset" };
          refuseLastCalls(messages, result);
          continue;
        }
        if (!result.toolCalls.length || last) {
          answer = result.text;
          stopReason = result.stopReason === "length" ? "length" : "stop";
          break;
        }
        // Text before a tool call is the model thinking aloud, not the answer: it's kept as a step.
        if (shown) yield { type: "reset" };
        const thought = thoughtText(streamed);
        if (thought) yield await step({ kind: "thought", text: thought.length > THOUGHT_CHARS ? `${thought.slice(0, THOUGHT_CHARS - 1).trimEnd()}…` : thought });
        answer = "";
        messages.push(result.message);
        queue = [...result.toolCalls];
        round += 1;
      }
      const answerNext = isLastTurn(round, spentUsd, limitUsd);
      while (queue.length) {
        const call = queue[0];
        const left = roomToRead(messages, () => room() - sizeOf(messages) - 300);
        let out = await dispatch.answer(call, decided, left);
        decided = null;
        while ("ask" in out) {
          const decision = yield* park(call, out.ask);
          // Parked for the person, with no one here to wait: the worker goes on once they decide.
          if (!decision) return;
          out = await dispatch.answer(call, decision, left);
        }
        // An image of the mail described by another model: counted against this answer's limit.
        if (out.usage) spentUsd += out.usage.costUsd;
        if (out.step) yield await step(out.step);
        const content = answerNext ? `${out.content}\n\n${ANSWER_NOW}` : out.content;
        messages.push({ role: "tool", toolCallId: call.id, name: call.name, content, isError: out.isError });
        queue.shift();
        await checkpoint();
      }
    }
    if (!answer.trim()) throw new AiError("empty", "The model gave no answer");
  } catch (error) {
    failure = isAiError(error) ? error.code : "provider";
    if (!isAiError(error)) console.error("[ai] chat failed", error);
  } finally {
    clearInterval(heartbeat);
    await moreTools.close();
  }

  // ------------------------------------------------------------------------------ the answer
  // Changes made and notes kept or dropped are kept in the conversation, also when the answer
  // didn't come.
  const changed = steps.some((s) => changedThings(s) || (s.kind === "memory" && changedMemory(s)));
  const stopped = failure === "aborted" && (answer.trim().length > 0 || changed);
  if (!failure || stopped || changed) {
    const cited = new Set(citedNumbers(answer));
    const refs: ChatSourceRef[] = registry.sources
      .filter((s) => cited.has(s.n))
      .map((s) => (s.url ? { n: s.n, url: s.url, title: s.title } : { n: s.n, pageId: s.pageId, blockId: s.blockId }));
    const sources = await viewSources(userId, refs);
    const now = new Date().toISOString();
    const note = stopped ? "stopped" : failure ? undefined : stopReason === "length" ? "cutOff" : undefined;
    const ms = Date.now() - started;
    const kept = files.records;
    // The turn and the run's end together: a run taken up again never answers on top of a kept turn.
    await db.transaction(async (tx) => {
      await saveTurn(
        tx,
        conversation.id,
        [
          {
            role: "user",
            content: message,
            ...(skill ? { skill: { id: skill.id, title: skill.title } } : {}),
            ...(scope ? { scope: { kind: scope.kind, id: scope.id } } : {}),
            ...(kept.length ? { attachments: kept } : {}),
            ...(research ? { research: true } : {}),
            at: now,
          },
          {
            role: "assistant",
            content: answer,
            sources: refs,
            ...(note ? { note } : {}),
            steps: [...carried, ...steps],
            ms,
            ...(research ? { research: true } : {}),
            ...(answeredBy ? { model: answeredBy } : {}),
            at: now,
          },
        ],
        replaced,
        model,
        thinking,
      );
      await tx.delete(agentRun).where(eq(agentRun.id, run.id));
    });
    // The answer ends as soon as its turn is saved: a page opening the conversation now finds the
    // turn there, and no answer on its way to follow again on top of it (ai-chat-runs.ts runningIn).
    yield { type: "sources", sources };
    if (!failure) yield { type: "done", stopReason, ms };
    else yield { type: "error", code: failure };
    // Kept with the question: they now go with the conversation.
    await keepQuestionFiles(conversation.id, kept.map((f) => f.id));
    await pruneConversations(userId, workspaceId);
    return;
  }
  // Nothing to keep: a conversation this question started goes again.
  await db.delete(agentRun).where(eq(agentRun.id, run.id));
  if (source.started) await db.delete(aiConversation).where(and(eq(aiConversation.id, conversation.id), sql`jsonb_array_length(${aiConversation.messages}) = 0`));
  yield { type: "error", code: failure };
}

/** The sources an answer may cite, as it left them (server/ai-tools.ts register). */
function registryOf(sources: Registry["sources"]): Registry {
  const byKey = new Map(sources.map((s) => [s.url ? `url:${s.url}` : `${s.pageId}#${s.blockId ?? ""}`, s.n] as const));
  return { sources: [...sources], byKey };
}

/**
 * Goes on with an answer of the person's that the agents' worker took (server/agents/run.ts):
 * after they decided on a change while no one waited for it here, or left running by a server that
 * stopped. Its checks run again, with the person's access as it is now; nothing follows it here,
 * so it is seen once its turn is kept.
 */
export async function resumeChatRun(run: AssistantRun): Promise<void> {
  const { source } = run;
  if (run.attempts > MAX_RESUMES) return void (await db.delete(agentRun).where(eq(agentRun.id, run.id)));
  const go = async () => {
    const setup = await resumeSetup(run).catch((error: unknown) => {
      if (isAiError(error) || error instanceof AccessError) return null;
      throw error;
    });
    // It can't go on (the person left the workspace, AI is off, the conversation is gone): nothing more is done.
    if (!setup) return void (await db.delete(agentRun).where(eq(agentRun.id, run.id)));
    const events = converseChat(run, setup, undefined, false);
    while (!(await events.next()).done);
  };
  // Asked through a connected app (the Telegram bot): held as it was then.
  await (source.fromApp ? runAsConnectedApp({ userId: source.userId }, go) : go());
}

/** What a run going on works with, checked again as startChat checks it. */
async function resumeSetup(run: AssistantRun): Promise<ChatSetup> {
  const { userId, conversationId } = run.source;
  const membership = await requireMembership(userId, run.workspaceId);
  if (!(await aiAvailable(run.workspaceId))) refuse("disabled", "AI is off for this workspace");
  const conversation = await ownConversation(userId, run.workspaceId, conversationId);
  const scope = run.source.scope ? await chatScope(userId, run.workspaceId, run.source.scope) : null;
  const skill = run.source.skillId ? await chatSkill(userId, run.workspaceId, run.source.skillId) : null;
  const rows = (await questionFiles(userId, run.workspaceId, conversationId, run.source.files.map((f) => f.id), { all: false })) ?? [];
  const there = new Set(rows.map((r) => r.id));
  return {
    scope,
    skill,
    conversation,
    connections: !isGuest(membership.role),
    files: { records: run.source.files.filter((f) => there.has(f.id)), rows },
    web: await chatWebOn(run.workspaceId),
  };
}

/**
 * Decides a change the person was asked about whose answer no one waits on in this process (the
 * server restarted meanwhile): its run goes on in the agents' worker. False when it isn't theirs
 * or no longer waits.
 */
export async function decideParkedChange(userId: string, approvalId: string, decision: ChatDecision): Promise<boolean> {
  const [found] = await db
    .update(agentRun)
    .set({
      status: "pending",
      pending: null,
      nextAt: new Date(),
      state: sql`jsonb_set(${agentRun.state}, '{decision}', ${JSON.stringify({ decision, userId })}::jsonb)`,
    })
    .where(
      and(
        isNull(agentRun.agentId),
        eq(agentRun.status, "awaiting_approval"),
        sql`${agentRun.pending}->>'askId' = ${approvalId}`,
        sql`${agentRun.source}->>'userId' = ${userId}`,
      ),
    )
    .returning({ id: agentRun.id });
  if (!found) return false;
  kickAgents();
  return true;
}

/** Answers of the person's in a conversation left waiting on them by a server that stopped: no one can answer them now. */
async function dropLeftBehind(userId: string, conversationId: string) {
  const waitingHere = [...runsWaitingHere()];
  await db
    .delete(agentRun)
    .where(
      and(
        isNull(agentRun.agentId),
        eq(agentRun.status, "awaiting_approval"),
        sql`${agentRun.source}->>'userId' = ${userId}`,
        sql`${agentRun.source}->>'conversationId' = ${conversationId}`,
        waitingHere.length ? notInArray(agentRun.id, waitingHere) : undefined,
      ),
    );
}

/**
 * Whether a conversation is still being answered, so a question asked there now would be saved
 * beside that answer: here (ai-chat-runs.ts conversationBusy), or by the agents' worker going on
 * with one after the person's decision or a restart.
 */
export async function answerUnderWay(userId: string, conversationId: string): Promise<boolean> {
  if (await conversationBusy(userId, conversationId)) return true;
  const [found] = await db
    .select({ id: agentRun.id })
    .from(agentRun)
    .where(
      and(
        isNull(agentRun.agentId),
        inArray(agentRun.status, ["pending", "running"]),
        sql`${agentRun.source}->>'userId' = ${userId}`,
        sql`${agentRun.source}->>'conversationId' = ${conversationId}`,
      ),
    )
    .limit(1);
  return Boolean(found);
}

// ---------------------------------------------------------------------------- conversations

/**
 * Adds a question and its answer to a conversation, in place of its last `replace` records;
 * `model` and `thinking`: what it now answers with.
 */
async function saveTurn(tx: Tx, conversationId: string, records: ChatMessageRecord[], replace: number, model: string | null, thinking: ChatThinking) {
  // Keeps the records before the replaced ones (a jsonb array's elements, in order).
  const kept = replace
    ? sql`coalesce((select jsonb_agg(e order by i) from jsonb_array_elements(${aiConversation.messages}) with ordinality as t(e, i) where i <= jsonb_array_length(${aiConversation.messages}) - ${replace}), '[]'::jsonb)`
    : sql`${aiConversation.messages}`;
  await tx
    .update(aiConversation)
    .set({ messages: sql`${kept} || ${JSON.stringify(records)}::jsonb`, model, thinking, updatedAt: new Date() })
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
  // A conversation being answered (an old one asked again, in another tab or from Telegram) stays:
  // its answer saves into it.
  const answering = [...answeringIn(userId, workspaceId)];
  const old = and(
    eq(aiConversation.userId, userId),
    eq(aiConversation.workspaceId, workspaceId),
    notInArray(aiConversation.id, [...keep.map((k) => k.id), ...answering]),
  );
  const gone = await db.select({ id: aiConversation.id }).from(aiConversation).where(old);
  if (!gone.length) return;
  await deleteConversationFiles(gone.map((c) => c.id));
  await db.delete(aiConversation).where(inArray(aiConversation.id, gone.map((c) => c.id)));
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
  // What a kept note said before a correction changed it stays with the run, for Undo.
  if (record.kind === "memory" && record.previous) return { ...record, previous: undefined };
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

/**
 * The scopes questions were asked in, by `kind:id`, titled as the person may see them now: a page
 * they can no longer open, or a teamspace they can no longer see, has no title.
 */
async function viewScopes(userId: string, scopes: NonNullable<ChatMessageRecord["scope"]>[]): Promise<Map<string, ChatScopeView>> {
  const pages = await visiblePages(userId, scopes.filter((s) => s.kind === "page").map((s) => s.id));
  const out = new Map<string, ChatScopeView>();
  for (const { kind, id } of scopes) {
    const key = `${kind}:${id}`;
    if (out.has(key)) continue;
    const title = kind === "page" ? (pages.has(id) ? pageLabel(pages.get(id)!.title) : null) : ((await teamspaceLabel(userId, id))?.name ?? null);
    out.set(key, { kind, id, title });
  }
  return out;
}

/** Cited pages as the person may see them now: pages they can't open lose id and title. */
export async function viewSources(userId: string, refs: ChatSourceRef[]): Promise<ChatSourceView[]> {
  const visible = await visiblePages(userId, refs.flatMap((r) => (r.pageId ? [r.pageId] : [])));
  // Verified as of now, not when the answer was written.
  const verified = await activeVerifications([...visible.keys()]);
  return refs.map((r) => {
    if (r.url !== undefined) return { n: r.n, pageId: null, workspaceId: null, title: r.title, icon: null, kind: null, blockId: null, url: r.url };
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
  const answering = answeringIn(userId, workspaceId);
  return rows.map((r) => ({ id: r.id, title: r.title, updatedAt: r.updatedAt.toISOString(), ...(answering.has(r.id) ? { answering: true as const } : {}) }));
}

/**
 * One of the person's conversations, with its sources as they may see them now; `run`: the id of
 * the answer on its way in it, to follow (`GET /api/ai/chat?run=`), whose turn isn't in it yet.
 */
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
  const scopes = await viewScopes(userId, found.messages.flatMap((m) => (m.scope ? [m.scope] : [])));
  let i = 0;
  const messages: ChatMessageView[] = await Promise.all(
    found.messages.map(async (m) => {
      const sources = m.sources?.map(() => views[i++]);
      const steps = m.steps ? await Promise.all(m.steps.map((s) => viewStep(userId, s, read))) : undefined;
      return {
        role: m.role,
        content: m.content,
        ...(m.skill ? { skill: m.skill } : {}),
        ...(m.scope ? { scope: scopes.get(`${m.scope.kind}:${m.scope.id}`) } : {}),
        ...(m.attachments ? { attachments: m.attachments.map(attachmentView) } : {}),
        ...(m.research ? { research: true } : {}),
        ...(m.model ? { model: m.model } : {}),
        ...(sources ? { sources } : {}),
        ...(m.note ? { note: m.note } : {}),
        ...(steps ? { steps } : {}),
        ...(m.ms !== undefined ? { ms: m.ms } : {}),
        at: m.at,
      };
    }),
  );
  return { id: found.id, title: found.title, model: found.model, thinking: found.thinking ?? "balanced", messages, run: runningIn(userId, found.id) };
}

const attachmentView = (a: ChatAttachmentRecord): ChatAttachmentView => ({ ...a, url: chatFileUrl(a.id) });

/**
 * Saves a research answer of the person's conversation (the message at `index`) as a new private
 * page at the top of the workspace, its citations links to the sources under `labels.sources`
 * (`labels.untitled`: the title without a question); returns the page's id.
 */
export async function saveReportAsPage(
  userId: string,
  workspaceId: string,
  conversationId: string,
  index: number,
  labels: { sources: string; untitled: string },
): Promise<{ pageId: string }> {
  await requireMembership(userId, workspaceId);
  const found = await ownConversation(userId, workspaceId, conversationId).catch(() => {
    throw new AccessError();
  });
  const message = found.messages[index];
  if (!message || message.role !== "assistant" || !message.research || !message.content.trim()) refuse("invalid", "There is no report to save");
  const markdown = reportMarkdown(message.content, await viewSources(userId, message.sources ?? []), labels.sources);
  const question = found.messages[index - 1];
  const title = conversationTitle(question?.role === "user" ? question.content : found.title) || labels.untitled;
  const made = await createPage({ userId }, { workspaceId, teamspaceId: null, title, markdown });
  return { pageId: made.id };
}

/** Deletes conversations of the person (only theirs), stopping answers on their way in them and dropping those parked there. */
export async function deleteConversations(userId: string, workspaceId: string, conversationIds: string[] | "all") {
  await requireMembership(userId, workspaceId);
  stopRunsIn(userId, workspaceId, conversationIds);
  const theirs = and(
    eq(aiConversation.userId, userId),
    eq(aiConversation.workspaceId, workspaceId),
    conversationIds === "all" ? undefined : inArray(aiConversation.id, conversationIds.length ? conversationIds : [""]),
  );
  // Their files go with them, from storage too.
  const gone = await db.select({ id: aiConversation.id }).from(aiConversation).where(theirs);
  await deleteConversationFiles(gone.map((c) => c.id));
  if (gone.length) {
    await db
      .delete(agentRun)
      .where(and(isNull(agentRun.agentId), sql`${agentRun.source}->>'userId' = ${userId}`, sql`${agentRun.source}->>'conversationId' in ${gone.map((c) => c.id)}`));
  }
  await db.delete(aiConversation).where(theirs);
}

/** A conversation's records less the turns whose answer read email (lib/agents.ts readEmail), question and answer alike. */
export function withoutMailTurns<T extends { role: "user" | "assistant"; steps?: { kind: string; action?: unknown }[] }>(records: T[]): T[] {
  const kept: T[] = [];
  for (let i = 0; i < records.length; i++) {
    const next = records[i + 1];
    if (records[i].role === "user" && next?.role === "assistant" && readEmail(next.steps)) {
      i++;
      continue;
    }
    if (records[i].role === "assistant" && readEmail(records[i].steps)) continue;
    kept.push(records[i]);
  }
  return kept;
}

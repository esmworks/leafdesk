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
 * kept with the conversation; a new one starts with the person's latest), and may be only files. In
 * research mode it plans sub-questions, searches and reads (the web too, where on) and writes a
 * long cited report, with read-only tools, more turns and a token budget of its own.
 *
 * Conversations are kept per person (ai_conversation) and only ever shown to them; cited pages are
 * looked up again with their current access whenever a conversation is shown.
 */
import { and, desc, eq, inArray, isNotNull, notInArray, sql } from "drizzle-orm";
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
  reportMarkdown,
  type ChatOptions,
  type ChatActionView,
  type ChatConnectionRecord,
  type ChatEvent,
  type ChatMessageView,
  type ChatMode,
  type ChatPageView,
  type ChatScope,
  type ChatScopeView,
  type ChatSourceView,
  type ChatStepView,
  type ConversationSummary,
  thoughtText,
} from "@/lib/ai-chat";
import { attachmentCsv } from "@/lib/chat-attachment-table";
import { CHAT_FILE_LIMITS, chatFileKind, chatFileUrl, type ChatAttachmentView } from "@/lib/chat-attachments";
import { pageLabel } from "@/lib/labels";
import { createPage } from "@/server/pages";
import { AccessError, connectedAppHold, isGuest, requireMembership, requirePageAccess, WorkspacePolicyError } from "@/server/access";
import { asWrite } from "@/server/connected-app";
import {
  AiError,
  aiConfig,
  chatModelsFor,
  IMAGE_CHARS,
  isAiError,
  promptRoomFor,
  RUN_ROUNDS,
  stream,
  takeRateLimit,
  takeWorkspaceCapacity,
  type AiMessage,
  type AiResult,
  type ChatModelOption,
} from "@/server/ai";
import { dropOldToolResults } from "@/server/ai/compact";
import { browserTimeZone, isTimeZone } from "@/lib/time-zone";
import { attachmentBlock, chatHistory, chatQuestionPrompt, chatSystemPrompt, researchSystemPrompt } from "@/server/ai/prompts";
import { attachmentRecords, deleteConversationFiles, keepQuestionFiles, questionFiles, readConversationFiles, type ChatFileContent } from "@/server/ai-chat-files";
import { chatWebOn, chatWebToolset, isChatWebTool, PLAN_TOOL, runChatWebTool, runPlan } from "@/server/ai-chat-web";
import { chatWebCallAsks, webCallAction } from "@/lib/web-calls";
import type { FileRow } from "@/server/files";
import { getSkillContent, SkillError } from "@/server/skills";
import { teamspaceLabel } from "@/server/teamspaces";
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
  /**
   * The model to answer with, one of chatModelsFor's: else the conversation's, else (a new one) the
   * person's latest conversation's, else the workspace's main model.
   */
  model?: string | null;
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

type ResolvedScope = { kind: "page" | "teamspace"; id: string; title: string };

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
  const chat = {
    scope,
    skill,
    existing,
    // Research only reads.
    mode: appReadOnly || input.research ? "read" : (input.mode ?? "ask"),
    replaced,
    connections: !isGuest(membership.role),
    memoryChanges: !appReadOnly,
    timeZone: isTimeZone(input.timeZone) ? input.timeZone : browserTimeZone(),
    model: model?.id ?? null,
    files,
    research: input.research === true,
    web: await chatWebOn(input.workspaceId),
    asSuggestions: input.asSuggestions === true,
  } as const;
  return runChat(userId, input.workspaceId, message, chat, signal);
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

/**
 * What the chat box offers the person in the workspace (see ChatOptions): the models, the one a new
 * conversation starts with, and whether the chat searches the web there.
 */
export async function chatOptionsFor(userId: string, workspaceId: string): Promise<ChatOptions> {
  const [models, latest, webSearch] = await Promise.all([chatModelsFor(workspaceId), latestModel(userId, workspaceId), chatWebOn(workspaceId)]);
  return { models, defaultModel: models.find((m) => m.id === latest)?.id ?? models[0]?.id ?? null, webSearch };
}

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
    model,
    files,
    research,
    web,
    asSuggestions,
  }: {
    scope: ResolvedScope | null;
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
    /** The model picked (null: the workspace's main one). */
    model: string | null;
    /** The question's own files: their records (named apart from the conversation's others) and rows. */
    files: { records: ChatAttachmentRecord[]; rows: FileRow[] };
    research: boolean;
    /** The chat may search the web and read web pages. */
    web: boolean;
    /** Body writes go in as the AI's suggested edits (collab/suggestion-doc writeBlocksAsSuggestions). */
    asSuggestions: boolean;
  },
  signal?: AbortSignal,
): AsyncGenerator<ChatEvent> {
  const ctx: ops.OperationContext = { userId, actor: { userId, model: true, ...(asSuggestions ? { asSuggestions } : {}) }, timeZone };
  // "Don't ask again" makes the rest of this answer `auto`.
  let mode = initialMode;
  // Keeping notes about the person changes nothing in the workspace: it's offered in every mode,
  // and asked about unless the mode is `auto` (a read-only chat asks too), while both the person and
  // the workspace have the memory on.
  // Research only reads: no changes, notes or other services.
  const remembers = !research && memoryChanges && (await memoryOn(userId, workspaceId));
  // Tools of connections that change something are left out of a read-only chat.
  const external = connections && !research ? await chatToolset(workspaceId, { writes: mode !== "read" }) : null;
  const services = [...new Set([...(external?.byName.values() ?? [])].map((e) => e.connection.name))];
  // The files of the whole conversation: questions asked later still see what was attached before.
  const earlierFiles = (existing?.messages.slice(0, existing.messages.length - replaced) ?? []).flatMap((m) => m.attachments ?? []);
  const read = await readConversationFiles(userId, workspaceId, existing?.id ?? null, earlierFiles, files);
  const extra = { attachments: read.contents, timeZone };
  const hasFiles = earlierFiles.length + files.records.length > 0;
  // Reading files is offered wherever there are some; a database of a CSV file only where changes are.
  const fileTools = read.contents.length ? [...ATTACHMENT_TOOLS, ...(mode === "read" || research || !read.contents.some((c) => c.kind === "csv") ? [] : ATTACHMENT_WRITE_TOOLS)] : [];
  const writeTools = new Set([...WRITE_TOOL_NAMES, ...ATTACHMENT_WRITE_TOOL_NAMES]);
  const webTools = web ? chatWebToolset() : [];
  const tools = research
    ? [PLAN_TOOL, ...CHAT_TOOLS, ...fileTools, ...webTools]
    : [...CHAT_TOOLS, ...(mode === "read" ? [] : WRITE_TOOLS), ...fileTools, ...(remembers ? MEMORY_TOOLS : []), ...webTools, ...(external?.tools ?? [])];
  const promptScope = scope ? { kind: scope.kind, title: scope.kind === "page" ? pageLabel(scope.title) : scope.title } : null;
  const skillTitle = skill ? pageLabel(skill.title) : null;
  const system = research
    ? researchSystemPrompt(promptScope, webTools.length > 0, skillTitle, hasFiles)
    : chatSystemPrompt(promptScope, mode !== "read", skillTitle, remembers, services, webTools.length > 0, hasFiles);
  const toolsSize = tools.reduce((n, t) => n + t.description.length + JSON.stringify(t.parameters).length, 0);
  const feature = research ? "chat.research" : "chat";
  // What the model takes, less what every turn sends: the history, the map, memory and tool results
  // share the rest.
  const budget = await promptRoomFor(workspaceId, feature, model);
  const room = () => Math.max(0, budget - system.length - toolsSize - 200);

  const conversation =
    existing ??
    (
      await db
        .insert(aiConversation)
        .values({ userId, workspaceId, title: conversationTitle(message || files.records.map((a) => a.name).join(", ")), model, messages: [] })
        .returning()
    )[0];
  yield {
    type: "conversation",
    id: conversation.id,
    title: conversation.title,
    ...(promptScope && scope ? { scope: { kind: scope.kind, id: scope.id, title: promptScope.title } } : {}),
  };

  const registry: Registry = { sources: [], byKey: new Map() };
  const started = Date.now();
  const steps: ChatStepRecord[] = [];
  const step = async (record: ChatStepRecord): Promise<ChatEvent> => {
    steps.push(record);
    return { type: "step", step: await viewStep(userId, record) };
  };
  /** Asks the person about a change, a note or a web call, pinging while the answer waits; their decision. */
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
  // The model that answered, and what the answer's turns cost.
  let answeredBy: string | null = null;
  let spentUsd = 0;
  const limitUsd = aiConfig().limits.runLimitUsd;
  // Something from outside (the web, a connection's tool) is in the conversation: from then on every
  // change and note is asked about.
  let untrusted = false;
  // What the person wrote in the conversation: a web page whose address they gave is read without asking.
  const typed = [message, ...(existing?.messages.slice(0, existing.messages.length - replaced) ?? []).filter((m) => m.role === "user").map((m) => m.content)];
  try {
    // ---------------------------------------------------------------------------- the question
    // Nothing is searched for the model: it gets the map of what there is and decides itself.
    const earlier = existing?.messages.slice(0, existing.messages.length - replaced) ?? [];
    const history: AiMessage[] = chatHistory(earlier, Math.floor(room() * HISTORY_SHARE));
    const memory = remembers ? await memoryForPrompt(userId, workspaceId, Math.floor(room() * MEMORY_SHARE)) : { text: "", count: 0 };
    const filesText = hasFiles ? filesPrompt(read, Math.floor((room() - sizeOf(history) - message.length - memory.text.length) * FILES_SHARE)) : "";
    const imagesSize = read.images.length * IMAGE_CHARS;
    const mapRoom = Math.min(MAP_CHARS, room() - sizeOf(history) - message.length - (skill?.body.length ?? 0) - memory.text.length - filesText.length - imagesSize - 2_000);
    const map = mapRoom >= 500 ? await workspaceMap(ctx, workspaceId, scope, mapRoom) : "";
    // A question that is only files asks about the files.
    const asked = message || "(The person attached the files without a question: say briefly what they hold and what you could do with them.)";
    const question: AiMessage = {
      role: "user",
      content: chatQuestionPrompt(asked, map, skill?.body, memory.text, { now: new Date(), timeZone }, filesText),
      ...(read.images.length ? { images: read.images } : {}),
    };
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
    // The turn that must answer: the one after the turns spent AI_RUN_LIMIT_USD (research writes its
    // report then), or RUN_ROUNDS' last for a model without a price. Each turn also counts against
    // the workspace's rate and cost limits, and the person can stop the answer.
    let finalRound = RUN_ROUNDS - 1;
    // The last turn called tools instead of answering: it's asked once more, with none run.
    let closing = false;

    // ------------------------------------------------------------------------------ model turns
    for (let round = 0; round <= finalRound; round++) {
      if (round > 0) {
        const wait = takeWorkspaceCapacity(workspaceId);
        if (wait > 0) throw new AiError("rateLimited", "The workspace's AI allowance is used up for now", wait);
      }
      const last = round === finalRound;
      yield { type: "thinking" };
      let streamed = "";
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
      answeredBy = result.model;
      spentUsd += result.usage.costUsd;
      if (last && result.toolCalls.length && !result.text.trim() && !closing) {
        closing = true;
        if (streamed) yield { type: "reset" };
        messages.push(result.message);
        for (const call of result.toolCalls) {
          messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: "Not run: there are no turns left for tools. Answer now with what you have, and say what is left to do.", isError: true });
        }
        round -= 1;
        continue;
      }
      if (!result.toolCalls.length || last) {
        answer = result.text;
        stopReason = result.stopReason === "length" ? "length" : "stop";
        break;
      }
      // Past AI_RUN_LIMIT_USD, the next turn answers (research writes its report).
      if (spentUsd >= limitUsd) finalRound = Math.min(finalRound, round + 1);
      // Text before a tool call is the model thinking aloud, not the answer: it's kept as a step.
      if (streamed) yield { type: "reset" };
      const thought = thoughtText(streamed);
      if (thought) yield await step({ kind: "thought", text: thought.length > THOUGHT_CHARS ? `${thought.slice(0, THOUGHT_CHARS - 1).trimEnd()}…` : thought });
      answer = "";
      messages.push(result.message);
      const answerNext = round === finalRound - 1;
      for (const call of result.toolCalls) {
        const left = room() - sizeOf(messages) - 300;
        let out: ToolOutcome;
        const entry = external?.byName.get(call.name);
        if (entry) {
          out = yield* callConnection(entry, call.arguments, left);
          // What a service returns (mail, issues) can be anyone's words: what follows is asked about.
          if (out.step?.kind === "connection" && out.step.outcome !== "declined") {
            untrusted = true;
            if (mode === "auto") mode = "ask";
          }
        } else if (research && call.name === PLAN_TOOL.name) out = runPlan(call);
        else if (webTools.length && isChatWebTool(call.name)) {
          // What a web call carries leaves the workspace, and what the model read could have put it
          // there: each is asked about, in every mode, unless it reads an address the person wrote.
          let decision: ChatDecision | "timeout" = "approve";
          if (chatWebCallAsks(call, typed)) decision = yield* decide(webCallAction(call));
          if (decision === "decline" || decision === "timeout") {
            out = {
              content:
                decision === "timeout"
                  ? "The person didn't answer in time, so nothing was sent to the web. Answer with what you have."
                  : "The person declined this web call: nothing was sent. Don't try it again; answer with what you have, or ask them what to look up.",
            };
          } else {
            out = await runChatWebTool(call, registry, left);
            // Web text could pass itself off as the person's wish: what follows is asked about.
            untrusted = true;
            if (mode === "auto") mode = "ask";
          }
        }
        // With the memory off, remember and forget aren't offered: called anyway, they're unknown.
        else if (remembers && MEMORY_TOOL_NAMES.has(call.name)) {
          // Text the model read could pass itself off as a lasting note: the person approves each.
          const prepared = await prepareMemory(userId, workspaceId, call);
          let decision: ChatDecision | "timeout" = "approve";
          if ("action" in prepared && mode !== "auto") decision = yield* decide(prepared.action);
          out = "action" in prepared ? await applyMemory(userId, workspaceId, conversation.id, prepared, decision) : prepared;
        } else if (!writeTools.has(call.name)) out = await runTool(ctx, workspaceId, scope, call, registry, left, extra);
        else if (mode === "read") out = { content: "Changes are off in this chat: say what you would change instead.", isError: true };
        else {
          const prepared = await prepareWrite(ctx, workspaceId, scope, call, extra);
          let decision: ChatDecision | "timeout" = "approve";
          if ("action" in prepared && mode === "ask") {
            decision = yield* decide(prepared.action);
            if (decision === "always" && !untrusted) mode = "auto";
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
    const refs: ChatSourceRef[] = registry.sources
      .filter((s) => cited.has(s.n))
      .map((s) => (s.url ? { n: s.n, url: s.url, title: s.title } : { n: s.n, pageId: s.pageId, blockId: s.blockId }));
    const now = new Date().toISOString();
    const note = stopped ? "stopped" : failure ? undefined : stopReason === "length" ? "cutOff" : undefined;
    const ms = Date.now() - started;
    const kept = files.records;
    await saveTurn(
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
    );
    // Kept with the question: they now go with the conversation.
    await keepQuestionFiles(conversation.id, kept.map((f) => f.id));
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

/** Adds a question and its answer to a conversation, in place of its last `replace` records; `model`: the one it now answers with. */
async function saveTurn(conversationId: string, records: ChatMessageRecord[], replace: number, model: string | null) {
  // Keeps the records before the replaced ones (a jsonb array's elements, in order).
  const kept = replace
    ? sql`coalesce((select jsonb_agg(e order by i) from jsonb_array_elements(${aiConversation.messages}) with ordinality as t(e, i) where i <= jsonb_array_length(${aiConversation.messages}) - ${replace}), '[]'::jsonb)`
    : sql`${aiConversation.messages}`;
  await db
    .update(aiConversation)
    .set({ messages: sql`${kept} || ${JSON.stringify(records)}::jsonb`, model, updatedAt: new Date() })
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
  const old = and(
    eq(aiConversation.userId, userId),
    eq(aiConversation.workspaceId, workspaceId),
    notInArray(
      aiConversation.id,
      keep.map((k) => k.id),
    ),
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
  return { id: found.id, title: found.title, model: found.model, messages };
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

/** Deletes conversations of the person (only theirs). */
export async function deleteConversations(userId: string, workspaceId: string, conversationIds: string[] | "all") {
  await requireMembership(userId, workspaceId);
  const theirs = and(
    eq(aiConversation.userId, userId),
    eq(aiConversation.workspaceId, workspaceId),
    conversationIds === "all" ? undefined : inArray(aiConversation.id, conversationIds.length ? conversationIds : [""]),
  );
  // Their files go with them, from storage too.
  const gone = await db.select({ id: aiConversation.id }).from(aiConversation).where(theirs);
  await deleteConversationFiles(gone.map((c) => c.id));
  await db.delete(aiConversation).where(theirs);
}

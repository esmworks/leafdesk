/**
 * How the AI chat (server/ai-chat.ts) answers each tool call of the model, and what it asks the
 * person about first: `answer(call, decision)` gives the call's outcome, or `{ ask }` (the change
 * as the person is shown it) when it needs their decision, which the run then waits for, parked
 * (`awaiting_approval`), and answers the call again with. Nothing is changed before the decision.
 *
 * What the chat may change follows its mode: `read` changes nothing, `ask` asks before each change
 * and note, `auto` doesn't ("yes, don't ask again" turns `ask` into `auto` for the rest of the
 * answer). Once the answer read words no one in the conversation wrote (a service's answer, the
 * web, mail, another agent's: lib/agents.ts readOthersWords on its steps), `auto` asks again, and
 * "don't ask again" no longer holds. Whatever the mode, each change in a connected service, each
 * draft of mail, each web call carrying what the person didn't write, and each further tool that
 * reaches people is asked about, each time.
 *
 * Agents answer their calls with assistant/dispatch.ts, under rules of their own.
 */
import type { ChatActionView, ChatConnectionRecord, ChatMode } from "@/lib/ai-chat";
import type { ChatStepRecord } from "@/db/schema";
import { readOthersWords } from "@/lib/agents";
import { chatWebCallAsks, webCallAction } from "@/lib/web-calls";
import { MAX_REMINDERS_PER_RUN, reminderText, reminderTime } from "@/lib/ai-reminders";
import { AiError, type AiToolCall } from "@/server/ai";
import { withinWorkspace } from "@/server/connected-app";
import type { ChatDecision } from "@/server/ai-chat-approvals";
import { isChatMailTool, MAIL_TOOL_NAMES, prepareMailDraft, runChatMailTool, saveMailDraft } from "@/server/ai-chat-mail";
import { isChatWebTool, PLAN_TOOL, runChatWebTool, runPlan } from "@/server/ai-chat-web";
import { applyMemory, MEMORY_TOOL_NAMES, prepareMemory } from "@/server/ai-memory";
import { REMIND_TOOL_NAME, reminderWhen, setReminder } from "@/server/ai-reminders";
import { callMoreTool, FIND_TOOLS, findTools, isDocsAddress, lazyMoreTools, MORE_TOOL_NAMES, moreToolStep, pickMoreTool, readDocsTopic } from "@/server/ai-more-tools";
import { chatToolNow, inputSummary, runConnectionTool, type ConnectionToolEntry, type ConnectionToolset } from "@/server/connections/tools";
import type * as ops from "@/server/operations";
import { applyWrite, ATTACHMENT_WRITE_TOOL_NAMES, prepareWrite, runTool, WRITE_TOOL_NAMES, type Registry, type ToolOutcome } from "@/server/ai-tools";

/** A page or teamspace a question keeps to, checked (server/ai-chat.ts chatScope). */
export type ResolvedScope = { kind: "page" | "teamspace"; id: string; title: string };

/** A call answered, or the change to ask the person about before it is. */
export type ChatAnswer = ToolOutcome | { ask: ChatActionView };

export type ChatDispatchContext = {
  userId: string;
  workspaceId: string;
  conversationId: string;
  ctx: ops.OperationContext;
  scope: ResolvedScope | null;
  registry: Registry;
  /** What the person chose the chat may change: what it was offered follows it. */
  initialMode: ChatMode;
  /** What it may change now (the run's `state.mode`, after "don't ask again" or words from outside). */
  mode: ChatMode;
  /** The workspace lets the chat change things without asking: "don't ask again" makes the mode `auto`. */
  autoChanges: boolean;
  research: boolean;
  /** The connections' tools the chat was offered (null: none). */
  external: ConnectionToolset | null;
  moreTools: ReturnType<typeof lazyMoreTools>;
  /** The chat may search the web and read web pages. */
  web: boolean;
  /** The names of the mail tools it was offered (the person's own mail). */
  mailTools: ReadonlySet<string>;
  /** Notes about the person may be kept or dropped. */
  remembers: boolean;
  /** What the person wrote in the conversation: a web page whose address they gave is read without asking. */
  typed: string[];
  timeZone: string;
  extra: Parameters<typeof runTool>[6];
  /** This answer's steps so far, as the run adds them: what it read decides what it asks. */
  steps: readonly ChatStepRecord[];
  signal?: AbortSignal;
};

const DECLINED = {
  change: "The person declined this change: nothing was changed. Don't try it again; say what you would have done, or ask what they want instead.",
  call: "The person declined this call: it wasn't sent. Don't try it again; say what you would have done, or ask what they want instead.",
  web: "The person declined this web call: nothing was sent. Don't try it again; answer with what you have, or ask them what to look up.",
  reminder: "The person declined this reminder: none was set. Don't try it again; ask what they want instead.",
};

export function createChatDispatch(cx: ChatDispatchContext) {
  const { userId, workspaceId, registry, research, external, moreTools, signal } = cx;
  let mode = cx.mode;
  const writeTools = new Set([...WRITE_TOOL_NAMES, ...ATTACHMENT_WRITE_TOOL_NAMES]);
  // What was worked out to ask about a call, for when its decision comes in this process; a run
  // taken up again after a restart works it out again, with the person's access as it is then.
  const prepared = new Map<string, unknown>();
  async function once<T>(call: AiToolCall, work: () => Promise<T>): Promise<T> {
    if (!prepared.has(call.id)) prepared.set(call.id, await work());
    return prepared.get(call.id) as T;
  }
  const outside = () => readOthersWords(cx.steps);

  /**
   * Calls a connection's tool. One that changes something there is asked about first, in every
   * mode and each time ("don't ask again" doesn't cover it): what it sends comes from the model.
   */
  async function connection(entry: ConnectionToolEntry, call: AiToolCall, decision: ChatDecision | null, left: number): Promise<ChatAnswer> {
    const { connection: conn, tool } = entry;
    const args = call.arguments;
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
      if (!decision) return { ask: { action: "connection", connection: { name: conn.name, icon: conn.icon }, target: null, title: tool.title || tool.name, changes: [], content: inputSummary(args, 2_000) } };
      if (decision === "decline") return { content: DECLINED.call, step: record("declined") };
      const now = await chatToolNow(entry);
      if (!now) return { content: "This tool is no longer allowed in the chat, so the call wasn't sent. Say what you would have done.", isError: true, step: record("declined") };
      entry = now;
    }
    const out = await runConnectionTool({ entry, args, actorId: userId, chat: true, approvedBy: writes ? userId : null, room: left, signal });
    return { content: out.content, isError: out.isError, step: record(out.step.outcome === "done" ? "done" : "failed") };
  }

  /**
   * find_tools and use_tool (ai-more-tools.ts). A further tool that changes something is asked
   * about as the chat's own changes are, and those that reach people or run on their own in every
   * mode, each time.
   */
  async function more(call: AiToolCall, decision: ChatDecision | null, left: number): Promise<ChatAnswer> {
    const tools = await moreTools.open();
    if (call.name === FIND_TOOLS.name) {
      const query = typeof call.arguments.query === "string" ? call.arguments.query.slice(0, 200) : "";
      return { content: findTools(tools, query, left) };
    }
    const picked = pickMoreTool(tools, call, cx.initialMode === "read" ? " (changes are off in this chat)" : "");
    if (!("tool" in picked)) return picked;
    const { tool, args } = picked;
    if (tool.writes && (tool.eachTime || mode !== "auto")) {
      if (!decision) return { ask: { action: "tool", target: null, title: tool.title, changes: [], content: inputSummary(args, 2_000), ...(tool.eachTime ? { eachTime: true } : {}) } };
      if (decision === "decline") return { content: DECLINED.change, step: moreToolStep(tool, args, "declined") };
      if (decision === "always" && cx.autoChanges && !outside() && !tool.eachTime) mode = "auto";
    }
    try {
      // Held to this workspace: the person's tools would reach the others too (connected-app.ts withinWorkspace).
      return await withinWorkspace(userId, workspaceId, () => callMoreTool(tools, picked, left, signal));
    } catch (error) {
      if (signal?.aborted) throw new AiError("aborted", "The answer was stopped");
      throw error;
    }
  }

  /**
   * A reminder for the person asking, on their clock. Asked about as notes are (unless the mode is
   * `auto`): the card also shows them the time it took from their words.
   */
  async function remind(call: AiToolCall, decision: ChatDecision | null): Promise<ChatAnswer> {
    const set = cx.steps.filter((s) => s.kind === "reminder" && s.outcome === "done").length;
    if (set >= MAX_REMINDERS_PER_RUN) return { content: `You have set ${MAX_REMINDERS_PER_RUN} reminders, the most one answer may set.`, isError: true };
    const text = reminderText(call.arguments.text);
    const time = reminderTime(call.arguments.at, new Date(), cx.timeZone);
    // A text or time that doesn't do is refused below, with the reason, before anyone is asked.
    const when = text && "at" in time ? reminderWhen(time.at, cx.timeZone) : null;
    if (when && mode !== "auto") {
      if (!decision) return { ask: { action: "remind", target: null, title: text, changes: [], content: when } };
      if (decision === "decline") return { content: DECLINED.reminder, step: { kind: "reminder", text, when, outcome: "declined" } };
    }
    const out = await setReminder({ workspaceId, actorId: userId, personId: userId, timeZone: cx.timeZone }, call);
    if (out.isError || !when) return { content: out.content, isError: true };
    return { content: out.content, step: { kind: "reminder", text, when, outcome: "done" } };
  }

  /** The call's outcome, or what to ask the person (`decision` null: not asked yet). */
  async function answer(call: AiToolCall, decision: ChatDecision | null, left: number): Promise<ChatAnswer> {
    // Words from outside could pass themselves off as the person's wish: from then on, changes are asked about.
    if (mode === "auto" && outside()) mode = "ask";
    const out = await route(call, decision, left);
    if (!("ask" in out)) prepared.delete(call.id);
    return out;
  }

  async function route(call: AiToolCall, decision: ChatDecision | null, left: number): Promise<ChatAnswer> {
    const entry = external?.byName.get(call.name);
    if (entry) return connection(entry, call, decision, left);
    if (MORE_TOOL_NAMES.has(call.name) && !research) return more(call, decision, left);
    // The docs topics the further tools' inputs point at are read like pages.
    if (call.name === "read_page" && isDocsAddress(call.arguments.page_id)) {
      const docs = await readDocsTopic(call.arguments.page_id, left);
      return docs ? { content: docs } : { content: "There is no such docs topic.", isError: true };
    }
    if (research && call.name === PLAN_TOOL.name) return runPlan(call);
    if (cx.web && isChatWebTool(call.name)) {
      // What a web call carries leaves the workspace, and what the model read could have put it
      // there: each is asked about, in every mode, unless it reads an address the person wrote.
      if (!decision && chatWebCallAsks(call, cx.typed)) return { ask: webCallAction(call) };
      if (decision === "decline") return { content: DECLINED.web };
      return runChatWebTool(call, registry, left);
    }
    if (cx.mailTools.has(call.name) && isChatMailTool(call.name)) {
      if (call.name !== MAIL_TOOL_NAMES.draft) return runChatMailTool(userId, workspaceId, call, registry, left);
      // A draft could carry what the model read to an address an email named: each is asked
      // about, in every mode, and "don't ask again" doesn't cover the next.
      const draft = await once(call, () => prepareMailDraft(userId, workspaceId, call.arguments, cx.timeZone));
      if (!("action" in draft)) return draft;
      if (!decision) return { ask: draft.action };
      return saveMailDraft(userId, draft, decision);
    }
    // With the memory off, remember and forget aren't offered: called anyway, they're unknown.
    if (cx.remembers && MEMORY_TOOL_NAMES.has(call.name)) {
      // Text the model read could pass itself off as a lasting note: the person approves each.
      const note = await once(call, () => prepareMemory(userId, workspaceId, call));
      if (!("action" in note)) return note;
      if (!decision && mode !== "auto") return { ask: note.action };
      return applyMemory(userId, workspaceId, cx.conversationId, note, decision ?? "approve");
    }
    if (call.name === REMIND_TOOL_NAME && !research) return remind(call, decision);
    if (!writeTools.has(call.name)) return runTool(cx.ctx, workspaceId, cx.scope, call, registry, left, cx.extra);
    if (mode === "read") return { content: "Changes are off in this chat: say what you would change instead.", isError: true };
    const change = await once(call, () => prepareWrite(cx.ctx, workspaceId, cx.scope, call, cx.extra));
    if (!("action" in change)) return change;
    if (!decision && mode === "ask") return { ask: change.action };
    if (decision === "always" && cx.autoChanges && !outside()) mode = "auto";
    return applyWrite(change, decision ?? "approve", registry);
  }

  return {
    answer,
    /** What the chat may change now. */
    get mode() {
      return mode;
    },
  };
}

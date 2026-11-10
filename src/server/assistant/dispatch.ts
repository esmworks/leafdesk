/**
 * What an agent's run is offered and how each of its tool calls is answered: which of Leafdesk's
 * tools, connections' tools, the web, mail, notes and other agents a run gets for where it came
 * from (setUpRun), and the rules each call is held to (createDispatch): what waits for an owner,
 * what counts against the run's and the day's changes, what is refused once the run read email
 * or files on the person's computer. The run's turns with the model stay in agents/run.ts
 * (converse), which saves where a run waits and goes on from there.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agentRun, page, workspaceAgent, type AgentRunRow, type AgentRunState } from "@/db/schema";
import {
  accessSource,
  FINISH_RUN_OUTCOMES,
  FINISH_RUN_TOOL,
  finishRunCall,
  MAX_FINISH_REASON,
  isEventRun,
  isChannelRun,
  isMentionRun,
  isMailRun,
  READS_AFTER_MAIL,
  readOthersWords,
  isRowRun,
  isScheduleRun,
  mailRun,
  mayCallAfterMail,
  MAX_AGENT_WRITES,
  MAX_MAIL_PROPOSALS,
  MAX_SCHEDULED_WRITES,
  type AgentPendingCall,
  type AgentRunCode,
  type AgentRunSource,
  type AgentRunUsage,
  type AgentStepRecord,
  isComputerTool,
  leftUntold,
} from "@/lib/agents";
import { AFTER_LOCAL_READ } from "@/lib/local-reads";
import { MAX_RUN_EXTERNAL_CHARS } from "@/lib/connections";
import { redactError, redactText, redactValue } from "@/lib/redact";
import { agentWebCallAsks, scheduledWebCallGoes } from "@/lib/web-calls";
import { AccessError, findMembership, hasLevel, pageAccessOf } from "@/server/access";
import { type AiMessage, type AiTool, type AiToolCall } from "@/server/ai";
import { memoryAvailable, READ_MEMORY_TOOL, readMemory } from "@/server/ai-memory";
import { noteWrite } from "@/lib/memory-rule";
import { callMoreTool, FIND_TOOLS, findTools, isDocsAddress, lazyMoreTools, MORE_TOOL_NAMES, pickMoreTool, readDocsTopic, USE_TOOL } from "@/server/ai-more-tools";
import { applyWrite, CHAT_TOOLS, prepareWrite, runTool, WRITE_TOOL_NAMES, WRITE_TOOLS, type PreparedWrite, type Registry, type ToolOutcome } from "@/server/ai-tools";
import { proposeChange } from "@/server/pending-changes";
import { databaseOfRow, DRAFT_EMAIL, draftEmailTool, draftRowEmail, draftSender } from "@/server/agents/email-drafts";
import { runMailboxes } from "@/server/agents/mail";
import { mailSender, SEND_EMAIL, sendAgentEmail, sendEmailTool } from "@/server/agents/send-mail";
import { asAutomation } from "@/server/automations/queue";
import { changeComments } from "@/server/comments";
import { AGENT_MAIL_ACTIONS, agentMailToolset, markMail, MAIL_TOOL_NAMES, prepareMailDraft, runAgentMailAction, runChatMailTool, saveMailDraft } from "@/server/ai-chat-mail";
import { agentToolset, inputSummary, runConnectionTool, type ConnectionToolset } from "@/server/connections/tools";
import { recipientLocale } from "@/server/mail/locale";
import * as ops from "@/server/operations";
import { ToolInputError } from "@/server/mcp/format";
import { COMBINE, MAX_MERGE_ROWS } from "@/lib/merge-rows";
import { PropertyValueError } from "@/lib/properties";
import type { ChatWriteRecord } from "@/db/schema/ai";
import { runClock } from "@/server/agents/clock";
import { ASK_AGENT, ASSIGN_AGENT, handoffFor } from "@/server/agents/handoff";
import { ATTACH_FILE, ATTACH_FILE_TOOL, attachChatFile } from "@/server/agents/chat-files";
import { chatRunTyped } from "@/server/agents/chat-store";
import { approversOf } from "@/server/agents/approvers";
import { AGENT_MEMORY_TOOL_NAMES, AGENT_MEMORY_TOOLS, HANDOFF_TOOL, runAgentMemoryTool, runHandoffTool } from "@/server/agents/memory";
import {
  applyReminderChange,
  CHANGE_REMINDER_TOOL_NAME,
  changeReminderTool,
  LIST_REMINDERS_TOOL_NAME,
  listReminders,
  listRemindersTool,
  prepareReminderChange,
  REMIND_TOOL_NAME,
  remindedPerson,
  remindersSet,
  remindTool,
  setReminder,
} from "@/server/ai-reminders";
import { MAX_REMINDERS_PER_RUN } from "@/lib/ai-reminders";
import { isTimeZone } from "@/lib/time-zone";
import { runWebTool, webToolsFor } from "@/server/agents/web";
import { computerChanges, computerFor, computerStepInput, computerTools, runComputerTool } from "@/server/agents/computer";
import { addAgentUsage } from "@/server/agents/usage";
import { dailyLimitReached, giveBackDailyChange, takeDailyChange } from "@/server/agents/daily-changes";
import { parseQuietHours, quietUntil } from "@/lib/quiet-hours";
import { noticeAgentSpending } from "@/server/ai-limit-notices";

/** The most of a comment an agent writes. */
export const MAX_COMMENT = 4_000;

export type Run = AgentRunRow;
/** Who a run answers as, and the settings it keeps to: an agent's. */
export type Profile = typeof workspaceAgent.$inferSelect;
type Agent = Profile;

/** How a run ended; `quiet`: a schedule's run that found nothing new (finish_run), which reports to no one. */
export type Ending = { status: "done" | "failed"; code?: AgentRunCode | null; error?: string | null; steps?: AgentStepRecord[]; answer?: string; usage?: AgentRunUsage | null; quiet?: boolean };

export type Paused = { status: "awaiting"; state: AgentRunState; pending: AgentPendingCall; steps: AgentStepRecord[]; usage: AgentRunUsage };
export type CallResult = { content: string; isError?: boolean; step?: AgentStepRecord };
/** A call an owner's rule lets go, held until the agent's quiet hours end. */
export type Deferred = { deferUntil: Date };
/** How `answer` answers a call: done (or refused), waiting for an owner (null), or held for quiet hours. */
export type Answered = CallResult | Deferred | null;
export const isDeferred = (out: Answered): out is Deferred => out !== null && "deferUntil" in out;

const ADD_COMMENT: AiTool = {
  name: "add_comment",
  description: "Writes a comment on the row that started this run, as you. Use it to explain a change, answer a question in the row, or ask a person for what is missing.",
  parameters: {
    type: "object",
    properties: { text: { type: "string", description: "The comment, in plain text." } },
    required: ["text"],
    additionalProperties: false,
  },
};

const ADD_ROW_COMMENT: AiTool = {
  name: "add_comment",
  description: "Writes a comment on a row of the database this run looks after, as you. Use it to explain a change, or to ask a person for what is missing.",
  parameters: {
    type: "object",
    properties: {
      row_id: { type: "string", description: "The row's page_id (from a source)." },
      text: { type: "string", description: "The comment, in plain text." },
    },
    required: ["row_id", "text"],
    additionalProperties: false,
  },
};

const MERGE_ROWS: AiTool = {
  name: "merge_rows",
  description: `Merges duplicate rows of the database this run looks after into one kept row, as you. The kept row takes, for each property, the value of the row named for it (or "${COMBINE}": every row's values of a multi-value property); properties left out keep the kept row's value, or the first row's that has one. Links, comments, activity, files, email and page text of the other rows move to the kept row, and they go to the trash. Merge only rows that are clearly the same record. Counts as one change.`,
  parameters: {
    type: "object",
    properties: {
      kept_row_id: { type: "string", description: "The page_id of the row that stays (from a source)." },
      other_row_ids: {
        type: "array",
        items: { type: "string" },
        description: `The page_ids of the rows merged into it (1-${MAX_MERGE_ROWS - 1}).`,
      },
      properties: {
        type: "object",
        description: `For each property to take from another row, by name: the page_id of that row, or "${COMBINE}".`,
        additionalProperties: { type: "string" },
      },
      title: { type: "string", description: "The page_id of the row whose title the kept row takes, if not its own." },
    },
    required: ["kept_row_id", "other_row_ids"],
    additionalProperties: false,
  },
};

const FINISH_RUN: AiTool = {
  name: FINISH_RUN_TOOL,
  description: `Ends this run at once, in place of a report. "nothing_new": you checked and there is nothing to tell or do, and you changed nothing; the person who set the schedule isn't told. "failed": you couldn't do the task (what you need is gone, or isn't shared with you); they are told, with your reason. Calls after it in the same turn are not made. Once you changed something, a call of yours wasn't made (refused, declined, past a limit) or you gave another agent a task, don't call it with "nothing_new": report that instead.`,
  parameters: {
    type: "object",
    properties: {
      outcome: { type: "string", enum: [...FINISH_RUN_OUTCOMES] },
      reason: { type: "string", description: `Why, in a sentence (at most ${MAX_FINISH_REASON} characters); needed for "failed".` },
    },
    required: ["outcome"],
    additionalProperties: false,
  },
};

const UPDATE_ROW = WRITE_TOOLS.find((t) => t.name === "update_row")!;
const CREATE_ROW = WRITE_TOOLS.find((t) => t.name === "create_row")!;

/**
 * create_row and update_row of an agent whose changes wait for review: the same, proposing the
 * change instead of making it, with why (for the person reviewing it).
 */
function proposing(tool: AiTool): AiTool {
  const parameters = tool.parameters as { properties: Record<string, unknown>; required: string[] };
  return {
    ...tool,
    description: `${tool.description.replace(/\. Returns it as a numbered source\.$/, ".").replace(/^Adds/, "Proposes adding").replace(/^Changes/, "Proposes changing")} The change waits for a person to approve it; nothing is saved until then.`,
    parameters: {
      ...parameters,
      properties: { ...parameters.properties, reason: { type: "string", description: "Why you propose it, in a sentence, for the person reviewing it." } },
      required: [...parameters.required, "reason"],
    },
  };
}
const PROPOSE_TOOLS = new Map([UPDATE_ROW, CREATE_ROW].map((t) => [t.name, proposing(t)]));
/** The run's tools, with create_row and update_row proposing when the agent's changes wait for review. */
const forReview = (tools: AiTool[], reviews: boolean) => (reviews ? tools.map((t) => PROPOSE_TOOLS.get(t.name) ?? t) : tools);
const EDIT_PAGE = WRITE_TOOLS.find((t) => t.name === "edit_page")!;
/** Leafdesk's tools on a row's run: update_row and edit_page on that row. Any run may also keep notes (memory.ts). */
export const AGENT_TOOLS: AiTool[] = [...CHAT_TOOLS, UPDATE_ROW, EDIT_PAGE, ADD_COMMENT];

/** Leafdesk's tools on a schedule's run on a database: create_row in it, and update_row, edit_page and add_comment on any of its rows. */
export const SCHEDULED_DATABASE_TOOLS: AiTool[] = [...CHAT_TOOLS, CREATE_ROW, UPDATE_ROW, EDIT_PAGE, ADD_ROW_COMMENT];

/** The database a schedule's run looks after, if any. */
export const scheduledDatabase = (source: AgentRunSource) => (isScheduleRun(source) ? (source.databaseId ?? null) : null);

/** Leafdesk's tools on a connection event's run: reading, and adding rows where the agent may edit. */
export const EVENT_TOOLS: AiTool[] = [...CHAT_TOOLS, CREATE_ROW];
/** Leafdesk's own tools that wait for an owner on an event's run, as a connection's writing tools do. */
const EVENT_APPROVED_TOOLS: ReadonlySet<string> = new Set([CREATE_ROW.name]);

/**
 * The reminder tools of a run (setting one, listing those it set and cancelling or moving one), on
 * the clock of the zone the run came with (their browser's for a chat message, the schedule's for
 * a schedule's run), else UTC.
 */
function reminderFor(run: Run) {
  const zone = "timeZone" in run.context ? run.context.timeZone : undefined;
  const timeZone = isTimeZone(zone) ? zone : "UTC";
  const now = new Date();
  return { tools: [remindTool(now, timeZone), listRemindersTool(), changeReminderTool(now, timeZone)], timeZone };
}

/**
 * What a run is offered and held to, worked out from where it came from, when it starts and again
 * when it goes on after waiting; a run new email started whose mailbox was closed to the agent
 * since ends here.
 */
export async function setUpRun(
  agent: Agent,
  run: Run,
  {
    member,
    bound,
    trusted,
    chatWrites,
    moreTools: allMoreTools,
    runHelper,
  }: {
    member: string | null;
    bound: string | null;
    trusted: boolean;
    chatWrites: boolean;
    moreTools: ReturnType<typeof lazyMoreTools>;
    /** Does a helper's run (handoff.ts) in the slot of the run that asked it. */
    runHelper: (run: Run) => Promise<void>;
  },
) {
  const ctx: ops.OperationContext = { userId: agent.userId, actor: { userId: agent.userId, model: true } };
  const rowRun = isRowRun(run.source);
  const scheduled = isScheduleRun(run.source);
  const databaseId = scheduledDatabase(run.source);
  // Changes it may make in all.
  const maxWrites = databaseId ? MAX_SCHEDULED_WRITES : MAX_AGENT_WRITES;
  const eventRun = isEventRun(run.source);
  const mention = isMentionRun(run.source) ? run.source : null;
  // A member's message in a channel of Messages started it: it answers in the message's thread.
  const channelRun = isChannelRun(accessSource(run.source));
  // New email started it: it reads that email from the start, as anyone's words (see answer), and
  // has only what a run that read email may use.
  const arrival = isMailRun(run.source) ? run.source : null;
  // A mention's run may change the page its comment is on where the agent (and the member) may
  // edit it, and its values when it is a database row.
  const mentionEdits = mention ? await mentionEditing(agent, mention.pageId) : null;
  // A row no member wrote (or a sync did, under a member's name), or an event from a service no
  // owner vouched for, may carry anyone's instructions: no connection tool runs without an owner.
  const askEveryTool = rowRun ? !member : !trusted;
  // An agent with web access reads pages (and searches) as it reads from a connection: on such a
  // run each call waits for an owner too, or the run could be steered to send what it read to any
  // address.
  const webTools = arrival ? [] : webToolsFor(agent);
  const webNames = new Set(webTools.map((t) => t.name));
  // A run a person asked for in words (a chat message, a mention, a request, or a helper's run for
  // one) reads what they may open, some of it written by others, who could steer it into sending
  // that out: a web call carrying an address or search words the person didn't write (or any, on a
  // helper's run, whose task an agent wrote) waits for an owner too (lib/web-calls.ts).
  const askedFor = accessSource(run.source);
  const askedInWords = askedFor.kind === "chat" || askedFor.kind === "request" || isMentionRun(askedFor) || isChannelRun(askedFor);
  const webAsks = { askEveryTool, typed: askedInWords ? (run.source.kind === "handoff" ? [] : [run.prompt]) : null };
  // A schedule's run (or a helper's run for one) has no one watching and is due again later: it
  // searches, and reads the pages of its task or of its own searches' results, and any other read
  // is refused at once (lib/web-calls.ts). Over rows no member stands behind each call still waits.
  const unattended = isScheduleRun(askedFor) && !askEveryTool;
  const webTask = run.source.kind === "handoff" ? [] : [run.prompt];
  const chat = run.source.kind === "chat";
  // Its owners chose that its changes to rows wait for review: create_row and update_row propose
  // them (pending-changes.ts). A chat's changes are still made at once: the person is there, and asked.
  // A run new email started only ever proposes, to the mailbox's owner alone (see propose).
  const proposes = (agent.rowChanges === "review" && !chat) || Boolean(arrival);
  // Leafdesk's own tools this run makes only once an owner approves (none on a row's run). A row an
  // event's run proposes waits for review instead: nothing to approve before then.
  const ownApproved: ReadonlySet<string> = new Set([...(eventRun && !proposes ? EVENT_APPROVED_TOOLS : []), ...(askEveryTool || askedInWords ? webNames : [])]);
  // What the run may still wait for the agents it asks.
  const clock = runClock();
  // A read-only chat isn't offered connections' tools that change something. Nor is a run held to
  // someone no owner answers for (one someone who isn't an owner asked for, set or chats in,
  // approvers.ts): each such call waits for an owner, and would only run out of time.
  const heldTo = accessSource(run.source);
  const heldToPerson = heldTo.kind === "chat" || heldTo.kind === "request" || heldTo.kind === "mail" || isChannelRun(heldTo) || (isScheduleRun(heldTo) && !heldTo.databaseId);
  const unanswered = heldToPerson && (await approversOf(run)).length === 0;
  const toolset = await agentToolset(agent.id, { writes: (!chat || chatWrites) && !unanswered });
  const connections = [...new Set([...toolset.byName.values()].map((e) => e.connection.name))];
  // What a run reads that no one in the workspace stands behind could fill the owners' review with
  // its own notes: such a run proposes none.
  const memoryOn = await memoryAvailable(run.workspaceId);
  // A mention's run (in a comment or a channel) answers one person in a thread, another agent wrote a helper's task, and
  // someone who isn't an owner shouldn't fill the owners' review from a read-only chat: these read
  // the notes owners kept, but propose none.
  const handedOff = run.source.kind === "handoff";
  const remembers = memoryOn && !askEveryTool && !mention && !isChannelRun(run.source) && !handedOff && !arrival && (!chat || chatWrites);
  // Where it left off goes only to the same schedule's next run, which reads the same: no one approves it.
  const leavesNote = memoryOn && scheduled;
  const mentionTools = mentionEdits?.edits ? [EDIT_PAGE, ...(mentionEdits.row ? [UPDATE_ROW] : [])] : [];
  // Other agents it may ask; none on a helper's run, nor on one that reads email from the start.
  // Whether the run read what anyone may have written (createDispatch readOutside), asked only once
  // calls are answered; until then, as if it had.
  const outside = { read: () => true };
  const handoff = arrival ? null : await handoffFor(agent, run, { bound, trusted: () => !askEveryTool && !outside.read(), clock, runHelper });
  // The person it works for, whom it may remind of something (ai-reminders.ts): not on a helper's
  // run, whose task another agent wrote, nor on one reading what no member stands behind.
  const reminded = handedOff || askEveryTool || arrival ? null : remindedPerson(run.source);
  const reminder = reminded ? reminderFor(run) : null;
  // The email of the person the run works for, in the mailboxes they opened to the agent (mail.ts):
  // only on a run that shows what it did to them alone and stays in the app (lib/agents.ts mailRun).
  const mailBoxes = mailRun(run.source) ? await runMailboxes(agent, member) : [];
  // Opened to it but not read on a run like this one: it says why instead of asking to be given mail.
  const mailHeld = !mailRun(run.source) && (await runMailboxes(agent, member)).length > 0;
  // Rows a run proposes from email, to the person whose email it is (see propose): a run new email
  // started from the start, a schedule's (not on a database) whenever, and the chat of someone who
  // may edit the agent once it read email. Nothing changes until that person approves.
  const mailProposes = mailBoxes.length > 0 && !databaseId && (Boolean(arrival) || scheduled || (chat && chatWrites));
  const ownTools = rowRun
    ? AGENT_TOOLS
    : databaseId
      ? SCHEDULED_DATABASE_TOOLS
      : eventRun
        ? EVENT_TOOLS
        : arrival
          ? [...CHAT_TOOLS.filter((t) => READS_AFTER_MAIL.has(t.name)), CREATE_ROW, UPDATE_ROW]
          : chatWrites
            ? [...CHAT_TOOLS, ...WRITE_TOOLS]
            : mailProposes
              ? [...CHAT_TOOLS, ...mentionTools, CREATE_ROW, UPDATE_ROW]
              : [...CHAT_TOOLS, ...mentionTools];
  const reviews = (proposes || mailProposes) && ownTools.some((t) => PROPOSE_TOOLS.has(t.name));
  // A run on a row, or a schedule's on a database, that works for someone with a mailbox where mail
  // is matched to the rows drafts email from it; each draft waits for them (email-drafts.ts).
  const draftDatabase = databaseId ?? (isRowRun(run.source) ? await databaseOfRow(run.source.rowId) : null);
  const sender = await draftSender(member, run.workspaceId, draftDatabase);
  // Email to the agent's own recipients, from the mailbox of the member the run works for
  // (send-mail.ts); not in the chat of someone who can't edit the agent, whose mailbox the
  // recipients' list (set by an editor) would otherwise send from.
  const mailer = run.source.kind === "chat" && !chatWrites ? null : await mailSender(member, run.workspaceId, agent.mailRecipients);
  // Its person closed the mailbox to the agent (or lost it) since the email came.
  if (arrival && !mailBoxes.includes(arrival.mailboxId)) {
    const gone: Ending = { status: "failed", code: "mailGone", steps: [...run.steps], usage: run.usage ?? { inputTokens: 0, outputTokens: 0, costUsd: 0, rounds: 0 } };
    return gone;
  }
  const mailTools = agentMailToolset(mailBoxes);
  // Files on the computer of the person chatting, while their desktop app is connected (computer.ts):
  // changing them only in the chat of someone who may edit the agent, as other changes.
  const computer = await computerFor(run.source, run.workspaceId, chatWrites);
  // A schedule's run on a database merges duplicates there only where the agent may edit it, and
  // not when its changes wait for review: a merge can't be proposed.
  const merges = !rowRun && !proposes && databaseId !== null && hasLevel((await pageAccessOf(agent.userId, databaseId)).level, "edit");
  // Leafdesk's further tools, on a run someone stands behind (and that doesn't read email from the start).
  const moreTools = askEveryTool || arrival ? null : allMoreTools;
  const tools = [
    // A schedule's run may end itself: nothing new to tell, or a task it can't do (finishRunCall).
    ...(scheduled ? [FINISH_RUN] : []),
    ...forReview(ownTools, proposes || mailProposes),
    ...(merges ? [MERGE_ROWS] : []),
    ...(sender ? [draftEmailTool(sender, { anyRow: Boolean(databaseId) })] : []),
    ...(mailer ? [sendEmailTool(mailer, agent.mailRecipients)] : []),
    ...mailTools,
    ...(remembers ? AGENT_MEMORY_TOOLS : []),
    ...(leavesNote ? [HANDOFF_TOOL] : []),
    // A channel's run asks before a web call carrying words the member didn't type: with no one to answer, it gets none.
    ...(channelRun && unanswered ? [] : webTools),
    ...(handoff ? handoff.tools : []),
    ...(reminder ? reminder.tools : []),
    // A chat's answer may carry files for the person (chat-files.ts).
    ...(chat ? [ATTACH_FILE_TOOL] : []),
    ...(computer ? computerTools(computer) : []),
    // A channel's run asks before each of a connection's calls (readOutside): with no one to answer, none either.
    ...(arrival || (channelRun && unanswered) ? [] : toolset.tools),
    ...(moreTools ? [FIND_TOOLS, USE_TOOL] : []),
  ];
  return { agent, run, member, chatWrites, outside, ctx, rowRun, scheduled, databaseId, maxWrites, eventRun, mention, channelRun, arrival, mentionEdits, askEveryTool, webTools, webNames, askedFor, askedInWords, webAsks, unattended, webTask, chat, proposes, ownApproved, clock, heldTo, heldToPerson, unanswered, toolset, connections, memoryOn, handedOff, remembers, leavesNote, mentionTools, handoff, reminded, reminder, mailBoxes, mailHeld, mailProposes, ownTools, reviews, draftDatabase, sender, mailer, mailTools, computer, merges, moreTools, tools };
}

export type RunSetup = Exclude<Awaited<ReturnType<typeof setUpRun>>, Ending>;

/**
 * Answers a run's tool calls as its setup holds them: `drain` answers the calls of the model's
 * latest turn (`take`) in order, and pauses at the first that waits for an owner or for the
 * agent's quiet hours to end. Starts from where the run left off (`state` of a run that waited).
 */
export function createDispatch(
  setup: RunSetup,
  {
    messages,
    steps,
    usage,
    registry,
    room,
    ...start
  }: {
    messages: AiMessage[];
    steps: AgentStepRecord[];
    usage: AgentRunUsage;
    registry: Registry;
    /** What is left of the prompt for a tool's result, after these messages. */
    room: (messages: AiMessage[]) => number;
    writes: number;
    externalChars: number;
    webFound: string[];
    mailRead: boolean;
    localRead: boolean;
    queue: AiToolCall[];
  },
) {
  const { agent, run, member, chatWrites, outside, ctx, rowRun, scheduled, databaseId, maxWrites, eventRun, mention, channelRun, askEveryTool, webNames, webAsks, unattended, webTask, chat, proposes, ownApproved, unanswered, toolset, remembers, leavesNote, mentionTools, handoff, reminded, reminder, mailBoxes, mailProposes, sender, mailer, mailTools, computer, moreTools, tools, memoryOn } = setup;
  let { writes, externalChars, webFound, mailRead, localRead, queue } = start;
  // Rows proposed from email (MAX_MAIL_PROPOSALS), apart from the changes it made.
  let proposals = steps.filter((s) => s.kind === "write" && s.outcome === "proposed").length;
  let reminders = remindersSet(steps);
  // Whether something a tool spent paused the agent for spending fast: the run ends at the next turn.
  let pausedBySpending = false;
  // How the run ends once finish_run is taken: right after that call, with nothing after it made.
  let ending: Ending | null = null;

  /** Refuses a change past the most one run (or a chat's message) may make; null while there is room. */
  const atLimit = (per: "run" | "message" = "run"): CallResult | null =>
    writes >= maxWrites ? { content: `You have made ${maxWrites} changes, the most one ${per} may make. Finish now.`, isError: true } : null;

  /** What the agent hears, and its steps keep, when its day's changes are used up: nothing was done. */
  const limited = (call: AiToolCall): CallResult => {
    const external = toolset.byName.get(call.name);
    return {
      content: `You have made the most changes this agent may make in a day (${agent.dailyChangeLimit}). Nothing was done; finish now, saying what is left to do.`,
      isError: true,
      // A file written on the computer is kept by its place and size, never its text (computer.ts).
      step: { kind: "tool", connectionId: external?.connection.id ?? null, tool: external?.tool.name ?? call.name, input: computerStepInput(call) ?? inputSummary(call.arguments), outcome: "limited" },
    };
  };

  /**
   * Makes one change, counted against the run's limit and the agent's daily one: the day's is taken
   * just before the change (daily-changes.ts), and given back when the change fails, unless a
   * failure may still have done it (`countsFailed`: a connection's call, as the run's own count).
   */
  const change = async (call: AiToolCall, make: () => Promise<CallResult>, { per = "run", countsFailed = false }: { per?: "run" | "message"; countsFailed?: boolean } = {}): Promise<CallResult> => {
    const over = atLimit(per);
    if (over) return over;
    const taken = await takeDailyChange(agent);
    if (!taken) return limited(call);
    const out = await make();
    if (!out.isError || countsFailed) writes += 1;
    else await giveBackDailyChange(agent, taken.day);
    return out;
  };

  // Emails this run sent (send_email): each one of the agent's daily changes, never of the run's own
  // limit, so a run that used its changes can still send its report. Saved at once, as a change is.
  let emailsSent = 0;
  /** Sends one email, counted against the agent's daily limit only: given back when it isn't sent. */
  const dailyOnly = async (call: AiToolCall, make: () => Promise<CallResult>): Promise<CallResult> => {
    const taken = await takeDailyChange(agent);
    if (!taken) return limited(call);
    const out = await make();
    if (!out.isError) emailsSent += 1;
    else await giveBackDailyChange(agent, taken.day);
    return out;
  };

  // The agent's quiet hours, if it has any: a call a rule lets go waits for their end.
  const quiet = agent.quietHours ? parseQuietHours(agent.quietHours) : null;
  // Text files attached to a chat's message: data from outside, as an email is.
  const filesAttached = "files" in run.context && (run.context.files?.length ?? 0) > 0;
  /**
   * Whether the run read what anyone may have written, which could steer its calls: a run no one
   * stands behind (askEveryTool), one a file or a channel's thread came with, or one whose steps read others' words
   * (readOthersWords: a web page or search, a connection tool's answer, a folder or file on the
   * person's computer, another agent's answer). An owner's "allow" rule doesn't hold there: each
   * call waits for a person, as without one. (A run that read email calls no connection's tool at all.)
   */
  // A channel's thread, which anyone in the channel may have written, goes with its task (or, on a
  // helper's run for one, the asking run's): read from the start.
  const readOutside = () => askEveryTool || filesAttached || channelRun || readOthersWords(steps);
  outside.read = readOutside;
  /**
   * Whether a chat run, at this point, has read nothing but its person's words and the workspace:
   * its message is theirs (typed in the app or sent from Telegram or Slack, not written by another connected
   * app), no file came with it, and it read no email (mailRead: this run's, or the conversation's
   * before), web page or search, connection tool's answer or other agent's answer (readOthersWords,
   * and externalChars for anything a service sent back). A chat of someone who can edit the agent
   * keeps a correction at once only then (memory.ts). Earlier turns count only for email: what else
   * they read reached the person in those answers, and this run only as that text.
   */
  const untainted = () =>
    run.source.kind === "chat" &&
    // No message of the turn came from another connected app (one of a merged queue may have);
    // runs queued before `otherApp` existed still need theirs to be a chat app's bot's.
    !run.source.otherApp &&
    (!run.source.fromApp || run.source.telegram === true || run.source.slack === true) &&
    !askEveryTool &&
    !filesAttached &&
    !mailRead &&
    externalChars === 0 &&
    !readOthersWords(steps);
  /** Whether an owner's "allow" rule still stands: its owner is still one. */
  const ruleStands = async (setBy: string | null) => Boolean(setBy) && (await findMembership(setBy!, run.workspaceId))?.role === "owner";

  /**
   * Keeps a checked create_row or update_row for review rather than making it (pending-changes.ts):
   * the person the run works for hears about it, else whoever made the agent, else the owners. One
   * a run new email started proposes is the mailbox owner's alone (its values come from their
   * mail): only they see it, so it needs a row they may edit themselves.
   */
  const propose = async (prepared: PreparedWrite, call: { arguments: Record<string, unknown> }): Promise<CallResult> => {
    const row = prepared.row;
    if (!row) return { content: "This change can't be proposed.", isError: true };
    const reason = typeof call.arguments.reason === "string" ? call.arguments.reason.trim() : "";
    if (!reason) return { content: "Give a reason: why you propose this change, for the person reviewing it. Nothing was proposed.", isError: true };
    const mailPerson = mailProposes ? member : null;
    if (mailPerson && !hasLevel((await pageAccessOf(mailPerson, row.rowId ?? row.databaseId)).level, "content")) {
      return { content: "The person whose email this is can't edit that row or database, so they couldn't approve it. Nothing was proposed.", isError: true };
    }
    const { replaced } = await proposeChange({
      workspaceId: run.workspaceId,
      kind: row.kind,
      databaseId: row.databaseId,
      rowId: row.rowId,
      payload: row.payload,
      before: row.before,
      reason,
      source: { kind: "agent_run", runId: run.id, automationRunId: run.source.kind === "automation" ? run.source.automationRunId : null },
      agent: { id: agent.id, userId: agent.userId },
      runId: run.id,
      for: mailPerson ? [mailPerson] : [member, agent.createdBy],
      privateTo: mailPerson,
    });
    return {
      content: `${replaced ? "Proposed again, in place of your earlier proposal for this row" : "Proposed"}: it waits for a person to approve it under For review and isn't made yet. Don't propose it again.`,
      step: { ...prepared.record, outcome: "proposed", pageId: row.rowId },
    };
  };

  /** Answers one tool call; null when it must wait for approval, or when to go on with it after the agent's quiet hours. */
  const answer = async (call: AiToolCall, approved: { userId: string } | null): Promise<Answered> => {
    const external = toolset.byName.get(call.name);
    // First, before what a run that read email may call: it changes nothing, and ends the run.
    // Something changed (an email sent, or rows proposed from email) is told in a report instead.
    if (call.name === FINISH_RUN.name && scheduled) {
      const changed = writes > 0 || proposals > 0 || steps.some((s) => s.kind === "email" && s.outcome === "sent");
      const checked = finishRunCall(call.arguments, { changed, untold: leftUntold(steps) });
      if ("error" in checked) return { content: checked.error, isError: true };
      ending =
        checked.outcome === "nothing_new"
          ? { status: "done", answer: checked.reason, quiet: true, steps, usage }
          : { status: "failed", code: "selfReported", answer: checked.reason, steps, usage };
      return { content: "The run ends here." };
    }
    // Turned off for spending fast mid-turn: the turn's other calls aren't made either.
    if (pausedBySpending) return { content: "This agent was turned off for spending fast. Nothing was done; finish now.", isError: true };
    // Email is anyone's words, and could steer the run into sending on what it read: once it read
    // some, it only reads pages, drafts email (whose recipients ai-chat-mail.ts checks) and proposes
    // notes, which its person reads before any run does (agents/memory.ts). Nothing
    // waits for approval either: an owner who isn't the mailbox's would see what it would send.
    // A run reading email proposes rows to its person alone, who approves them (see propose): one
    // new email or a schedule started from the start, a chat once it read email. Each counts toward
    // the agent's day's changes, never the run's own few: a day's email can bring many.
    if (mailProposes && (!chat || mailRead) && PROPOSE_TOOLS.has(call.name)) {
      if (proposals >= MAX_MAIL_PROPOSALS) return { content: `You have proposed ${MAX_MAIL_PROPOSALS} changes, the most one run may. Finish now, saying what is left.`, isError: true };
      const prepared = await prepareWrite(ctx, run.workspaceId, null, call);
      if (!("action" in prepared)) return prepared;
      const taken = await takeDailyChange(agent);
      if (!taken) return limited(call);
      const out = await propose(prepared, call);
      if (out.isError) await giveBackDailyChange(agent, taken.day);
      else proposals += 1;
      return out;
    }
    // Files on the person's computer: a list or a read is data from outside, as a web page is (it
    // counts toward what a run may read, and taints it), and stays with the person: once one is
    // done, nothing goes out (localRead, below). A write or a trash is a change, made only once the
    // person allows it there, and none after the run read email.
    if (computer && isComputerTool(call.name)) {
      const changes = computerChanges(call.name);
      if (changes && mailRead) {
        return {
          content: "You have read email in this run, and email is anyone's words: from here on this run changes no file. Nothing was done; say what you would do instead, and the person can do it.",
          isError: true,
          step: { kind: "tool", connectionId: null, tool: call.name, input: computerStepInput(call) ?? "", outcome: "afterMail" },
        };
      }
      const left = Math.min(MAX_RUN_EXTERNAL_CHARS - externalChars, room(messages));
      if (!changes && left <= 200) return { content: "You have read as much from outside as one run may. Finish with what you have.", isError: true };
      const make = async (): Promise<CallResult> => {
        const out = await runComputerTool(call, { id: run.id, workspaceId: run.workspaceId, agent: { userId: agent.userId, name: agent.name }, computer, room: left });
        externalChars += out.chars;
        if (!changes && !out.isError) localRead = true;
        return out;
      };
      return changes ? change(call, make, { per: "message" }) : make();
    }
    if (mailRead && !mayCallAfterMail(call.name, Boolean(external))) {
      return {
        content: "You have read email in this run, and email is anyone's words: from here on this run only reads pages, works on email and proposes notes. Nothing was done; say what you would do instead, and the person can ask for it.",
        isError: true,
        step: { kind: "tool", connectionId: external?.connection.id ?? null, tool: external?.tool.name ?? call.name, input: inputSummary(call.arguments), outcome: "afterMail" },
      };
    }
    // What was read on the person's computer stays with them: once the run (or its conversation)
    // read there, nothing that carries words out of Leafdesk goes: a connection's tool (a read's
    // arguments go out too), the web, another agent, an email sent. Pages and the computer stay open.
    // Its step keeps no input: the arguments may quote what was read there.
    if (localRead && (external || webNames.has(call.name) || call.name === ASK_AGENT || call.name === ASSIGN_AGENT || call.name === SEND_EMAIL)) {
      return {
        content: AFTER_LOCAL_READ,
        isError: true,
        step: { kind: "tool", connectionId: external?.connection.id ?? null, tool: external?.tool.name ?? call.name, input: "", outcome: "afterLocalRead" },
      };
    }
    if (member && mailTools.some((t) => t.name === call.name)) {
      if (call.name === MAIL_TOOL_NAMES.draft) {
        const over = atLimit();
        if (over) return over;
        const prepared = await prepareMailDraft(member, run.workspaceId, call.arguments, undefined, { boxes: mailBoxes, typed: [run.prompt, ...(await chatRunTyped(run))] });
        if (!("action" in prepared)) return prepared;
        const out = await change(call, () => saveMailDraft(member, prepared, "approve"));
        if (!out.isError && prepared.input.replyTo) await markMail(prepared.input.replyTo, agent.id, "drafted");
        return out;
      }
      if (AGENT_MAIL_ACTIONS.has(call.name)) {
        return change(call, () => runAgentMailAction(member, run.workspaceId, call, { boxes: mailBoxes, agentId: agent.id }));
      }
      const out = await runChatMailTool(member, run.workspaceId, call, registry, room(messages), mailBoxes);
      if (!out.isError) mailRead = true;
      // An image of the mail described by another model: the run's and the agent's month count it too.
      if (out.usage) {
        usage.inputTokens += out.usage.inputTokens;
        usage.outputTokens += out.usage.outputTokens;
        usage.costUsd += out.usage.costUsd;
        const monthTokens = await addAgentUsage(agent.id, out.usage).catch((error) => {
          console.error("[agents] could not count what a run used", redactError(error));
          return null;
        });
        // As a turn's own spending is: its limit nearing is told of, a new agent spending fast paused.
        if (monthTokens !== null && (await noticeAgentSpending(agent, monthTokens)) === "paused") pausedBySpending = true;
      }
      return out;
    }
    if (external) {
      // An owner's rule declining the tool holds over everything, a person's approval given before it too.
      if (external.rule?.rule === "deny") {
        return {
          content: `An owner declined every call of "${external.tool.name}" for you: it was not sent. Don't call it again; finish without it, saying what you would have done.`,
          isError: true,
          step: { kind: "tool", connectionId: external.connection.id, tool: external.tool.name, input: inputSummary(call.arguments), outcome: "denied" },
        };
      }
      const writing = external.tool.kind === "write";
      if (writing) {
        const over = atLimit();
        if (over) return over;
        // No one is asked about, nor waits for, a change the day has no room for.
        if (!approved && (await dailyLimitReached(agent))) return limited(call);
      }
      // An owner's "allow" rule sends a write without asking, on a run nothing outside could steer.
      const byRule = writing && !approved && external.rule?.rule === "allow" && !readOutside() && (await ruleStands(external.rule.setBy));
      if ((writing || askEveryTool) && !approved && !byRule) return null;
      if (byRule) {
        const until = quiet ? quietUntil(new Date(), quiet) : null;
        if (until) return { deferUntil: until };
      }
      const left = MAX_RUN_EXTERNAL_CHARS - externalChars;
      if (left <= 200) return { content: "You have read as much from connected services as one run may. Finish with what you have.", isError: true };
      const send = async () => {
        const out = await runConnectionTool({
          entry: external,
          args: call.arguments,
          actorId: agent.userId,
          approvedBy: approved?.userId ?? null,
          allowedByRule: byRule ? { setBy: external.rule?.setBy ?? null } : undefined,
          room: left,
        });
        externalChars += out.chars;
        return out;
      };
      // A write that failed may still have been done there: it counts all the same.
      return writing ? change(call, send, { countsFailed: true }) : send();
    }
    // Kept notes that didn't fit in the prompt (offered only then, run.ts).
    if (call.name === READ_MEMORY_TOOL.name) {
      if (!memoryOn) return { content: `There is no tool "${call.name}" in this run.`, isError: true };
      return readMemory(agent.userId, run.workspaceId, call.arguments);
    }
    // Notes change nothing in the workspace: they don't count as changes.
    if (AGENT_MEMORY_TOOL_NAMES.has(call.name)) {
      if (!remembers) return { content: `There is no tool "${call.name}" in this run.`, isError: true };
      // A correction said in the chat of someone who can edit the agent, while nothing else spoke,
      // is kept at once; any other note is proposed (lib/memory-rule.ts).
      const personSaid = run.source.kind === "chat" && chatWrites && untainted();
      // Dropping a note isn't proposed, so it happens only where a correction is kept at once: in
      // such a chat. A run that read others' words (a web page, a connection, email) could be
      // steered to forget what it was told; one no one is chatting with leaves it to its owners.
      if (call.name === "forget" && !personSaid) {
        return {
          content: "Notes are dropped only in the chat of someone who can edit you, in a turn that read nothing from outside. Nothing was forgotten; tell the person which note is wrong, and they can remove it on the Memory page.",
          isError: true,
        };
      }
      const saidBy = run.source.kind === "chat" && noteWrite({ agent: true, personSaid }) === "keep" ? run.source.userId : null;
      const kept = steps.filter((s) => s.kind === "memory" && s.action === "correct").length;
      return runAgentMemoryTool(agent, run, call, { correction: saidBy ? { saidBy, kept } : null });
    }
    if (call.name === HANDOFF_TOOL.name) {
      if (!leavesNote) return { content: `There is no tool "${call.name}" in this run.`, isError: true };
      return runHandoffTool(run.id, call);
    }
    // A file for the person, on their answer: one of the run's changes, which no one approves (chat-files.ts).
    if (call.name === ATTACH_FILE) {
      if (!chat) return { content: `There is no tool "${call.name}" in this run.`, isError: true };
      return change(call, () => attachChatFile(run, agent.userId, call), { per: "message" });
    }
    // A reminder is for the person the run works for, and changes nothing in the workspace.
    if (call.name === REMIND_TOOL_NAME) {
      if (!reminder || !reminded) return { content: `There is no tool "${call.name}" in this run.`, isError: true };
      if (reminders >= MAX_REMINDERS_PER_RUN) return { content: `You have set ${MAX_REMINDERS_PER_RUN} reminders, the most one run may set.`, isError: true };
      const out = await setReminder({ workspaceId: run.workspaceId, actorId: agent.userId, personId: reminded, timeZone: reminder.timeZone }, call);
      if (!out.isError) reminders += 1;
      return out;
    }
    // Its own reminders for that person, as they are now: what the person or another agent set
    // stays out of its sight and reach. Cancelling or moving one changes nothing in the workspace either.
    if (call.name === LIST_REMINDERS_TOOL_NAME || call.name === CHANGE_REMINDER_TOOL_NAME) {
      if (!reminder || !reminded) return { content: `There is no tool "${call.name}" in this run.`, isError: true };
      const scope = { workspaceId: run.workspaceId, personId: reminded, timeZone: reminder.timeZone, actorId: agent.userId };
      if (call.name === LIST_REMINDERS_TOOL_NAME) {
        const listed = await listReminders(scope);
        return { content: listed.content, step: { kind: "tool", connectionId: null, tool: LIST_REMINDERS_TOOL_NAME, input: String(listed.count), outcome: "done" } };
      }
      const change = await prepareReminderChange(scope, call);
      return "action" in change ? applyReminderChange(scope, change) : change;
    }
    // Reading the web changes nothing: it counts as reading from outside, not as a change.
    if (webNames.has(call.name)) {
      if (unattended && !approved && !scheduledWebCallGoes(call, { typed: webTask, found: webFound })) {
        return {
          content:
            "This address is neither in your task nor among the results of your searches, and no one can approve it on this run: nothing was sent. Read only those addresses, or finish without it.",
          isError: true,
          step: { kind: "tool", connectionId: null, tool: call.name, input: inputSummary(call.arguments), outcome: "refused" },
        };
      }
      if (!unattended && !approved && agentWebCallAsks(call, webAsks)) {
        // No owner answers for this run: waiting would only run out of time.
        if (unanswered && !askEveryTool) {
          return {
            content: "This address or search isn't in the message you were given, and no one can approve it on this run: nothing was sent. Use only the addresses and search words of the message, or finish without it.",
            isError: true,
          };
        }
        return null;
      }
      const left = Math.min(MAX_RUN_EXTERNAL_CHARS - externalChars, room(messages));
      if (left <= 200) return { content: "You have read as much from outside as one run may. Finish with what you have.", isError: true };
      const out = await runWebTool(call, { room: left, decidedBy: approved?.userId ?? null });
      externalChars += out.chars;
      if (out.found) webFound = [...webFound, ...out.found];
      return out;
    }
    // An owner's chat changes what they ask for at once: they are there, and asked.
    if (chatWrites && WRITE_TOOL_NAMES.has(call.name)) {
      const over = atLimit("message");
      if (over) return over;
      const prepared = await prepareWrite(ctx, run.workspaceId, null, call);
      if (!("action" in prepared)) return prepared;
      return change(call, () => asAutomation(() => applyWrite(prepared, "approve", registry)), { per: "message" });
    }
    // A row an event's run would add, proposed for review.
    if (proposes && eventRun && call.name === CREATE_ROW.name) {
      const over = atLimit();
      if (over) return over;
      const prepared = await prepareWrite(ctx, run.workspaceId, null, call);
      if (!("action" in prepared)) return prepared;
      return change(call, () => propose(prepared, call));
    }
    if (ownApproved.has(call.name)) {
      const over = atLimit();
      if (over) return over;
      // Checked first, so a call that can't be made goes back to the agent rather than to an owner.
      const prepared = await prepareWrite(ctx, run.workspaceId, null, call);
      if (!("action" in prepared)) return prepared;
      // As a connection's writing tool: a trusted service is one whose events the agent may read, not
      // one that may change the workspace without an owner.
      if (!approved) return (await dailyLimitReached(agent)) ? limited(call) : null;
      return change(call, () => asAutomation(() => applyWrite(prepared, "approve", registry)));
    }
    // A schedule's run adds rows to the database it looks after, and to no other, as update_row changes them.
    if (databaseId && call.name === CREATE_ROW.name) {
      return change(call, async () => {
        const prepared = await prepareWrite(ctx, run.workspaceId, null, call);
        if (!("action" in prepared)) return prepared;
        if (prepared.row?.databaseId !== databaseId) {
          return { content: `You may add rows only to the database this run looks after (database_id ${databaseId}). Nothing was added.`, isError: true };
        }
        return proposes ? propose(prepared, call) : asAutomation(() => applyWrite(prepared, "approve", registry));
      });
    }
    const mentionWrite = mention && mentionTools.some((t) => t.name === call.name);
    if ((rowRun || databaseId || mentionWrite) && (call.name === "update_row" || call.name === "edit_page" || call.name === "add_comment")) {
      return change(call, () =>
        call.name === "add_comment" ? addComment(agent, run, call.arguments) : changeRow(ctx, run, call, proposes && call.name === UPDATE_ROW.name ? propose : null),
      );
    }
    if (sender && call.name === DRAFT_EMAIL) {
      const over = atLimit();
      if (over) return over;
      const rowId = databaseId ? (typeof call.arguments.row_id === "string" ? call.arguments.row_id.trim() : "") : isRowRun(run.source) ? run.source.rowId : "";
      if (databaseId && !(await isRowOf(rowId, databaseId))) {
        return { content: `You may draft email only on rows of the database this run looks after (database_id ${databaseId}).`, isError: true };
      }
      return change(call, () =>
        draftRowEmail({
          workspaceId: run.workspaceId,
          agent: { id: agent.id, userId: agent.userId },
          runId: run.id,
          automationRunId: run.source.kind === "automation" ? run.source.automationRunId : null,
          sender,
          rowId,
          args: call.arguments,
        }),
      );
    }
    // A report sent to the agent's own recipients: one of the agent's changes for the day, not of the run's.
    if (mailer && call.name === SEND_EMAIL) {
      const sentBefore = steps.some((s) => s.kind === "email" && s.pageId === null);
      return dailyOnly(call, () => sendAgentEmail({ sender: mailer, recipients: agent.mailRecipients, args: call.arguments, sentBefore }));
    }
    if (databaseId && call.name === MERGE_ROWS.name && tools.includes(MERGE_ROWS)) {
      return change(call, () => mergeRowsTool(ctx, agent, databaseId, call.arguments));
    }
    const handedTo = handoff?.call(call, room(messages));
    if (handedTo) return handedTo;
    if (moreTools && MORE_TOOL_NAMES.has(call.name)) {
      const more = await moreTools.open();
      if (call.name === FIND_TOOLS.name) return { content: findTools(more, typeof call.arguments.query === "string" ? call.arguments.query.slice(0, 200) : "", room(messages)) };
      const picked = pickMoreTool(more, call);
      if (!("tool" in picked)) return picked;
      if (mailRead && picked.tool.writes) {
        return { content: "Email was read in this conversation: this run only reads pages and drafts email. Nothing was done; say what you would do instead, so the person can do it.", isError: true };
      }
      if (picked.tool.writes) return change(call, () => asAutomation(() => callMoreTool(more, picked, room(messages))), { per: "message" });
      return callMoreTool(more, picked, room(messages));
    }
    if (moreTools && call.name === "read_page" && isDocsAddress(call.arguments.page_id) && tools.some((t) => t.name === "read_page")) {
      const docs = await readDocsTopic(call.arguments.page_id, room(messages));
      return docs ? { content: docs } : { content: "There is no such docs topic.", isError: true };
    }
    if (!tools.some((t) => t.name === call.name)) return { content: `There is no tool "${call.name}" in this run.`, isError: true };
    const out: ToolOutcome = await runTool(ctx, run.workspaceId, undefined, call, registry, room(messages));
    return out;
  };

  /**
   * Saves where the run is, after a change it can't take back (or an owner's answer used up): a run
   * taken again (put back for the AI allowance, or after its worker stopped) goes on from here
   * rather than making the change a second time.
   */
  const checkpoint = () =>
    db
      .update(agentRun)
      .set({ state: { messages, queue, rounds: usage.rounds, writes, externalChars, webFound, mailRead, localRead }, steps: redactValue(steps), usage })
      .where(eq(agentRun.id, run.id));

  /** Answers the calls waiting in `queue`, in order; the run pauses at the first that needs approval. */
  const drain = async (decision: AgentRunState["decision"] | undefined): Promise<Paused | null> => {
    let pendingDecision = decision;
    while (queue.length) {
      const call = queue[0];
      // What a run left behind it: a run taken again after a restart starts over, and would do it twice.
      const made = () => writes + emailsSent + proposals + remindersSet(steps);
      const writesBefore = made();
      const answered = Boolean(pendingDecision);
      let out: Answered;
      if (pendingDecision) {
        out = await decided(call, pendingDecision, toolset, answer, ownApproved);
        pendingDecision = undefined;
      } else out = await answer(call, null);
      if (!out || isDeferred(out)) {
        // A connection's tool, or Leafdesk's own (create_row on an event's run): no connection.
        const external = toolset.byName.get(call.name);
        return {
          status: "awaiting",
          state: { messages, queue, rounds: usage.rounds, writes, externalChars, webFound, mailRead, localRead },
          pending: {
            callId: call.id,
            connectionId: external?.connection.id ?? null,
            tool: external?.tool.name ?? call.name,
            arguments: call.arguments,
            askedAt: new Date().toISOString(),
            ...(out ? { deferredUntil: out.deferUntil.toISOString() } : {}),
          },
          steps,
          usage,
        };
      }
      if (out.step) steps.push(out.step);
      messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: out.content, isError: out.isError });
      queue = queue.slice(1);
      // finish_run: the calls after it in the turn are not made.
      if (ending) {
        queue = [];
        return null;
      }
      // A chat's steps are saved as they come: the person follows them (chat.ts chatTurn).
      if (answered || made() !== writesBefore || chat) await checkpoint();
    }
    return null;
  };

  return {
    drain,
    /** How the run ends, once it took finish_run. */
    get ending() {
      return ending;
    },
    /** Whether something a tool spent paused the agent for spending fast: the run ends at the next turn. */
    get pausedBySpending() {
      return pausedBySpending;
    },
    /** The calls of the model's latest turn, answered next by `drain`. */
    take(calls: AiToolCall[]) {
      queue = calls;
    },
  };
}

/**
 * Answers the call an owner decided on: sends it (approved), or tells the agent it was declined or
 * sent back. `ownApproved`: Leafdesk's own tools the run waits on, made by `answer` once approved.
 */
async function decided(
  call: AiToolCall,
  decision: NonNullable<AgentRunState["decision"]>,
  toolset: ConnectionToolset,
  answer: (call: AiToolCall, approved: { userId: string } | null) => Promise<Answered>,
  ownApproved: ReadonlySet<string>,
): Promise<CallResult> {
  const external = toolset.byName.get(call.name);
  const own = ownApproved.has(call.name);
  if (!external && !own) {
    // The tool was taken away (or its connection) while the call waited: nothing is sent.
    return { content: `The tool "${call.name}" is no longer allowed to you. Nothing was sent; finish without it.`, isError: true };
  }
  const base = {
    kind: "tool" as const,
    connectionId: external?.connection.id ?? null,
    tool: external?.tool.name ?? call.name,
    input: inputSummary(call.arguments),
    decidedBy: decision.userId,
  };
  if (decision.decision === "approve") {
    // Approved, a call goes now: neither asked about again nor held for quiet hours.
    const out = await answer(call, { userId: decision.userId });
    return out && !isDeferred(out) ? out : { content: `The tool "${call.name}" can't be called now. Nothing was sent; finish without it.`, isError: true };
  }
  if (decision.decision === "decline") {
    return { content: "A person declined this call: it was not sent. Don't call it again in this run; finish without it, saying what you would have done.", step: { ...base, outcome: "declined" } };
  }
  return {
    content: `A person sent this call back before it was sent, with this note:\n<note>${(decision.note ?? "").replace(/</g, "‹")}</note>\nNothing was sent. Prepare the call again with the note in mind, and call the tool again.`,
    step: { ...base, outcome: "redo", note: decision.note },
  };
}

/** Whether a page is a row (not a template) of the database, still out of the trash. */
async function isRowOf(rowId: string, databaseId: string) {
  if (!rowId) return false;
  const [row] = await db
    .select({ parentId: page.parentId, archivedAt: page.archivedAt, isTemplate: page.isTemplate, inTemplate: page.inTemplate })
    .from(page)
    .where(eq(page.id, rowId));
  return Boolean(row && row.parentId === databaseId && !row.archivedAt && !row.isTemplate && !row.inTemplate);
}

/**
 * update_row and edit_page, made at once (no one to ask) and starting no automations: on the run's
 * row only, on the page a mention's comment is on, or, on a schedule's run, on the rows of the
 * database it looks after. A row's text
 * changed shows on its page for review, as any AI change does.
 */
async function changeRow(
  ctx: ops.OperationContext,
  run: Run,
  call: { name: string; arguments: Record<string, unknown> },
  propose: ((prepared: PreparedWrite, call: { arguments: Record<string, unknown> }) => Promise<CallResult>) | null,
): Promise<CallResult> {
  const given = call.name === "edit_page" ? call.arguments.page_id : call.arguments.row_id;
  const rowId = typeof given === "string" ? given.trim() : "";
  const databaseId = scheduledDatabase(run.source);
  if (databaseId) {
    if (!(await isRowOf(rowId, databaseId))) {
      return { content: `You may change only rows of the database this run looks after (database_id ${databaseId}). Nothing was changed.`, isError: true };
    }
  } else if (isMentionRun(run.source)) {
    if (rowId !== run.source.pageId) {
      return { content: `You may change only the page the comment is on (page_id ${run.source.pageId}). Nothing was changed.`, isError: true };
    }
  } else if (!isRowRun(run.source)) {
    return { content: "This run has no row to change.", isError: true };
  } else if (rowId !== run.source.rowId) {
    return { content: `You may change only the row that started this run (row_id ${run.source.rowId}). Nothing was changed.`, isError: true };
  }
  const prepared = await prepareWrite(ctx, run.workspaceId, null, call);
  if (!("action" in prepared)) return prepared;
  // The agent's changes wait for review: kept, not made.
  if (propose) return propose(prepared, call);
  const registry: Registry = { sources: [], byKey: new Map() };
  return asAutomation(() => applyWrite(prepared, "approve", registry));
}

/**
 * merge_rows on a schedule's run: rows of the database it looks after only, made at once and
 * starting no automations, as update_row is. The merge checks the agent's access to every row.
 */
async function mergeRowsTool(ctx: ops.OperationContext, agent: Agent, databaseId: string, args: Record<string, unknown>): Promise<CallResult> {
  const keptId = typeof args.kept_row_id === "string" ? args.kept_row_id.trim() : "";
  const others = Array.isArray(args.other_row_ids) ? args.other_row_ids.filter((v): v is string => typeof v === "string").map((v) => v.trim()) : [];
  const choices =
    args.properties && typeof args.properties === "object" && !Array.isArray(args.properties)
      ? Object.fromEntries(Object.entries(args.properties as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"))
      : undefined;
  const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : undefined;
  const record = (outcome: "done" | "failed") =>
    ({ kind: "write", action: "mergeRows", outcome, targetId: keptId || null, pageId: outcome === "done" ? keptId : null, title: null, changes: [] }) satisfies ChatWriteRecord;
  for (const id of [keptId, ...others]) {
    if (!(await isRowOf(id, databaseId))) {
      return { content: `You may merge only rows of the database this run looks after (database_id ${databaseId}). Nothing was merged.`, isError: true };
    }
  }
  try {
    // The heading over each merged body is in the language of the person who set the agent up.
    const locale = agent.createdBy ? await recipientLocale(agent.createdBy, null) : undefined;
    const out = await asAutomation(() =>
      ops.mergeRows(ctx, { database_id: databaseId, kept_row_id: keptId, other_row_ids: others, properties: choices, title, dry_run: false }, { locale }),
    );
    return { content: `Merged ${others.length} ${others.length === 1 ? "row" : "rows"} into the row ${keptId}: ${JSON.stringify(out)}`, step: record("done") };
  } catch (error) {
    if (error instanceof AccessError || error instanceof PropertyValueError || error instanceof ToolInputError) {
      return { content: `Nothing was merged: ${error.message}`, isError: true, step: record("failed") };
    }
    throw error;
  }
}

/** add_comment: a new comment thread, as the agent, on the run's row (or a row of the database a schedule's run looks after). */
async function addComment(agent: Agent, run: Run, args: Record<string, unknown>): Promise<CallResult> {
  const databaseId = scheduledDatabase(run.source);
  let rowId: string;
  if (databaseId) {
    rowId = typeof args.row_id === "string" ? args.row_id.trim() : "";
    if (!(await isRowOf(rowId, databaseId))) return { content: `You may comment only on rows of the database this run looks after (database_id ${databaseId}).`, isError: true };
  } else if (isRowRun(run.source)) {
    rowId = run.source.rowId;
  } else return { content: "This run has no row to comment on.", isError: true };
  const text = typeof args.text === "string" ? args.text.trim().slice(0, MAX_COMMENT) : "";
  if (!text) return { content: "add_comment needs text.", isError: true };
  try {
    await asAutomation(() => changeComments(agent.userId, rowId, { type: "createThread", body: text }));
    return { content: "The comment was added.", step: { kind: "comment", pageId: rowId, text: redactText(text).slice(0, 500), outcome: "done" } };
  } catch (error) {
    if (error instanceof AccessError) {
      return { content: "You may not comment on this row: you can only read it.", isError: true, step: { kind: "comment", pageId: rowId, text: redactText(text).slice(0, 500), outcome: "failed" } };
    }
    throw error;
  }
}

/**
 * Whether a mention's run may change the page its comment is on (the agent, within the member's
 * access, may edit it) and whether that page is a database row (update_row).
 */
async function mentionEditing(agent: Agent, pageId: string): Promise<{ edits: boolean; row: boolean }> {
  const { page: target, level } = await pageAccessOf(agent.userId, pageId);
  if (!target || !hasLevel(level, "edit")) return { edits: false, row: false };
  const [parent] = target.parentId ? await db.select({ kind: page.kind }).from(page).where(eq(page.id, target.parentId)) : [];
  return { edits: true, row: parent?.kind === "database" };
}

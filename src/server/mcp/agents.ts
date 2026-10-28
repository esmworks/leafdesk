import { ICON_INPUT, ICON_RULE } from "@/lib/icon";
import * as z from "zod";
import {
  type AgentMemoryView,
  AGENT_ACCESS_LEVELS,
  AGENT_MODELS,
  isRowRun,
  MAX_AGENT_DESCRIPTION,
  MAX_AGENT_HELPERS,
  MAX_HANDOFFS_PER_RUN,
  MAX_AGENT_SCHEDULES,
  MAX_SCHEDULE_TASK,
  MAX_SCHEDULED_WRITES,
  MAX_AGENT_PROMPT,
  MAX_AGENT_TOKEN_LIMIT,
  MAX_REQUESTED_RUNS,
  MAX_AGENT_INSTRUCTIONS,
  MAX_AGENT_NAME,
  MAX_AGENT_SKILLS,
  MAX_AGENTS,
  MAX_AGENT_PROPOSALS,
  type AgentAccessView,
  AGENT_ROW_CHANGES,
  type AgentModel,
  type AgentRowChanges,
  type AgentSkillSkip,
  type AgentSkillView,
  type AgentRunView,
  type AgentScheduleView,
  type AgentStepRecord,
  type AgentUsageMonth,
  type AgentView,
} from "@/lib/agents";
import { MAX_AGENT_MAIL_RECIPIENTS } from "@/lib/agent-mail";
import { MAX_AGENT_REQUEST, type AgentDraft, type DraftTrigger } from "@/lib/agent-draft";
import { AGENT_SHARE_LEVELS, type AgentSharingView } from "@/lib/agent-sharing";
import type { AgentRestoreSkip, AgentVersionView } from "@/lib/agent-versions";
import { MAX_AGENT_CHAT_MESSAGE } from "@/lib/agent-chat";
import { MAX_MEMORIES, MAX_MEMORY_CHARS } from "@/lib/ai-chat";
import { AgentChatRefusal } from "@/server/agents/chat";
import { pageLabel } from "@/lib/labels";
import { MAX_REPEAT_INTERVAL, REPEAT_FREQUENCIES } from "@/lib/schedule";
import { AgentError } from "@/server/agents/manage";
import { AccessError, ConnectedAppReadOnlyError } from "@/server/access";
import { id } from "@/server/operations";
import { PermissionError } from "@/server/permissions";
import { pageUrl, ToolInputError } from "./format";

/**
 * Agents over MCP: the tools' input schemas, their output (snake_case, with app links), and
 * AgentError turned into errors with a next step a model can take.
 */

/** Longest chat_with_agent waits for an answer: clients give a call about a minute. */
export const MAX_CHAT_WAIT = 50;

const nameInput = z.string().min(1).max(MAX_AGENT_NAME);
const iconInput = z
  .string()
  .min(1)
  .max(64)
  .nullable()
  .describe(`${ICON_INPUT} null removes it.`);
const noteInput = z.string().min(1).max(MAX_MEMORY_CHARS);
const memoryIdInput = z.string().min(1).max(100).describe("The note's memory_id, from get_agent's memory.");
const descriptionInput = z.string().max(MAX_AGENT_DESCRIPTION).describe("A line on what the agent is for, shown where people pick an agent.");
const instructionsInput = z
  .string()
  .max(MAX_AGENT_INSTRUCTIONS)
  .describe(
    `What the agent does and how, in plain language (at most ${MAX_AGENT_INSTRUCTIONS} characters): it reads them on every run, before the task an automation gives it.`,
  );

const modelInput = z
  .enum(AGENT_MODELS)
  .describe(
    'Which of the server\'s models its runs use: "main" (its main model, for work that needs judgment) or "fast" (its cheaper fast model, for routine, well-defined jobs such as summaries or sorting rows). "fast" runs on the main model where the server has no fast model or the workspace\'s AI is an own AI account.',
  );
const helpersInput = z
  .array(id("agent"))
  .max(MAX_AGENT_HELPERS)
  .describe(
    `Its "Agents it can ask": ids of other agents of the workspace (list_agents), not archived, at most ${MAX_AGENT_HELPERS}. On a run it may hand part of its task to one of them with ask_agent (at most ${MAX_HANDOFFS_PER_RUN} times a run), and gets its answer; each runs with its own access, tools and limits and can't ask further agents. Replaces the whole list; [] clears it.`,
  );

const repeatInput = z
  .object({
    frequency: z.enum(REPEAT_FREQUENCIES as [string, ...string[]]).describe("daily, weekly, monthly or yearly."),
    interval: z.number().int().min(1).max(MAX_REPEAT_INTERVAL).default(1).describe("Every how many days, weeks, months or years (default 1)."),
    weekdays: z
      .array(z.number().int().min(0).max(6))
      .min(1)
      .max(7)
      .optional()
      .describe("Weekly only (and needed then): the days it runs, 0 for Sunday to 6 for Saturday."),
    time: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .describe('The time of day it runs, "HH:MM" on a 24-hour clock, in time_zone.'),
    start: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe("The first day it may run, YYYY-MM-DD in time_zone (default today). A monthly rule runs on this day of the month, a yearly one on this date."),
  })
  .describe("When it runs.");
const timeZoneInput = z.string().min(1).max(64).describe(`The IANA time zone its days and time are in, such as "Europe/Istanbul": the user's own, unless they say otherwise.`);
const scheduleTaskInput = z
  .string()
  .min(1)
  .max(MAX_SCHEDULE_TASK)
  .describe(`What the agent does on each run, in plain language (at most ${MAX_SCHEDULE_TASK} characters); it follows its instructions and skills too.`);
const scheduleDatabaseInput = id("database")
  .nullable()
  .describe(
    `A database for the agent to look after: each run reads it first and may change and comment on its rows (at most ${MAX_SCHEDULED_WRITES} changes a run). The user must be able to open it, and the agent needs edit access to change rows (set_agent_access). null: the run only reads and reports.`,
  );

const webAccessInput = z
  .boolean()
  .describe(
    "Whether its runs may read public web pages (read_web_page), and search the web where the server has a search service (search_web); default false. Leave it off for agents that should only work with the workspace: a run with it could send what it read to a web address.",
  );

const mailRecipientsInput = z
  .array(z.string().email().max(320))
  .max(MAX_AGENT_MAIL_RECIPIENTS)
  .describe("Addresses its runs may email (send_email), the whole list; [] clears it. Mail goes from the mailbox of the person a run works for. Only addresses the user named.");

const rowChangesInput = z
  .enum(AGENT_ROW_CHANGES)
  .describe(
    'How its runs change database rows: "direct" (default) makes the changes; "review" proposes each row it would add or change for a person to approve, edit or dismiss first (list_pending_changes). Chats with the agent change rows directly either way: the person is there.',
  );

export const agentInputs = {
  list: z.object({
    workspace_id: id("workspace"),
    include_archived: z.boolean().default(false).describe("Also list archived agents (default false)."),
  }),
  agentId: z.object({ agent_id: id("agent") }),
  draft: z.object({
    workspace_id: id("workspace"),
    description: z
      .string()
      .min(1)
      .max(MAX_AGENT_REQUEST)
      .describe(`What the agent should do, in the user's words and language (at most ${MAX_AGENT_REQUEST} characters): what it reads, what it does and when.`),
  }),
  create: z.object({
    workspace_id: id("workspace"),
    copy_of: id("agent")
      .optional()
      .describe("An agent to copy: its settings, skills, helpers and (owners) connection tools; fields given replace them. No pages, schedules or memory."),
    name: nameInput.optional().describe("The agent's name: its changes and comments show it. Needed without copy_of."),
    icon: iconInput.optional(),
    description: descriptionInput.optional(),
    instructions: instructionsInput.optional(),
    enabled: z.boolean().optional().describe("Whether it runs (default true). A paused agent's queued runs end without doing anything."),
    model: modelInput.optional().describe(`${modelInput.description} Default "main".`),
    web_access: webAccessInput.optional(),
    row_changes: rowChangesInput.optional(),
    helper_agent_ids: helpersInput.optional(),
  }),
  // No defaults here: what is left out stays as it is.
  update: z.object({
    agent_id: id("agent"),
    name: nameInput.optional(),
    icon: iconInput.optional(),
    description: descriptionInput.optional(),
    instructions: instructionsInput.optional(),
    enabled: z.boolean().optional().describe("Pause (false) or resume (true) the agent."),
    web_access: webAccessInput.optional(),
    mail_recipients: mailRecipientsInput.optional(),
    row_changes: rowChangesInput.optional(),
    monthly_token_limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_AGENT_TOKEN_LIMIT)
      .nullable()
      .optional()
      .describe(
        "The most tokens (input and output) its runs may use in a calendar month (UTC); a run stops once the month reaches it, and runs aren't started until the next month. null removes the limit.",
      ),
    model: modelInput.optional(),
    helper_agent_ids: helpersInput.optional(),
  }),
  run: z.object({
    agent_id: id("agent"),
    task: z
      .string()
      .min(1)
      .max(MAX_AGENT_PROMPT)
      .describe(`What the agent should do this time, in plain language (at most ${MAX_AGENT_PROMPT} characters); it follows its instructions and skills too.`),
    row_id: id("row")
      .optional()
      .describe("A database row for the run to work on: the agent may then change and comment on that row. Leave out for a run that only reads and answers."),
  }),
  schedule: z.object({
    agent_id: id("agent"),
    repeat: repeatInput,
    time_zone: timeZoneInput,
    task: scheduleTaskInput,
    database_id: scheduleDatabaseInput.optional(),
  }),
  // No defaults here: what is left out stays as it is.
  scheduleUpdate: z.object({
    agent_id: id("agent"),
    schedule_id: id("schedule").describe("The schedule's id, from get_agent's schedules."),
    repeat: repeatInput.optional(),
    time_zone: timeZoneInput.optional(),
    task: scheduleTaskInput.optional(),
    database_id: scheduleDatabaseInput.optional(),
  }),
  chat: z.object({
    agent_id: id("agent"),
    message: z.string().min(1).max(MAX_AGENT_CHAT_MESSAGE).describe(`What to say to the agent (at most ${MAX_AGENT_CHAT_MESSAGE} characters), in the user's words.`),
    conversation_id: z.string().min(1).max(100).optional().describe("Go on in this conversation (from get_agent_chat); leave out to start a new one."),
    wait_seconds: z
      .number()
      .int()
      .min(0)
      .max(MAX_CHAT_WAIT)
      .default(20)
      .describe(`How long to wait for the answer (0-${MAX_CHAT_WAIT} seconds, default 20); read a later answer with get_agent_chat.`),
  }),
  chatRead: z.object({
    agent_id: id("agent"),
    conversation_id: z.string().min(1).max(100).optional().describe("Read this conversation; leave out to list the user's conversations with the agent."),
  }),
  setSchedule: z.object({
    agent_id: id("agent"),
    action: z
      .enum(["add", "update", "delete"])
      .describe("add: a new schedule (repeat, time_zone, task; database_id optional). update: change one (schedule_id; what you leave out stays as it is). delete: remove one (schedule_id)."),
    schedule_id: id("schedule").optional().describe("update, delete: the schedule's id, from get_agent's schedules."),
    repeat: repeatInput.optional(),
    time_zone: timeZoneInput.optional(),
    task: scheduleTaskInput.optional(),
    database_id: scheduleDatabaseInput.optional(),
  }),
  access: z.object({
    agent_id: id("agent"),
    page_id: id("page"),
    level: z
      .enum([...AGENT_ACCESS_LEVELS, "remove"])
      .describe('What the agent may do with the page and everything under it: "view", "comment" or "edit"; "remove" stops sharing it.'),
  }),
  share: z.object({
    agent_id: id("agent"),
    user_id: id("user").optional().describe("A person to share it with: an owner or member of the workspace (list_users), never a guest."),
    group_id: id("group").optional().describe("A group of the workspace to share it with (list_groups)."),
    everyone: z.boolean().optional().describe("true: share it with everyone in the workspace (owners and members, never guests)."),
    level: z
      .enum([...AGENT_SHARE_LEVELS, "remove"])
      .describe(
        '"full" (everything a workspace owner can do with the agent, sharing and archiving it too), "edit" (change its settings, instructions, pages, skills, schedules, memory and versions and run it, but not share or archive it), "interact" (see it and its settings, chat with it and mention it in comments); "remove" takes them off its list.',
      ),
  }),
  skill: z.object({
    agent_id: id("agent"),
    skill_id: id("page").describe("The skill's page id, from list_skills."),
    use: z.boolean().describe("true gives the agent the skill; false takes it away."),
  }),
  version: z.object({
    agent_id: id("agent"),
    version: z.number().int().min(1).describe("The version's number, from list_agent_versions."),
  }),
  runs: z.object({
    agent_id: id("agent"),
    limit: z.number().int().min(1).max(100).default(20).describe("Maximum runs (1-100, default 20)."),
  }),
  memory: z.object({
    agent_id: id("agent"),
    action: z
      .enum(["add", "update", "keep", "dismiss", "delete"])
      .describe(
        "add: keep a new note at once (text). update: change a note's text, kept or proposed (memory_id, text; a proposal stays one). keep: keep a note a run proposed (memory_id, text to change it first). dismiss: drop proposals (memory_ids, or all). delete: drop kept notes (memory_ids, or all: the agent forgets everything it remembers).",
      ),
    text: noteInput.optional().describe(`add, update, keep: the note, one fact in a sentence of at most ${MAX_MEMORY_CHARS} characters.`),
    memory_id: memoryIdInput.optional(),
    memory_ids: z
      .array(memoryIdInput)
      .min(1)
      .max(MAX_MEMORIES + MAX_AGENT_PROPOSALS)
      .optional()
      .describe("dismiss: proposals, from get_agent's memory.proposed. delete: kept notes, from memory.kept."),
    all: z.boolean().default(false).describe("dismiss, delete: every proposal, or every kept note, instead of memory_ids."),
  }),
};

/** At least one note, by id or all of them, never both. */
export function notesToDrop(args: { memory_ids?: string[]; all: boolean }): string[] | "all" {
  if (args.all && args.memory_ids?.length) throw new ToolInputError("Pass memory_ids or all, not both.");
  if (args.all) return "all";
  if (!args.memory_ids?.length) throw new ToolInputError("Pass the memory_ids of the notes, or all: true.");
  return args.memory_ids;
}

type RepeatArgs = z.infer<typeof repeatInput>;

/** Why a chat message wasn't taken, with what to do next. */
const CHAT_REFUSALS: Partial<Record<AgentChatRefusal["code"], string>> = {
  busy: "The agent is still answering in this conversation. Read the answer with get_agent_chat, then send the next message.",
  noAccess: "The user can't chat with this agent: it isn't shared with them (share_agent), or the conversation isn't theirs.",
  guest: "Guests don't chat with agents.",
  gone: "This agent is archived or no longer in the workspace (list_agents).",
  paused: "The agent is paused; someone who can edit it turns it on with update_agent (enabled true).",
  aiOff: "AI is off for this workspace, so agents don't answer.",
  limitReached: "The agent used its monthly token limit (get_agent shows its usage; an owner can raise it with update_agent).",
  rateLimited: "Too many AI requests just now. Wait a little and send again.",
};

/** AgentChatRefusal as errors with a next step. */
export async function withChatErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof AgentChatRefusal) throw new ToolInputError(CHAT_REFUSALS[error.code] ?? `${error.message}.`);
    throw error;
  }
}

/** A schedule tool's (or endpoint's) arguments as setAgentSchedule takes them: only what was given. */
export function toScheduleInput(args: { repeat?: RepeatArgs; time_zone?: string; task?: string; database_id?: string | null }) {
  return {
    ...(args.repeat ? { rule: { ...args.repeat, weekdays: args.repeat.weekdays ?? [] } } : {}),
    ...(args.time_zone !== undefined ? { timeZone: args.time_zone } : {}),
    ...(args.task !== undefined ? { task: args.task } : {}),
    ...(args.database_id !== undefined ? { databaseId: args.database_id } : {}),
  };
}

/** update_agent's arguments as a patch: only what was given. */
export function toAgentPatch(args: Omit<z.infer<typeof agentInputs.update>, "agent_id">) {
  const patch: {
    name?: string;
    icon?: string | null;
    description?: string;
    instructions?: string;
    enabled?: boolean;
    webAccess?: boolean;
    mailRecipients?: string[];
    rowChanges?: AgentRowChanges;
    monthlyTokenLimit?: number | null;
    model?: AgentModel;
    helperAgentIds?: string[];
  } = {};
  if (args.name !== undefined) patch.name = args.name;
  if (args.icon !== undefined) patch.icon = args.icon;
  if (args.description !== undefined) patch.description = args.description;
  if (args.instructions !== undefined) patch.instructions = args.instructions;
  if (args.enabled !== undefined) patch.enabled = args.enabled;
  if (args.web_access !== undefined) patch.webAccess = args.web_access;
  if (args.mail_recipients !== undefined) patch.mailRecipients = args.mail_recipients;
  if (args.row_changes !== undefined) patch.rowChanges = args.row_changes;
  if (args.monthly_token_limit !== undefined) patch.monthlyTokenLimit = args.monthly_token_limit;
  if (args.model !== undefined) patch.model = args.model;
  if (args.helper_agent_ids !== undefined) patch.helperAgentIds = args.helper_agent_ids;
  if (!Object.keys(patch).length)
    throw new ToolInputError("Nothing to change: pass name, icon, description, instructions, enabled, web_access, row_changes, monthly_token_limit, model or helper_agent_ids.");
  return patch;
}

const INVALID: Record<string, string> = {
  name: "An agent needs a name.",
  icon: `An agent's icon is ${ICON_RULE}; pass null to remove it.`,
  level: 'An agent can view, comment on or edit a page ("view", "comment" or "edit"), never get full access.',
  limit: `A monthly token limit is a whole number from 1 to ${MAX_AGENT_TOKEN_LIMIT}; pass null to remove it.`,
  model: 'An agent runs on the "main" or the "fast" model.',
  task: "A run needs a task: say what the agent should do.",
  taskLength: `A task has at most ${MAX_AGENT_PROMPT} characters. Make it shorter.`,
  helpers: `helper_agent_ids lists other agents of the same workspace that aren't archived, each once, at most ${MAX_AGENT_HELPERS} (an agent can't ask itself); an agent the user adds must be shared with them. Call list_agents to find them.`,
  shareLevel: 'An agent is shared at "full", "edit" or "interact".',
  repeat:
    'Invalid repeat rule or time zone: frequency daily, weekly, monthly or yearly; weekdays (0-6) for a weekly rule; time as "HH:MM"; start as a real YYYY-MM-DD day; time_zone an IANA name such as "Europe/Istanbul".',
};

/** AgentError (and sharing's refusals) as errors with a next step. */
export async function withAgentErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof AgentError) {
      switch (error.code) {
        case "notFound":
          throw new ToolInputError(
            "No agent with this id shared with the user: workspace owners see every agent of the workspace, others the agents shared with them. Call list_agents with the workspace to see them.",
          );
        case "notAllowed":
          throw new ToolInputError(
            `The user's access to this agent ("${error.params.level ?? ""}") doesn't allow this. "interact" lets them see it and its settings, chat with it and mention it; "edit" also lets them change it (settings, instructions, pages, skills, schedules, memory, versions) and run it; "full" also lets them share and archive it. A workspace owner, or someone with full access to the agent, can give them more with share_agent.`,
          );
        case "ownersOnly":
          throw new ToolInputError(
            "Only the workspace's owners change an agent's monthly token limit and the connection tools it may use. Leave monthly_token_limit out, or ask an owner.",
          );
        case "notAMember":
          throw new ToolInputError(
            "An agent is shared only with the workspace's owners and members (user_id, from list_users), its groups (group_id, from list_groups) or everyone in the workspace (everyone: true); never with guests.",
          );
        case "archived":
          throw new ToolInputError(
            "This agent is archived. Bring it back first (set_agent_archived with archived false): it comes back paused, with nothing shared with it.",
          );
        case "tooMany":
          throw new ToolInputError(`A workspace has at most ${error.params.max ?? MAX_AGENTS} agents. Archive one first (set_agent_archived).`);
        case "notAPage":
          throw new ToolInputError(
            "No page with this id in the agent's workspace that the user can open. Use search or list_pages to find the page.",
          );
        case "invalid":
          throw new ToolInputError(INVALID[error.params.reason ?? ""] ?? `${error.message}.`);
        case "notASkill":
          throw new ToolInputError("This page isn't a skill. list_skills lists the workspace's skills; set_skill marks a page as one.");
        case "skillEditable":
          throw new ToolInputError(
            `Someone besides the workspace's owners may edit "${error.params.title ?? ""}" (a member, a teamspace, a group, a guest or an agent): an agent follows only skills that just the owners may change. Limit who may edit the page first.`,
          );
        case "tooManySkills":
          throw new ToolInputError(`An agent has at most ${error.params.max ?? MAX_AGENT_SKILLS} skills. Take one away first.`);
        case "noteEmpty":
          throw new ToolInputError("A note needs text.");
        case "noteTooLong":
          throw new ToolInputError(`A note has at most ${error.params.max ?? MAX_MEMORY_CHARS} characters. Make it shorter.`);
        case "memoryFull":
          throw new ToolInputError(
            `The agent's memory is full (${error.params.max ?? MAX_MEMORIES} kept notes). Delete or change a note first (change_agent_memory).`,
          );
        case "paused":
          throw new ToolInputError("This agent is paused. Turn it on with update_agent (enabled: true) to run it.");
        case "aiOff":
          throw new ToolInputError("AI is off for this workspace (or not set up on the server), so agents don't run. A workspace owner can turn it on in Settings.");
        case "limitReached":
          throw new ToolInputError(
            `The agent has used its monthly token limit (${error.params.limit ?? ""} tokens): it runs again next month. An owner can raise the limit with update_agent (monthly_token_limit) or remove it (null).`,
          );
        case "tooManyRuns":
          throw new ToolInputError(
            `${error.params.max ?? MAX_REQUESTED_RUNS} runs asked of this agent are still waiting or under way. Check them with list_agent_runs and ask again once one has finished.`,
          );
        case "notARow":
          throw new ToolInputError(
            "No row with this id in a database of the agent's workspace that the user can open. Use query_database to find the row, or leave row_id out.",
          );
        case "notADatabase":
          throw new ToolInputError(
            "No database with this id in the agent's workspace that the user can open (rows, templates and pages in the trash aren't databases). Use search or list_pages to find it, or pass database_id: null.",
          );
        case "tooManySchedules":
          throw new ToolInputError(
            `No room for another schedule (an agent has at most ${MAX_AGENT_SCHEDULES}, and a workspace has a limit too). Change or delete one first (set_agent_schedule).`,
          );
        case "scheduleNotFound":
          throw new ToolInputError("No schedule with this schedule_id on the agent. Call get_agent to see its schedules.");
        case "versionNotFound":
          throw new ToolInputError("No version with this number of the agent (only the latest ones are kept). Call list_agent_versions to see them.");
        case "noteNotFound":
          throw new ToolInputError(
            "No note with this memory_id in the agent's memory that the user may read. Call get_agent to see its notes; a proposal from a run on a row the user can't open may only be dismissed (change_agent_memory dismiss).",
          );
      }
    }
    if (error instanceof PermissionError) throw new ToolInputError(`${error.message}.`);
    throw error;
  }
}

/**
 * Sharing with an agent needs full access to the page, as sharing it with anyone does: an
 * AccessError there means the page, not the agent (which withAgentErrors already found).
 */
export async function withSharingErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await withAgentErrors(fn);
  } catch (error) {
    if (error instanceof AccessError && !(error instanceof ConnectedAppReadOnlyError)) {
      throw new ToolInputError(
        "The user can't share this page: sharing a page with an agent needs full access to it, as sharing it with anyone does. Check the page id with search or get_page.",
      );
    }
    throw error;
  }
}

/** An agent as list_agents shows it: what it is, not what it is told; `helpers`, the agents it can ask, when given. */
export function describeAgentSummary(agent: AgentView, helpers?: string[]) {
  return {
    id: agent.id,
    name: agent.name,
    icon: agent.icon,
    description: agent.description,
    enabled: agent.enabled,
    archived: agent.archived,
    model: agent.model,
    web_access: agent.webAccess,
    mail_recipients: agent.mailRecipients,
    row_changes: agent.rowChanges,
    user_id: agent.userId,
    your_access: agent.access,
    ...(helpers ? { helper_agent_ids: helpers } : {}),
  };
}

/** Why a run left a skill out, for its step. */
const SKIPPED: Record<AgentSkillSkip, string> = {
  notASkill: "it is no longer a skill",
  editable: "someone besides the workspace's owners may edit it",
  tooLong: "it didn't fit in what a run may read",
  hidden: "the person whose access the run was held to can't open it",
  removed: "an owner took it from the agent while the run waited",
};

const SKILL_STATUS = {
  usable: "its runs follow it",
  notASkill: "left out: no longer a skill",
  editable: "left out: someone besides the workspace's owners may edit it",
  tooLong: "left out: it doesn't fit in what a run may read, with the skills before it",
} as const;

/** A note of an agent's memory, kept or proposed by a run (text null: from a row the user can't open). */
function describeMemory(workspaceId: string, note: AgentMemoryView) {
  return {
    memory_id: note.id,
    text: note.text,
    ...(note.run
      ? {
          proposed_by_run: {
            run_id: note.run.id,
            created_at: note.run.createdAt,
            ...(note.run.rowId !== null
              ? { row: note.run.rowTitle !== null ? { id: note.run.rowId, title: pageLabel(note.run.rowTitle), url: pageUrl(workspaceId, note.run.rowId) } : { id: note.run.rowId, title: null } }
              : note.run.requested
                ? { requested: true }
                : note.run.scheduled
                  ? { scheduled: true }
                  : { connection: note.run.connectionName }),
          },
        }
      : {}),
    ...(note.text === null ? { note: "Proposed by a run on a row (or a database) the user can't open: its text is hidden." } : {}),
    created_at: note.createdAt,
    updated_at: note.updatedAt,
  };
}

/** An agent as get_agent and the write tools return it. */
export function describeAgent(
  agent: AgentView,
  access?: { pages: AgentAccessView[]; hidden: number },
  skills?: { skills: AgentSkillView[]; hidden: number },
  memory?: AgentMemoryView[],
  usage?: AgentUsageMonth[],
  schedules?: AgentScheduleView[],
) {
  return {
    ...describeAgentSummary(agent),
    workspace_id: agent.workspaceId,
    instructions: agent.instructions,
    monthly_token_limit: agent.monthlyTokenLimit,
    ...(usage ? { usage: usage.map(describeUsageMonth) } : {}),
    created_at: agent.createdAt,
    updated_at: agent.updatedAt,
    ...(access
      ? {
          access: {
            pages: access.pages.map((p) => ({
              page_id: p.pageId,
              title: pageLabel(p.title),
              kind: p.kind,
              level: p.level,
              url: pageUrl(agent.workspaceId, p.pageId),
            })),
            ...(access.hidden ? { hidden: access.hidden, note: `${access.hidden} more shared pages the user can't open themselves.` } : {}),
          },
        }
      : {}),
    ...(skills
      ? {
          skills: {
            pages: skills.skills.map((s) => ({
              skill_id: s.pageId,
              title: pageLabel(s.title),
              description: s.description,
              status: s.status,
              note: SKILL_STATUS[s.status],
              url: pageUrl(agent.workspaceId, s.pageId),
            })),
            ...(skills.hidden ? { hidden: skills.hidden, note: `${skills.hidden} more skills the user can't open themselves.` } : {}),
          },
        }
      : {}),
    ...(schedules ? { schedules: schedules.map((s) => describeAgentSchedule(agent.workspaceId, s)) } : {}),
    ...(memory
      ? {
          memory: {
            kept: memory.filter((n) => n.status === "kept").map((n) => describeMemory(agent.workspaceId, n)),
            proposed: memory.filter((n) => n.status === "proposed").map((n) => describeMemory(agent.workspaceId, n)),
          },
        }
      : {}),
  };
}

const SCHEDULE_PAUSED = {
  runAsGone: "paused: the account of whoever set it is gone",
  accessLost: "paused: whoever set it no longer owns the workspace or can't open the database",
  templateGone: "paused",
  agentGone: "paused: the agent was archived",
  failed: "its last run couldn't start; it tries again next time",
} as const;

/** A trigger of a drafted automation, as create_automation takes it. */
function draftTrigger(trigger: DraftTrigger) {
  if (trigger.type === "property_changed") return { type: trigger.type, property: trigger.propertyId };
  return trigger;
}

/** An agent's draft (draft_agent), snake_case, in the shape the tools that set it up take. Nothing in it is saved. */
export function describeAgentDraft(workspaceId: string, draft: AgentDraft) {
  return {
    saved: false,
    name: draft.name,
    icon: draft.icon,
    description: draft.description,
    instructions: draft.instructions,
    pages: draft.pages.map((p) => ({ page_id: p.pageId, title: pageLabel(p.title), kind: p.kind, level: p.level, url: pageUrl(workspaceId, p.pageId) })),
    schedules: draft.schedules.map((s) => ({ repeat: s.rule, task: s.task, database_id: s.databaseId, database_title: s.databaseTitle === null ? null : pageLabel(s.databaseTitle) })),
    automations: draft.automations.map((a) => ({
      database_id: a.databaseId,
      database_title: pageLabel(a.databaseTitle),
      trigger: draftTrigger(a.trigger),
      property_name: a.propertyName,
      task: a.task,
    })),
    next:
      "Show the draft to the user and change what they ask. To set it up: create_agent (name, icon, description, instructions), set_agent_access for each page at its level, set_agent_schedule add for each schedule (with the user's time_zone), and create_automation on each automation's database with its trigger and a run_agent action naming the agent, with the task as its prompt.",
  };
}

/** One of an agent's schedules, snake_case, with a note on what stands in its way. */
export function describeAgentSchedule(workspaceId: string, s: AgentScheduleView) {
  const notes: string[] = [];
  if (!s.enabled && s.lastError) notes.push(`${SCHEDULE_PAUSED[s.lastError]}; set it again (set_agent_schedule update) to turn it back on.`);
  else if (s.lastError === "failed") notes.push(SCHEDULE_PAUSED.failed);
  if (s.agentAccess === "none") notes.push("The agent can't open the database: it skips its runs until the database is shared with it (set_agent_access).");
  if (s.taskHidden) notes.push("The task is hidden: the user can't open the database. set_agent_schedule update keeps it unless given a new task.");
  else if (s.agentAccess === "view" || s.agentAccess === "comment") notes.push(`The agent can only ${s.agentAccess === "view" ? "read" : "read and comment on"} the database: give it edit access (set_agent_access) to change rows.`);
  return {
    schedule_id: s.id,
    repeat: { ...s.rule, ...(s.rule.frequency === "weekly" ? {} : { weekdays: undefined }) },
    time_zone: s.timeZone,
    task: s.task,
    database:
      s.databaseId === null
        ? null
        : s.databaseTitle !== null
          ? { id: s.databaseId, title: pageLabel(s.databaseTitle), url: pageUrl(workspaceId, s.databaseId), agent_access: s.agentAccess }
          : { id: s.databaseId, title: null, agent_access: s.agentAccess },
    enabled: s.enabled,
    next_run_at: s.nextRunAt,
    last_run_at: s.lastRunAt,
    ...(s.setBy ? { set_by: { id: s.setBy.id, name: s.setBy.name } } : {}),
    ...(notes.length ? { note: notes.join(" ") } : {}),
  };
}

const quote = (text: string) => `"${text}"`;
const short = (text: string, max = 200) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/** One step of a run as a line, with the ids it touched. */
export function describeAgentStep(step: AgentStepRecord) {
  switch (step.kind) {
    case "search":
      return { kind: "search", summary: `Searched ${step.query ? quote(step.query) : "the workspace"} (${step.results} results)` };
    case "read":
      return { kind: "read", page_id: step.pageId, summary: "Read a page" };
    case "query":
      return {
        kind: "query",
        database_id: step.databaseId,
        summary: `Queried a database${step.conditions.length ? ` where ${step.conditions.map((c) => `${c.property} ${c.op}${c.value !== null ? ` ${quote(c.value)}` : ""}`).join(step.any ? " or " : " and ")}` : ""} (${step.results} rows)`,
      };
    case "write": {
      const changes = step.changes.map((c) => `${quote(c.property)} to ${c.value ? quote(short(c.value, 80)) : "empty"}`).join(", ");
      const what =
        step.action === "updateRow" ? "Changed the row" : step.action === "createRow" ? "Added a row" : step.action === "editPage" ? "Changed the text of a page" : "Added a page";
      return {
        kind: "write",
        outcome: step.outcome,
        page_id: step.pageId,
        summary: `${step.outcome === "failed" ? "Failed: " : step.outcome === "declined" ? "Declined: " : step.outcome === "proposed" ? "Proposed for review (not made yet): " : ""}${what}${step.title ? ` ${quote(step.title)}` : ""}${changes ? `: ${changes}` : ""}`,
      };
    }
    case "comment":
      return {
        kind: "comment",
        outcome: step.outcome,
        page_id: step.pageId,
        summary: `${step.outcome === "failed" ? "Failed to comment" : "Commented"}: ${quote(short(step.text))}`,
      };
    case "email":
      return {
        kind: "email",
        outcome: step.outcome,
        page_id: step.pageId,
        summary: `${step.outcome === "failed" ? "Failed to draft an email" : "Drafted an email for its sender to review (not sent yet)"}${step.subject ? `: ${quote(short(step.subject))}` : ""}`,
      };
    case "thought":
      return { kind: "thought", summary: step.text };
    case "memory": {
      const how = { remember: "Remembered", propose: "Proposed a note for an owner to keep", forget: "Dropped a note" }[step.action];
      return { kind: "memory", action: step.action, summary: `${how}: ${quote(short(step.text))}` };
    }
    case "skill": {
      const name = step.title ? `the skill ${quote(step.title)}` : "a skill the user can't open";
      const why = step.outcome === "skipped" ? SKIPPED[step.reason] : "";
      return {
        kind: "skill",
        outcome: step.outcome,
        page_id: step.pageId,
        summary: step.outcome === "used" ? `Followed ${name}` : `Left out ${name}: ${why}`,
      };
    }
    case "handoff": {
      const how = {
        done: "Asked",
        failed: "Asked (its run failed)",
        waiting: "Asked (its run hadn't finished when this one went on)",
        paused: "Couldn't ask (paused)",
        archived: "Couldn't ask (archived)",
        limitReached: "Couldn't ask (it used its monthly token limit)",
      }[step.outcome];
      return {
        kind: "handoff",
        outcome: step.outcome,
        agent_id: step.agentId,
        ...(step.runId ? { run_id: step.runId } : {}),
        summary: `${how} the agent ${quote(step.agentName)}: ${quote(short(step.task))}`,
      };
    }
    case "tool": {
      const how = {
        done: "Used",
        failed: "Failed to use",
        declined: "Declined (not sent):",
        redo: "Sent back to redo (not sent):",
        expired: "No one answered (not sent):",
        refused: "Refused, its address being in neither the schedule's task nor the run's searches (not sent):",
      }[step.outcome];
      return {
        kind: "tool",
        outcome: step.outcome,
        connection_id: step.connectionId,
        tool: step.tool,
        summary: `${how} ${step.tool} ${short(step.input, 200)}${step.note ? ` (note: ${quote(short(step.note, 200))})` : ""}`,
      };
    }
  }
}

/** A month of an agent's usage, snake_case. */
export const describeUsageMonth = (m: AgentUsageMonth) => ({
  month: m.month,
  runs: m.runs,
  input_tokens: m.inputTokens,
  output_tokens: m.outputTokens,
  cost_usd: m.costUsd,
});

/** What started a run, and the row it works on (named by id only where the user can't open it). */
function describeRunSource(workspaceId: string, run: AgentRunView) {
  const source = run.source;
  const database = isRowRun(source) ? { database_id: source.databaseId, database_url: pageUrl(workspaceId, source.databaseId) } : {};
  const row = isRowRun(source)
    ? { row: run.rowTitle !== null ? { id: source.rowId, title: pageLabel(run.rowTitle), url: pageUrl(workspaceId, source.rowId) } : { id: source.rowId, title: null } }
    : {};
  if (source.kind === "automation") return { source: { kind: source.kind, automation_id: source.automationId, ...database }, ...row };
  if (source.kind === "connection") return { source: { kind: source.kind, connection_id: source.connectionId, trigger_id: source.triggerId, event_type: run.eventType } };
  if (source.kind === "handoff") {
    return {
      source: {
        kind: source.kind,
        asked_by: { agent_id: source.fromAgentId, name: run.handoff?.fromName ?? "", run_id: source.parentRunId },
        task: run.handoff?.task ?? "",
      },
    };
  }
  if (source.kind === "schedule") {
    const s = run.schedule;
    const database = source.databaseId
      ? s?.databaseTitle
        ? { database: { id: source.databaseId, title: pageLabel(s.databaseTitle), url: pageUrl(workspaceId, source.databaseId) } }
        : { database: { id: source.databaseId, title: null } }
      : {};
    return {
      source: {
        kind: source.kind,
        // Empty once the schedule was removed.
        schedule_id: s?.id || null,
        scheduled_by: { id: source.scheduledBy, name: s?.byName ?? "" },
        task: s?.task ?? "",
        ...database,
      },
    };
  }
  if (source.kind === "mention") {
    const m = run.mention;
    return {
      source: {
        kind: source.kind,
        mentioned_by: { id: source.mentionedBy, name: m?.byName ?? "" },
        // The comment that mentioned the agent: its task.
        task: m?.task ?? "",
        thread_id: source.threadId,
        page: m?.pageTitle != null ? { id: source.pageId, title: pageLabel(m.pageTitle), url: pageUrl(workspaceId, source.pageId) } : { id: source.pageId, title: null },
      },
    };
  }
  // A chat's message is its person's alone (empty for anyone else).
  if (source.kind === "chat") return { source: { kind: source.kind, by: { id: source.userId, name: run.chat?.byName ?? "" }, message: run.chat?.message ?? "" } };
  return {
    source: { kind: source.kind, requested_by: { id: source.requestedBy, name: run.request?.byName ?? "" }, via: source.via, task: run.request?.task ?? "", ...database },
    ...row,
  };
}

/** A run as list_agent_runs returns it. */
export function describeAgentRun(workspaceId: string, run: AgentRunView) {
  return {
    id: run.id,
    status: run.status,
    ...(run.code ? { code: run.code } : {}),
    ...(run.error ? { error: run.error } : {}),
    ...describeRunSource(workspaceId, run),
    ...(run.pending
      ? {
          waiting_for_approval: {
            call_id: run.pending.callId,
            connection_id: run.pending.connectionId,
            connection: run.pending.connectionName,
            tool: run.pending.tool,
            arguments: run.pending.arguments,
            asked_at: run.pending.askedAt,
          },
        }
      : {}),
    steps: run.steps.map(describeAgentStep),
    answer: run.answer,
    ...(run.usage
      ? {
          usage: {
            rounds: run.usage.rounds,
            input_tokens: run.usage.inputTokens,
            output_tokens: run.usage.outputTokens,
            cost_usd: run.usage.costUsd,
            ...(run.usage.model ? { model: run.usage.model } : {}),
          },
        }
      : {}),
    created_at: run.createdAt,
    finished_at: run.finishedAt,
  };
}

/** A version of an agent's setup (server/agents/versions.ts), for MCP. */
export const describeAgentVersion = (v: AgentVersionView) => ({
  version: v.number,
  kind: v.kind,
  changed: v.changes,
  restored_from: v.restoredFrom,
  by: v.by ? { user_id: v.by.id, name: v.by.name } : null,
  created_at: v.createdAt,
  last_saved_at: v.updatedAt,
});

/** What a restore couldn't bring back, for MCP. */
export const describeRestoreSkip = (s: AgentRestoreSkip) => ({ part: s.part, name: s.name || null, reason: s.reason });

/** An agent's sharing list, as get_agent and share_agent show it. */
export function describeSharing(sharing: AgentSharingView) {
  return {
    your_access: sharing.level,
    shared_with: sharing.entries.map((e) =>
      e.kind === "everyone"
        ? { everyone: true, level: e.level }
        : e.kind === "person"
          ? { user_id: e.userId, name: e.name, email: e.email, level: e.level }
          : { group_id: e.groupId, name: e.name, member_count: e.memberCount, level: e.level },
    ),
    note: "Workspace owners always have full access to every agent, listed or not.",
  };
}

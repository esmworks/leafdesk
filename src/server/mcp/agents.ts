import * as z from "zod";
import {
  type AgentMemoryView,
  AGENT_ACCESS_LEVELS,
  isRowRun,
  MAX_AGENT_DESCRIPTION,
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
  type AgentSkillSkip,
  type AgentSkillView,
  type AgentRunView,
  type AgentScheduleView,
  type AgentStepRecord,
  type AgentUsageMonth,
  type AgentView,
} from "@/lib/agents";
import { MAX_MEMORIES, MAX_MEMORY_CHARS } from "@/lib/ai-chat";
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

const nameInput = z.string().min(1).max(MAX_AGENT_NAME);
const iconInput = z
  .string()
  .min(1)
  .max(32)
  .nullable()
  .describe("An emoji shown with the agent's name; null removes it.");
const noteInput = z.string().min(1).max(MAX_MEMORY_CHARS);
const memoryIdInput = z.string().min(1).max(100).describe("The note's memory_id, from get_agent's memory.");
const descriptionInput = z.string().max(MAX_AGENT_DESCRIPTION).describe("A line on what the agent is for, shown where people pick an agent.");
const instructionsInput = z
  .string()
  .max(MAX_AGENT_INSTRUCTIONS)
  .describe(
    `What the agent does and how, in plain language (at most ${MAX_AGENT_INSTRUCTIONS} characters): it reads them on every run, before the task an automation gives it.`,
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

export const agentInputs = {
  list: z.object({
    workspace_id: id("workspace"),
    include_archived: z.boolean().default(false).describe("Also list archived agents (default false)."),
  }),
  agentId: z.object({ agent_id: id("agent") }),
  create: z.object({
    workspace_id: id("workspace"),
    name: nameInput.describe("The agent's name: its changes and comments show it."),
    icon: iconInput.optional(),
    description: descriptionInput.optional(),
    instructions: instructionsInput.optional(),
    enabled: z.boolean().optional().describe("Whether it runs (default true). A paused agent's queued runs end without doing anything."),
    web_access: webAccessInput.optional(),
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
  scheduleId: z.object({
    agent_id: id("agent"),
    schedule_id: id("schedule").describe("The schedule's id, from get_agent's schedules."),
  }),
  access: z.object({
    agent_id: id("agent"),
    page_id: id("page"),
    level: z
      .enum([...AGENT_ACCESS_LEVELS, "remove"])
      .describe('What the agent may do with the page and everything under it: "view", "comment" or "edit"; "remove" stops sharing it.'),
  }),
  skill: z.object({
    agent_id: id("agent"),
    skill_id: id("page").describe("The skill's page id, from list_skills."),
    use: z.boolean().describe("true gives the agent the skill; false takes it away."),
  }),
  runs: z.object({
    agent_id: id("agent"),
    limit: z.number().int().min(1).max(100).default(20).describe("Maximum runs (1-100, default 20)."),
  }),
  addNote: z.object({
    agent_id: id("agent"),
    text: noteInput.describe(`The note: one fact, in a sentence of at most ${MAX_MEMORY_CHARS} characters.`),
  }),
  updateNote: z.object({
    agent_id: id("agent"),
    memory_id: memoryIdInput,
    text: noteInput.describe(`The note's new text (at most ${MAX_MEMORY_CHARS} characters). A proposal stays one until it is kept.`),
  }),
  keepNote: z.object({
    agent_id: id("agent"),
    memory_id: memoryIdInput.describe("The memory_id of a proposed note, from get_agent's memory.proposed."),
    text: noteInput.optional().describe(`Keep it with this text instead (at most ${MAX_MEMORY_CHARS} characters); leave out to keep it as proposed.`),
  }),
  dropNotes: (what: "proposed" | "kept") =>
    z.object({
      agent_id: id("agent"),
      memory_ids: z
        .array(memoryIdInput)
        .min(1)
        .max(MAX_MEMORIES + MAX_AGENT_PROPOSALS)
        .optional()
        .describe(what === "proposed" ? "The memory_ids of proposals, from get_agent's memory.proposed." : "The memory_ids of kept notes, from get_agent's memory.kept."),
      all: z
        .boolean()
        .default(false)
        .describe(what === "proposed" ? "Dismiss every proposal waiting for an owner instead." : "Delete every kept note instead: the agent forgets everything it remembers."),
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
  const patch: { name?: string; icon?: string | null; description?: string; instructions?: string; enabled?: boolean; webAccess?: boolean; monthlyTokenLimit?: number | null } = {};
  if (args.name !== undefined) patch.name = args.name;
  if (args.icon !== undefined) patch.icon = args.icon;
  if (args.description !== undefined) patch.description = args.description;
  if (args.instructions !== undefined) patch.instructions = args.instructions;
  if (args.enabled !== undefined) patch.enabled = args.enabled;
  if (args.web_access !== undefined) patch.webAccess = args.web_access;
  if (args.monthly_token_limit !== undefined) patch.monthlyTokenLimit = args.monthly_token_limit;
  if (!Object.keys(patch).length) throw new ToolInputError("Nothing to change: pass name, icon, description, instructions, enabled, web_access or monthly_token_limit.");
  return patch;
}

const INVALID: Record<string, string> = {
  name: "An agent needs a name.",
  icon: "An agent's icon is one emoji; pass null to remove it.",
  level: 'An agent can view, comment on or edit a page ("view", "comment" or "edit"), never get full access.',
  limit: `A monthly token limit is a whole number from 1 to ${MAX_AGENT_TOKEN_LIMIT}; pass null to remove it.`,
  task: "A run needs a task: say what the agent should do.",
  taskLength: `A task has at most ${MAX_AGENT_PROMPT} characters. Make it shorter.`,
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
            "No agent with this id that the user manages: only owners of a workspace open, change and share pages with its agents. Call list_agents with the workspace to see its agents.",
          );
        case "archived":
          throw new ToolInputError(
            "This agent is archived. Call restore_agent first: it comes back paused, with nothing shared with it.",
          );
        case "tooMany":
          throw new ToolInputError(`A workspace has at most ${error.params.max ?? MAX_AGENTS} agents. Archive one with archive_agent first.`);
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
            `The agent's memory is full (${error.params.max ?? MAX_MEMORIES} kept notes). Delete a note with delete_agent_memory first, or change one with update_agent_memory.`,
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
            `No room for another schedule (an agent has at most ${MAX_AGENT_SCHEDULES}, and a workspace has a limit too). Change one with update_agent_schedule, or delete one with delete_agent_schedule.`,
          );
        case "scheduleNotFound":
          throw new ToolInputError("No schedule with this schedule_id on the agent. Call get_agent to see its schedules.");
        case "noteNotFound":
          throw new ToolInputError(
            "No note with this memory_id in the agent's memory that the user may read. Call get_agent to see its notes; a proposal from a run on a row the user can't open may only be dismissed (dismiss_agent_memory).",
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

/** An agent as list_agents shows it: what it is, not what it is told. */
export function describeAgentSummary(agent: AgentView) {
  return {
    id: agent.id,
    name: agent.name,
    icon: agent.icon,
    description: agent.description,
    enabled: agent.enabled,
    archived: agent.archived,
    web_access: agent.webAccess,
    user_id: agent.userId,
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

/** One of an agent's schedules, snake_case, with a note on what stands in its way. */
export function describeAgentSchedule(workspaceId: string, s: AgentScheduleView) {
  const notes: string[] = [];
  if (!s.enabled && s.lastError) notes.push(`${SCHEDULE_PAUSED[s.lastError]}; set it again (update_agent_schedule) to turn it back on.`);
  else if (s.lastError === "failed") notes.push(SCHEDULE_PAUSED.failed);
  if (s.agentAccess === "none") notes.push("The agent can't open the database: it skips its runs until the database is shared with it (set_agent_access).");
  if (s.taskHidden) notes.push("The task is hidden: the user can't open the database. update_agent_schedule keeps it unless given a new task.");
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
        summary: `${step.outcome === "failed" ? "Failed: " : step.outcome === "declined" ? "Declined: " : ""}${what}${step.title ? ` ${quote(step.title)}` : ""}${changes ? `: ${changes}` : ""}`,
      };
    }
    case "comment":
      return {
        kind: "comment",
        outcome: step.outcome,
        page_id: step.pageId,
        summary: `${step.outcome === "failed" ? "Failed to comment" : "Commented"}: ${quote(short(step.text))}`,
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
    case "tool": {
      const how = { done: "Used", failed: "Failed to use", declined: "Declined (not sent):", redo: "Sent back to redo (not sent):", expired: "No one answered (not sent):" }[step.outcome];
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
          },
        }
      : {}),
    created_at: run.createdAt,
    finished_at: run.finishedAt,
  };
}

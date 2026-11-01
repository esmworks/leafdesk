import { sql } from "drizzle-orm";
import { bigint, boolean, check, date, doublePrecision, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uniqueIndex } from "drizzle-orm/pg-core";
import type {
  AgentAccessLevel,
  AgentModel,
  AgentPendingCall,
  AgentRowChanges,
  AgentRunCode,
  AgentRunContext,
  AgentRunSource,
  AgentRunStatus,
  AgentRunUsage,
  AgentStepRecord,
  ApprovalDecision,
  RunSource,
} from "@/lib/agents";
import type { AgentChatMessageRecord, AgentChatQueuedRecord } from "@/lib/agent-chat";
import type { ChatMode } from "@/lib/ai-chat";
import type { MailTriggerFilters } from "@/lib/agent-mail-trigger";
import type { AgentShareLevel } from "@/lib/agent-sharing";
import type { QuietHours } from "@/lib/quiet-hours";
import { page, workspace, workspaceMember } from "./app";
import { user } from "./auth";
import { file } from "./files";
import { memberGroup } from "./groups";
import { mailbox } from "./mail";

/**
 * A paused run's conversation and counters. `messages` are the model's conversation as sent
 * (server/ai's AiMessage); `queue` the tool calls of the last turn not yet answered, the first
 * one waiting for approval; `decision` an owner's answer to it, set when the run is taken again;
 * `webFound` the addresses its web searches returned.
 */
export type AgentRunState = {
  messages: unknown[];
  queue: { id: string; name: string; arguments: Record<string, unknown> }[];
  rounds: number;
  writes: number;
  externalChars: number;
  webFound?: string[];
  /** It read email (agents/mail.ts): from then on it only reads pages and drafts email. */
  mailRead?: boolean;
  /** It, or its conversation before it, read files on the person's computer (lib/local-reads.ts): from then on nothing goes out. */
  localRead?: boolean;
  decision?: { decision: ApprovalDecision; userId: string; note?: string };
  /**
   * An AI chat's run (source `assistant`): what it may change now. It starts as the person chose
   * and turns from `auto` to `ask` once the run read words no one in the conversation wrote.
   */
  mode?: ChatMode;
};

/**
 * An agent of a workspace (see lib/agents.ts and server/agents). It acts as its own user (`userId`,
 * a bot user that can't sign in, a guest of the workspace), so it sees only the pages shared with
 * it and its changes show its name. Agents aren't deleted, only archived: their user stays, so
 * what they did keeps their name.
 */
export const workspaceAgent = pgTable(
  "workspace_agent",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    /** The agent's own user. */
    userId: text("user_id")
      .notNull()
      .unique()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    icon: text("icon"),
    description: text("description").notNull().default(""),
    instructions: text("instructions").notNull().default(""),
    /** Paused agents don't run; their queued runs end as `agentDisabled`. */
    enabled: boolean("enabled").notNull().default(true),
    /** Whether its runs may read public web pages (and search the web, where the server has a search service). */
    webAccess: boolean("web_access").notNull().default(false),
    /** Addresses its runs may send email to, from the mailbox of the person a run works for (lib/agent-mail.ts). */
    mailRecipients: text("mail_recipients").array().notNull().default(sql`'{}'::text[]`),
    /** The most tokens its runs may use in a calendar month (UTC); null: no limit (see agent_usage). */
    monthlyTokenLimit: integer("monthly_token_limit"),
    /** Which of the server's models its runs use: "fast" is AI_FAST_MODEL, where the workspace's AI has one. */
    model: text("model").$type<AgentModel>().notNull().default("main"),
    /** Whether its runs write rows at once or propose the changes for review (lib/agents AGENT_ROW_CHANGES). */
    rowChanges: text("row_changes").$type<AgentRowChanges>().notNull().default("direct"),
    /** When calls an owner's rule lets go without asking wait instead (lib/quiet-hours.ts); null: never. */
    quietHours: jsonb("quiet_hours").$type<QuietHours>(),
    /** The most changes its runs may make in a day, together (agent_daily_change); null: no limit. */
    dailyChangeLimit: integer("daily_change_limit"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("workspace_agent_workspace_idx").on(t.workspaceId)],
);

/**
 * One time an agent ran: what started it, what it did and how it ended. Runs wait here
 * (`pending`, from `nextAt`) until the agents' worker takes them, so a restart loses nothing.
 * Finished runs are kept AGENT_RUN_HISTORY_DAYS, as the agent's history.
 */
export const agentRun = pgTable(
  "agent_run",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    /** The agent it runs as; null for a person's own AI chat (source `assistant`), which runs as them. */
    agentId: text("agent_id").references(() => workspaceAgent.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    source: jsonb("source").$type<RunSource>().notNull(),
    context: jsonb("context").$type<AgentRunContext>().notNull(),
    /** The task the run was given (an automation action's prompt). */
    prompt: text("prompt").notNull().default(""),
    status: text("status").$type<AgentRunStatus>().notNull().default("pending"),
    code: text("code").$type<AgentRunCode>(),
    error: text("error"),
    steps: jsonb("steps").$type<AgentStepRecord[]>().notNull().default([]),
    /** What the agent said at the end; for a schedule's run it ended with finish_run, the reason it gave. */
    answer: text("answer").notNull().default(""),
    /**
     * A schedule's run that found nothing new and changed nothing (finish_run `nothing_new`): it
     * reports to no one, and the chat with the agent folds it to one line.
     */
    quiet: boolean("quiet").notNull().default(false),
    /**
     * A schedule's run: where it left off, for the schedule's next run (server/agents/memory.ts
     * `handoffFor`); each run leaves its own, and only the latest goes on.
     */
    handoff: text("handoff"),
    usage: jsonb("usage").$type<AgentRunUsage>(),
    /** Where a run that waits for approval stands, to go on from there (see server/agents/run). */
    state: jsonb("state").$type<AgentRunState>(),
    /** The call waiting for approval (status `awaiting_approval`; it fails at `nextAt`). */
    pending: jsonb("pending").$type<AgentPendingCall>(),
    /** How many times the worker took the run. */
    attempts: integer("attempts").notNull().default(0),
    nextAt: timestamp("next_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("agent_run_due_idx").on(t.status, t.nextAt),
    index("agent_run_agent_idx").on(t.agentId, t.createdAt),
    // Tasks an agent gave others (server/agents/handoff.ts `agent_tasks`), read by the giving agent.
    index("agent_run_task_idx")
      .on(sql`(${t.source}->>'fromAgentId')`, t.createdAt)
      .where(sql`${t.source}->>'kind' = 'handoff' and ${t.source}->>'queued' = 'true'`),
    // A person's own AI chat runs without an agent, and only it.
    check("agent_run_agent_check", sql`(${t.agentId} is null) = coalesce(${t.source}->>'kind' = 'assistant', false)`),
  ],
);

/** An agent's run (lib/agents.ts isAgentRun); a person's own AI chat's has no agent. */
export type AgentRunRow = typeof agentRun.$inferSelect & { agentId: string; source: AgentRunSource };

/**
 * What an agent's runs used in a calendar month (UTC), added to after each turn with the model, so
 * a run that fails still counts what it used. Kept AGENT_USAGE_MONTHS, longer than the runs.
 */
export const agentUsage = pgTable(
  "agent_usage",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => workspaceAgent.id, { onDelete: "cascade" }),
    /** The month's first day. */
    month: date("month").notNull(),
    runs: integer("runs").notNull().default(0),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.month] })],
);

/**
 * The changes an agent's runs made in a day (its quiet hours' day, else UTC's), against its daily
 * limit: each change takes one before it is made (agents/daily-changes.ts). Kept a few days.
 */
export const agentDailyChange = pgTable(
  "agent_daily_change",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => workspaceAgent.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.day] })],
);

/**
 * A database an automation shared with an agent (edit, so it can change the rows it runs on), as
 * opposed to a share an owner set in the agent's settings: it's taken back once no automation of
 * the database runs the agent, and forgotten when an owner changes or removes the share themselves.
 */
export const agentDatabaseShare = pgTable(
  "agent_database_share",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => workspaceAgent.id, { onDelete: "cascade" }),
    databaseId: text("database_id")
      .notNull()
      .references(() => page.id, { onDelete: "cascade" }),
    /** The agent's own entry on the database before (view or comment; null: none), given back. */
    previousLevel: text("previous_level").$type<AgentAccessLevel>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.databaseId] })],
);

/**
 * A skill an owner gave an agent: a page whose body the agent follows on every run, after its own
 * instructions (see server/agents/skills.ts). A run uses it only while no one but the workspace's
 * owners may edit the page; otherwise the run leaves it out and says so in its steps.
 */
export const agentSkill = pgTable(
  "agent_skill",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => workspaceAgent.id, { onDelete: "cascade" }),
    pageId: text("page_id")
      .notNull()
      .references(() => page.id, { onDelete: "cascade" }),
    /** Order in the prompt, from 0. */
    position: integer("position").notNull().default(0),
    addedBy: text("added_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.pageId] }), index("agent_skill_page_idx").on(t.pageId)],
);

/**
 * An agent another agent may ask for help during its runs (see server/agents/handoff.ts): the
 * agent's "Agents it can ask". Both are agents of the same workspace; archiving the helper takes it
 * off every list.
 */
export const agentHelper = pgTable(
  "agent_helper",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => workspaceAgent.id, { onDelete: "cascade" }),
    helperId: text("helper_id")
      .notNull()
      .references(() => workspaceAgent.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.helperId] }), index("agent_helper_helper_idx").on(t.helperId)],
);

/**
 * A person's conversation with an agent (see lib/agent-chat.ts): in a page's agent chat block
 * (`chatId`, the block's), or in the agent's dialog (no chat id). Each answer is one of the agent's
 * runs (source `chat`), written here when it ends. Private to that person: no one else is shown
 * it, owners included; deleted with their account, the agent and the workspace, and when they
 * leave the workspace their chats stop being answered (the run checks they are still in it).
 */
export const agentConversation = pgTable(
  "agent_conversation",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    agentId: text("agent_id")
      .notNull()
      .references(() => workspaceAgent.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** The block's conversations (its `chatId` prop); null: the agent's dialog. */
    chatId: text("chat_id"),
    title: text("title").notNull().default(""),
    messages: jsonb("messages").$type<AgentChatMessageRecord[]>().notNull().default([]),
    /** Messages written while an answer was under way, waiting to go as the next turn (lib/agent-chat-queue.ts). */
    queue: jsonb("queue").$type<AgentChatQueuedRecord[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("agent_conversation_user_idx").on(t.userId, t.agentId, t.chatId, t.updatedAt)],
);

/**
 * A file an agent attached to its answer in a person's chat (its `attach_file` tool): an uploaded
 * `file` of the workspace on no page, which only that person opens (/api/agents/chat/files/[id]),
 * never through a page, a published page or a backup. It goes with the conversation: once this row
 * is gone (the conversation deleted, the person or the agent removed) the file is an orphan, which
 * files.ts purgeOrphanFiles deletes (legal holds kept).
 */
export const agentChatFile = pgTable(
  "agent_chat_file",
  {
    fileId: text("file_id")
      .primaryKey()
      .references(() => file.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => agentConversation.id, { onDelete: "cascade" }),
    /** The run whose answer it goes with. */
    runId: text("run_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("agent_chat_file_run_idx").on(t.runId), index("agent_chat_file_conversation_idx").on(t.conversationId)],
);

/**
 * Who an agent is shared with (see lib/agent-sharing.ts and server/agents/sharing.ts): a person
 * (`userId`), a group (`groupId`) or, with neither, everyone in the workspace, each at a level.
 * A person's entry points at their membership, so leaving the workspace takes it away; a group's
 * goes with the group. Workspace owners have full access without an entry.
 */
export const agentShare = pgTable(
  "agent_share",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    agentId: text("agent_id")
      .notNull()
      .references(() => workspaceAgent.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id"),
    groupId: text("group_id"),
    level: text("level").$type<AgentShareLevel>().notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("agent_share_principal_key").on(t.agentId, t.userId, t.groupId).nullsNotDistinct(),
    index("agent_share_user_idx").on(t.userId),
    index("agent_share_group_idx").on(t.groupId),
    foreignKey({
      name: "agent_share_workspace_fk",
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "agent_share_member_fk",
      columns: [t.workspaceId, t.userId],
      foreignColumns: [workspaceMember.workspaceId, workspaceMember.userId],
    }).onDelete("cascade"),
    foreignKey({
      name: "agent_share_group_fk",
      columns: [t.groupId, t.workspaceId],
      foreignColumns: [memberGroup.id, memberGroup.workspaceId],
    }).onDelete("cascade"),
    check("agent_share_level_check", sql`${t.level} in ('full', 'edit', 'interact')`),
    check("agent_share_one_principal", sql`${t.userId} is null or ${t.groupId} is null`),
  ],
);

/**
 * Who may create agents when the workspace's `agentCreation` setting is "chosen": these people and
 * the members of these groups, besides the owners (see server/agents/sharing.ts). An entry goes
 * with the person leaving the workspace or the group being deleted.
 */
export const agentCreator = pgTable(
  "agent_creator",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id"),
    groupId: text("group_id"),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("agent_creator_principal_key").on(t.workspaceId, t.userId, t.groupId).nullsNotDistinct(),
    index("agent_creator_group_idx").on(t.groupId),
    foreignKey({
      name: "agent_creator_workspace_fk",
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "agent_creator_member_fk",
      columns: [t.workspaceId, t.userId],
      foreignColumns: [workspaceMember.workspaceId, workspaceMember.userId],
    }).onDelete("cascade"),
    foreignKey({
      name: "agent_creator_group_fk",
      columns: [t.groupId, t.workspaceId],
      foreignColumns: [memberGroup.id, memberGroup.workspaceId],
    }).onDelete("cascade"),
    check("agent_creator_one_principal", sql`(${t.userId} is null) <> (${t.groupId} is null)`),
  ],
);

/**
 * Someone with full access to an agent asking the workspace's owners for a higher monthly token
 * limit (server/agents/limits.ts): it waits (`pending`) until an owner raises the limit to
 * `tokens` or declines; one waits at a time per agent and person.
 */
export const agentLimitRequest = pgTable(
  "agent_limit_request",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    agentId: text("agent_id")
      .notNull()
      .references(() => workspaceAgent.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    requestedBy: text("requested_by")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** The monthly token limit asked for. */
    tokens: integer("tokens").notNull(),
    /** Why, in the asker's words. */
    note: text("note").notNull().default(""),
    status: text("status").$type<"pending" | "approved" | "declined">().notNull().default("pending"),
    decidedBy: text("decided_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (t) => [
    index("agent_limit_request_agent_idx").on(t.agentId),
    uniqueIndex("agent_limit_request_pending_idx").on(t.agentId, t.requestedBy).where(sql`${t.status} = 'pending'`),
    check("agent_limit_request_status_check", sql`${t.status} in ('pending', 'approved', 'declined')`),
  ],
);

/**
 * A mailbox its owner opened to an agent (server/agents/mail.ts): the agent's runs that work for
 * them and show what they did to them alone read its mail and save drafts in it. Only the
 * mailbox's owner adds or removes one; the mailbox going takes it away. With `onNewMail`, each new
 * email in its inbox that `filters` take starts a run with `task` (agents/mail-trigger.ts).
 */
export const agentMailbox = pgTable(
  "agent_mailbox",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => workspaceAgent.id, { onDelete: "cascade" }),
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailbox.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    onNewMail: boolean("on_new_mail").notNull().default(false),
    task: text("task").notNull().default(""),
    filters: jsonb("filters").$type<MailTriggerFilters>().notNull().default({ senders: [], subject: "", knownOnly: false }),
    /** When new email last found the hourly or daily limit reached and started no run (lib/agents.ts MAX_MAIL_RUNS_PER_HOUR). */
    limitedAt: timestamp("limited_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.mailboxId] }), index("agent_mailbox_mailbox_idx").on(t.mailboxId)],
);

import * as z from "zod";
import {
  AGENT_ACCESS_LEVELS,
  isRowRun,
  MAX_AGENT_DESCRIPTION,
  MAX_AGENT_INSTRUCTIONS,
  MAX_AGENT_NAME,
  MAX_AGENTS,
  type AgentAccessView,
  type AgentRunView,
  type AgentStepRecord,
  type AgentView,
} from "@/lib/agents";
import { pageLabel } from "@/lib/labels";
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
const descriptionInput = z.string().max(MAX_AGENT_DESCRIPTION).describe("A line on what the agent is for, shown where people pick an agent.");
const instructionsInput = z
  .string()
  .max(MAX_AGENT_INSTRUCTIONS)
  .describe(
    `What the agent does and how, in plain language (at most ${MAX_AGENT_INSTRUCTIONS} characters): it reads them on every run, before the task an automation gives it.`,
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
  }),
  // No defaults here: what is left out stays as it is.
  update: z.object({
    agent_id: id("agent"),
    name: nameInput.optional(),
    icon: iconInput.optional(),
    description: descriptionInput.optional(),
    instructions: instructionsInput.optional(),
    enabled: z.boolean().optional().describe("Pause (false) or resume (true) the agent."),
  }),
  access: z.object({
    agent_id: id("agent"),
    page_id: id("page"),
    level: z
      .enum([...AGENT_ACCESS_LEVELS, "remove"])
      .describe('What the agent may do with the page and everything under it: "view", "comment" or "edit"; "remove" stops sharing it.'),
  }),
  runs: z.object({
    agent_id: id("agent"),
    limit: z.number().int().min(1).max(100).default(20).describe("Maximum runs (1-100, default 20)."),
  }),
};

/** update_agent's arguments as a patch: only what was given. */
export function toAgentPatch(args: Omit<z.infer<typeof agentInputs.update>, "agent_id">) {
  const patch: { name?: string; icon?: string | null; description?: string; instructions?: string; enabled?: boolean } = {};
  if (args.name !== undefined) patch.name = args.name;
  if (args.icon !== undefined) patch.icon = args.icon;
  if (args.description !== undefined) patch.description = args.description;
  if (args.instructions !== undefined) patch.instructions = args.instructions;
  if (args.enabled !== undefined) patch.enabled = args.enabled;
  if (!Object.keys(patch).length) throw new ToolInputError("Nothing to change: pass name, icon, description, instructions or enabled.");
  return patch;
}

const INVALID: Record<string, string> = {
  name: "An agent needs a name.",
  icon: "An agent's icon is one emoji; pass null to remove it.",
  level: 'An agent can view, comment on or edit a page ("view", "comment" or "edit"), never get full access.',
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
    user_id: agent.userId,
  };
}

/** An agent as get_agent and the write tools return it. */
export function describeAgent(agent: AgentView, access?: { pages: AgentAccessView[]; hidden: number }) {
  return {
    ...describeAgentSummary(agent),
    workspace_id: agent.workspaceId,
    instructions: agent.instructions,
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
      const what = step.action === "updateRow" ? "Changed the row" : step.action === "createRow" ? "Added a row" : "Added a page";
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

/** A run as list_agent_runs returns it. */
export function describeAgentRun(workspaceId: string, run: AgentRunView) {
  return {
    id: run.id,
    status: run.status,
    ...(run.code ? { code: run.code } : {}),
    ...(run.error ? { error: run.error } : {}),
    ...(isRowRun(run.source)
      ? {
          source: {
            kind: run.source.kind,
            automation_id: run.source.automationId,
            database_id: run.source.databaseId,
            database_url: pageUrl(workspaceId, run.source.databaseId),
          },
          // Rows the user can't open are named by id only.
          row:
            run.rowTitle !== null
              ? { id: run.source.rowId, title: pageLabel(run.rowTitle), url: pageUrl(workspaceId, run.source.rowId) }
              : { id: run.source.rowId, title: null },
        }
      : { source: { kind: run.source.kind, connection_id: run.source.connectionId, trigger_id: run.source.triggerId, event_type: run.eventType } }),
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

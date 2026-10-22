import * as z from "zod";
import { env } from "@/lib/env";
import { agentRunPath } from "@/lib/agents";
import { pageLabel } from "@/lib/labels";
import { MAX_PENDING_PAGE, reviewPath, type PendingChangeView } from "@/lib/pending-changes";
import { valueText } from "@/lib/row-activity";
import { AccessError, ConnectedAppReadOnlyError } from "@/server/access";
import { PendingChangeError } from "@/server/pending-changes";
import { pageUrl, ToolInputError } from "./format";

/**
 * The "For review" queue over MCP and the REST API (server/pending-changes.ts): the tools' inputs,
 * a proposal as they show it (snake_case, with app links), and the queue's errors turned into ones
 * with a next step a model can take.
 */

const changeId = z.string().min(1).max(100).describe("The change's id, from list_pending_changes.");

export const reviewInputs = {
  list: z.object({
    workspace_id: z.string().min(1).describe("The workspace's id."),
    agent_id: z.string().min(1).optional().describe("Only changes this agent proposed."),
    database_id: z.string().min(1).optional().describe("Only changes in this database."),
    row_id: z.string().min(1).optional().describe("Only changes to this row."),
    status: z.enum(["open", "decided"]).default("open").describe("open (default): waiting, or approved but failed to be made; decided: approved, dismissed or expired ones still kept."),
    limit: z.number().int().min(1).max(MAX_PENDING_PAGE).default(50).describe(`Maximum results (1-${MAX_PENDING_PAGE}, default 50).`),
  }),
  approve: z.object({
    change_id: changeId,
    title: z.string().min(1).max(500).optional().describe("A row change: the title to set instead of the one proposed (only where it proposes one)."),
    properties: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("A row change: the values to set instead, by property name or id, as update_database_row takes them; only properties it proposes, and those left out are not set. Omit to approve the values as proposed."),
    markdown: z.string().max(100_000).optional().describe("A new row: its page text instead of the one proposed."),
    subject: z.string().max(900).optional().describe("An email draft: the subject instead (one line)."),
    text: z.string().max(100_000).optional().describe("An email draft: the text instead (plain text)."),
    force: z.boolean().default(false).describe("Approve although the row changed since the proposal in a value it sets (conflict: true): the proposal's value overwrites it."),
  }),
  dismiss: z.object({ change_id: changeId }),
};

/** The edit an approve call carries, or undefined when it approves the proposal as it is. */
export function editOf(args: { title?: string; properties?: Record<string, unknown>; markdown?: string; subject?: string; text?: string }) {
  const edit: Record<string, unknown> = {};
  for (const key of ["title", "properties", "markdown", "subject", "text"] as const) if (args[key] !== undefined) edit[key] = args[key];
  return Object.keys(edit).length ? edit : undefined;
}

export function describePendingChange(v: PendingChangeView) {
  return {
    id: v.id,
    kind: v.kind,
    status: v.status,
    ...(v.error ? { error: v.error } : {}),
    reason: v.reason,
    database: { id: v.database.id, title: pageLabel(v.database.title), url: pageUrl(v.workspaceId, v.database.id) },
    row: v.row ? { id: v.row.id, title: pageLabel(v.row.title), url: pageUrl(v.workspaceId, v.row.id) } : null,
    agent: v.agent ? { id: v.agent.id, name: v.agent.name } : null,
    ...(v.agent && v.runId ? { run_id: v.runId, run_url: `${env.appUrl}${agentRunPath(v.workspaceId, v.agent.id, v.runId)}` } : {}),
    ...(v.kind === "email_draft"
      ? {}
      : {
          changes: v.fields.map((f) => ({
            property: f.property ? f.property.name : "title",
            ...(f.property ? { property_id: f.property.id } : {}),
            ...(f.before ? { from: valueText(f.before) } : {}),
            ...(f.now ? { now: valueText(f.now) } : {}),
            to: valueText(f.after),
            ...(f.conflict ? { conflict: true } : {}),
          })),
        }),
    ...(v.markdown ? { markdown: v.markdown } : {}),
    ...(v.email ? { email: { from: v.email.sender.name, to: v.email.to, cc: v.email.cc, subject: v.email.subject, text: v.email.text, in_reply: v.email.replyTo !== null } } : {}),
    edited: v.edited,
    conflict: v.conflict,
    can_approve: v.canApprove,
    created_at: v.createdAt,
    expires_at: v.expiresAt,
    ...(v.decidedAt ? { decided_at: v.decidedAt, decided_by: v.decidedBy?.name ?? null } : {}),
    url: `${env.appUrl}${reviewPath(v.workspaceId, v.row ? { rowId: v.row.id } : {})}`,
  };
}

/** The queue's errors as ones a model can act on. */
export async function withReviewErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof PendingChangeError) {
      switch (error.code) {
        case "notFound":
          throw new ToolInputError("No change waiting for review has this id where the user may see it. Call list_pending_changes with the workspace to see them.");
        case "decided":
          throw new ToolInputError("This change was already approved, dismissed or expired. list_pending_changes with status decided shows how.");
        case "conflict":
          throw new ToolInputError(
            "The row changed since this was proposed, in a value the change sets (conflict: true in list_pending_changes). Show the user what it has now and what the change sets; approve again with force: true only if they still want it, or dismiss it.",
          );
        default:
          throw new ToolInputError(`The edit isn't valid: ${error.message}`);
      }
    }
    if (error instanceof AccessError && !(error instanceof ConnectedAppReadOnlyError)) {
      throw new ToolInputError(
        error.message ||
          "The user may not answer this change: approving or dismissing it needs edit access to the row (to the database, for a new row) and to each value it sets; an email draft only its sender answers.",
      );
    }
    throw error;
  }
}

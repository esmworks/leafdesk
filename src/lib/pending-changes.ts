import type { PropertyType } from "./property-types";
import type { ActivityValue } from "./row-activity";

/**
 * The "For review" queue: changes AI agents (and, later, other automated writers) propose instead
 * of making them, each waiting for a person to approve it, maybe after editing it, or dismiss it
 * (server/pending-changes.ts). Pure and client-safe: the kinds, statuses and payloads, shared by the
 * server, the For review page, the row's banner, MCP and the REST API.
 */

/**
 * What a proposal would do: add a row to a database, change a row's title or values, send an
 * email from someone's own mailbox on a row (server/row-mail), or let an automation's run go on
 * past an approval step (server/automations/approval.ts). Stored as its string: add kinds, never
 * rename one.
 */
export const PENDING_CHANGE_KINDS = ["create_row", "update_row", "email_draft", "automation_approval"] as const;
export type PendingChangeKind = (typeof PENDING_CHANGE_KINDS)[number];

/**
 * Where a proposal stands: waiting, approved (and made), dismissed, gone past PENDING_CHANGE_DAYS
 * without an answer, or approved but failed to be made (`error` says why; it can be dismissed or
 * approved again).
 */
export const PENDING_CHANGE_STATUSES = ["pending", "approved", "dismissed", "expired", "failed"] as const;
export type PendingChangeStatus = (typeof PENDING_CHANGE_STATUSES)[number];

/** How long a proposal waits for an answer before the daily cleanup expires it. */
export const PENDING_CHANGE_DAYS = 30;
/** How long answered and expired proposals are kept after that, as the queue's history. */
export const PENDING_CHANGE_HISTORY_DAYS = 30;
/** The most proposals one page of the queue lists, and one bulk answer decides. */
export const MAX_PENDING_PAGE = 200;
/** The most of a proposal's reason that is kept. */
export const MAX_PENDING_REASON = 1_000;
/** Sent on a database's channel (`db:<id>`) when a proposal for one of its rows comes, goes or is answered. */
export const REVIEW_EVENT = "review";

/**
 * A row to add or change. `properties` are keyed by property id, each value as the row stores it
 * (option names, people's and rows' ids, files), so it is made exactly as shown; `title` only when
 * it changes; `markdown` the text of a new row's page.
 */
export type RowChangePayload = { title?: string; properties: Record<string, unknown>; markdown?: string };

/**
 * An email to send from the sender's own mailbox on the row: to the row's addresses (and,
 * answering a message on the row, in its thread: `replyTo`), in plain text.
 */
export type EmailDraftPayload = { to: string[]; cc: string[]; subject: string; text: string; replyTo: string | null };

/**
 * An automation's run waiting at an approval step: the message as rendered for the run, who may
 * answer (only they), and what the steps after it do in the version the run is pinned to.
 */
export type ApprovalPayload = {
  stepId: string;
  automationName: string;
  version: number;
  message: string;
  approverIds: string[];
  nextSteps: ApprovalNextStep[];
  onTimeout: "stop" | "continue";
};

/**
 * One step after an approval, as a short line: its type, and what it is about (property names, a
 * database's title, people's names, a host, minutes, a message), resolved when the run asked.
 */
export type ApprovalNextStep = { id: string; type: string; detail?: string; forEach?: string };

export type PendingChangePayload = RowChangePayload | EmailDraftPayload | ApprovalPayload;

/** What a row change touches, as the row had it when proposed: to show what it changes, and to see whether the row changed since. */
export type RowChangeBefore = { title?: string; properties: Record<string, unknown> };

/**
 * What proposed it: an agent's run (one an automation started, with `automationRunId`), or an
 * automation's run itself. Kept by kind, so other sources can be added.
 */
export type PendingChangeSource = { kind: "agent_run"; runId: string; automationRunId?: string | null } | { kind: "automation_run"; automationRunId: string };

export const isPendingChangeKind = (value: unknown): value is PendingChangeKind =>
  typeof value === "string" && (PENDING_CHANGE_KINDS as readonly string[]).includes(value);

/** One value a row change sets: the property, what the row had, has now, and what the proposal sets. */
export type PendingFieldView = {
  /** Null for the row's title. */
  property: { id: string; name: string; type: PropertyType } | null;
  /** The value the row had when the change was proposed (null for a new row). */
  before: ActivityValue | null;
  /** The value it has now, when someone changed it since the proposal. */
  now: ActivityValue | null;
  /** The value the proposal sets (the reviewer's edit, when there is one). */
  after: ActivityValue;
  /** The value as stored, for editing. */
  raw: unknown;
  /** The row changed in this value since the proposal: approving overwrites what someone wrote. */
  conflict: boolean;
};

/** A proposal as the For review page, the row's banner, MCP and the REST API show it to a viewer. */
export type PendingChangeView = {
  id: string;
  workspaceId: string;
  kind: PendingChangeKind;
  status: PendingChangeStatus;
  error: string | null;
  reason: string;
  /** The database the row is (or is to be) in. */
  database: { id: string; title: string; icon: string | null };
  /** The row it changes or emails from, or that approving it made. */
  row: { id: string; title: string; icon: string | null } | null;
  /** The agent that proposed it, and its run while that is kept. */
  agent: { id: string; name: string; icon: string | null; userId: string } | null;
  runId: string | null;
  /** Row changes: what each value goes from and to. */
  fields: PendingFieldView[];
  /** A new row's page text. */
  markdown: string | null;
  /** Email drafts: the message, and whose mailbox it goes out from. */
  email: (EmailDraftPayload & { sender: { id: string; name: string } }) | null;
  /** An automation's approval: its run, who may answer, and what the steps after it do. */
  approval: ApprovalView | null;
  /** A reviewer changed what was proposed. */
  edited: boolean;
  /** Some value changed in the row since the proposal. */
  conflict: boolean;
  /** The viewer may approve it (and edit it first); otherwise they only see it. */
  canApprove: boolean;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decidedBy: { id: string; name: string } | null;
};

/** An automation's approval as the queue shows it (`runPath` only for those who see the automation's runs). */
export type ApprovalView = {
  automation: { id: string; name: string } | null;
  runId: string | null;
  runPath: string | null;
  version: number;
  message: string;
  approvers: { id: string; name: string }[];
  nextSteps: ApprovalNextStep[];
  onTimeout: "stop" | "continue";
};

/** Where an automation's run shows: its database, with the automation's history open at the run. */
export const automationRunPath = (workspaceId: string, databaseId: string, automationId: string, runId: string) =>
  `/w/${workspaceId}/p/${databaseId}?automation=${encodeURIComponent(automationId)}&run=${encodeURIComponent(runId)}`;

/** What the queue is narrowed to (nothing: everything waiting that the viewer can see). */
export type PendingChangeFilter = { agentId?: string | null; databaseId?: string | null; rowId?: string | null };

/** The For review page's path, narrowed to an agent, a database or a row. */
export function reviewPath(workspaceId: string, filter: PendingChangeFilter = {}) {
  const query = new URLSearchParams();
  if (filter.agentId) query.set("agent", filter.agentId);
  if (filter.databaseId) query.set("database", filter.databaseId);
  if (filter.rowId) query.set("row", filter.rowId);
  const q = query.toString();
  return `/w/${workspaceId}/review${q ? `?${q}` : ""}`;
}

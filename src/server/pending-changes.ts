/**
 * The "For review" queue (lib/pending-changes.ts, the `pending_change` table): changes an agent
 * whose owners chose "propose for review" would make to rows (create_row, update_row), and emails
 * agents draft on rows (agents/run.ts), kept here instead of made. A person who could make the
 * change themselves approves it, maybe after editing it, and it is made as them, the row's activity
 * crediting the agent that proposed it (row-activity.ts asApprovedProposal); or dismisses it. An
 * email draft goes out only from its sender's own mailbox, and only they may send or dismiss it;
 * the row's other editors see it. What waits past PENDING_CHANGE_DAYS is expired by the daily
 * cleanup (retention.ts).
 *
 * Who sees a proposal: whoever may open its row (or, for a new row, its database) and see every
 * value it sets; an email draft, whoever reads the row's email (row-mail/access.ts). The people it
 * is for hear about it in their inbox (kind "review"), batched: one unread notification per person
 * and workspace, which newer proposals bring back to the top.
 */

import { and, count, desc, eq, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { agentRun, notification, page, pendingChange, user, workspaceAgent } from "@/db/schema";
import { normalizeAddress } from "@/lib/mail";
import {
  MAX_PENDING_PAGE,
  MAX_PENDING_REASON,
  PENDING_CHANGE_DAYS,
  PENDING_CHANGE_HISTORY_DAYS,
  REVIEW_EVENT,
  type EmailDraftPayload,
  type PendingChangeFilter,
  type PendingChangeKind,
  type PendingChangePayload,
  type PendingChangeSource,
  type PendingChangeView,
  type PendingFieldView,
  type RowChangeBefore,
  type RowChangePayload,
} from "@/lib/pending-changes";
import { atLeast } from "@/lib/property-access";
import { PropertyValueError } from "@/lib/properties";
import { redactError } from "@/lib/redact";
import { referencedIds, resolveValue, sameValue, type ActivityValue } from "@/lib/row-activity";
import { AccessError, accessRank, findMembership, levelFromRank, hasLevel, pageAccessOf, workspaceOwnerIds } from "@/server/access";
import { loadLookups } from "@/server/activity-lookups";
import { recordAudit } from "@/server/audit";
import { isAgentUser } from "@/server/agents/users";
import { getCollab, type WriteActor } from "@/server/collab/bridge";
import { getProperties, normalizeRowProperties } from "@/server/databases";
import { ToolInputError } from "@/server/mcp/format";
import { signalInbox } from "@/server/notifications";
import * as ops from "@/server/operations";
import { propertyAccessFor } from "@/server/property-access";
import { pushNotifications } from "@/server/push";
import { asApprovedProposal } from "@/server/row-activity";
import { rowMailAccess } from "@/server/row-mail/access";
import { queueRowEmail, sendSoon } from "@/server/row-mail/send";
import { RowMailError } from "@/server/row-mail/settings";

export type PendingChangeErrorCode = "notFound" | "decided" | "conflict" | "invalid";

/** A proposal that can't be answered as asked: gone or not the person's to see, answered already, or changed under it. */
export class PendingChangeError extends Error {
  constructor(
    readonly code: PendingChangeErrorCode,
    message: string,
  ) {
    super(message);
  }
}

type Change = typeof pendingChange.$inferSelect;

const DAY_MS = 24 * 60 * 60_000;
/** Proposals still to be answered: waiting, or approved but failed to be made (they can be tried again). */
const OPEN = ["pending", "failed"] as const;
const isOpen = (status: string) => (OPEN as readonly string[]).includes(status);

/** Tells the workspace's sidebars (the count) and the database's open rows (their banner) that the queue changed. */
function signalQueue(workspaceId: string, databaseIds: Iterable<string>) {
  signalInbox(workspaceId);
  for (const id of new Set(databaseIds)) getCollab().broadcast(`db:${id}`, REVIEW_EVENT);
}

// --------------------------------------------------------------------------------- proposing

export type ProposalInput = {
  workspaceId: string;
  kind: PendingChangeKind;
  databaseId: string;
  rowId: string | null;
  payload: PendingChangePayload;
  before: RowChangeBefore | null;
  reason: string;
  source: PendingChangeSource;
  /** The agent that proposed it; none for a follow-up's step. */
  agent: { id: string; userId: string } | null;
  runId: string | null;
  senderId?: string | null;
  /** Who to tell, besides the sender of a draft: the first of them who may approve it (see reviewersOf). */
  for: (string | null | undefined)[];
};

/**
 * Keeps a proposal. A newer one from the same run for the same row (a change, or a draft) takes
 * the place of the one still waiting, rather than adding another; a reviewer's edit of it goes.
 */
export async function proposeChange(input: ProposalInput): Promise<{ id: string; replaced: boolean }> {
  const reason = input.reason.replace(/\s+/g, " ").trim().slice(0, MAX_PENDING_REASON);
  const expiresAt = new Date(Date.now() + PENDING_CHANGE_DAYS * DAY_MS);
  const values = {
    payload: input.payload,
    before: input.before,
    reason,
    editedPayload: null,
    status: "pending" as const,
    error: null,
    updatedAt: new Date(),
    expiresAt,
  };
  let id: string | null = null;
  if (input.kind !== "create_row" && input.runId && input.rowId) {
    const [replaced] = await db
      .update(pendingChange)
      .set(values)
      .where(
        and(
          eq(pendingChange.agentRunId, input.runId),
          eq(pendingChange.rowId, input.rowId),
          eq(pendingChange.kind, input.kind),
          inArray(pendingChange.status, [...OPEN]),
        ),
      )
      .returning({ id: pendingChange.id });
    id = replaced?.id ?? null;
  }
  const replaced = id !== null;
  if (!id) {
    const [made] = await db
      .insert(pendingChange)
      .values({
        ...values,
        workspaceId: input.workspaceId,
        kind: input.kind,
        databaseId: input.databaseId,
        rowId: input.rowId,
        source: input.source,
        agentId: input.agent?.id ?? null,
        agentRunId: input.runId,
        proposedBy: input.agent?.userId ?? null,
        senderId: input.senderId ?? null,
      })
      .returning({ id: pendingChange.id });
    id = made.id;
  }
  const reviewers = await reviewersOf(
    { kind: input.kind, workspaceId: input.workspaceId, databaseId: input.databaseId, rowId: input.rowId, senderId: input.senderId ?? null },
    input.for,
  );
  await notifyReviewers(input.workspaceId, reviewers, input.agent?.userId ?? null);
  signalQueue(input.workspaceId, [input.databaseId]);
  return { id, replaced };
}

/**
 * Who hears about a proposal: an email draft's sender; for a row change, the first of `candidates`
 * (the person the agent's run worked for, then whoever made the agent) who may edit what it
 * changes, else the workspace's owners who may. Everyone else who may approve it finds it in the
 * queue: telling every editor of a database about each proposal would bury them.
 */
export async function reviewersOf(
  change: { kind: PendingChangeKind; workspaceId: string; databaseId: string; rowId: string | null; senderId: string | null },
  candidates: (string | null | undefined)[],
): Promise<string[]> {
  if (change.kind === "email_draft") return change.senderId ? [change.senderId] : [];
  const target = change.rowId ?? change.databaseId;
  const mayEdit = async (userId: string) =>
    !(await isAgentUser(userId)) && Boolean(await findMembership(userId, change.workspaceId)) && hasLevel((await pageAccessOf(userId, target)).level, "edit");
  for (const id of new Set(candidates.filter((c): c is string => !!c))) {
    if (await mayEdit(id)) return [id];
  }
  const owners = await workspaceOwnerIds(change.workspaceId);
  const able = await Promise.all(owners.map(mayEdit));
  return owners.filter((_, i) => able[i]);
}

/**
 * Tells people that something waits for their review: one unread notification each per workspace,
 * brought back to the top (naming the latest agent) when one is there already, so a run proposing
 * twenty changes rings once. Never throws.
 */
export async function notifyReviewers(workspaceId: string, userIds: string[], agentUserId: string | null) {
  if (!userIds.length) return;
  try {
    const fresh: string[] = [];
    for (const userId of new Set(userIds)) {
      const [waiting] = await db
        .update(notification)
        .set({ createdAt: new Date(), actorId: agentUserId })
        .where(
          and(
            eq(notification.userId, userId),
            eq(notification.workspaceId, workspaceId),
            eq(notification.kind, "review"),
            isNull(notification.readAt),
            isNull(notification.snoozedUntil),
          ),
        )
        .returning({ id: notification.id });
      if (waiting) continue;
      const [made] = await db.insert(notification).values({ userId, workspaceId, kind: "review", actorId: agentUserId }).returning({ id: notification.id });
      fresh.push(made.id);
    }
    signalInbox(workspaceId);
    pushNotifications(fresh);
  } catch (error) {
    console.error("[review] could not notify reviewers", redactError(error));
  }
}

// ----------------------------------------------------------------------------------- reading

const rowPage = alias(page, "row_page");
const databasePage = alias(page, "database_page");
const decider = alias(user, "decider");
const sender = alias(user, "sender");

/** SQL: the viewer's access rank on what a proposal changes (its row, or for a new row its database). */
const targetRank = (userId: string) => accessRank(userId, sql`coalesce(${pendingChange.rowId}, ${pendingChange.databaseId})`);
const EDIT_RANK = 3;

/** SQL: proposals the viewer may at least see, by their access to the page (values and email are checked after). */
const seenBy = (userId: string) => sql`${targetRank(userId)} > 0`;

/**
 * Proposals of a workspace the viewer may see, newest first: those still to be answered (`open`,
 * the default) or answered and expired ones still kept (`decided`), narrowed by `filter`.
 */
export async function listPendingChanges(
  userId: string,
  workspaceId: string,
  { filter = {}, status = "open", limit = MAX_PENDING_PAGE }: { filter?: PendingChangeFilter; status?: "open" | "decided"; limit?: number } = {},
): Promise<PendingChangeView[]> {
  const membership = await findMembership(userId, workspaceId);
  if (!membership) throw new AccessError();
  const where = and(
    eq(pendingChange.workspaceId, workspaceId),
    status === "open" ? inArray(pendingChange.status, [...OPEN]) : sql`${pendingChange.status} not in ('pending', 'failed')`,
    filter.agentId ? eq(pendingChange.agentId, filter.agentId) : undefined,
    filter.databaseId ? eq(pendingChange.databaseId, filter.databaseId) : undefined,
    filter.rowId ? eq(pendingChange.rowId, filter.rowId) : undefined,
    seenBy(userId),
  );
  return viewsOf(userId, where, Math.min(Math.max(1, limit), MAX_PENDING_PAGE));
}

/** One proposal as the viewer sees it; null when they may not see it. */
export async function getPendingChange(userId: string, changeId: string): Promise<PendingChangeView | null> {
  const [view] = await viewsOf(userId, and(eq(pendingChange.id, changeId), seenBy(userId)), 1);
  return view ?? null;
}

/**
 * How many proposals of the workspace the viewer could answer now: what the sidebar counts. Goes by
 * their access to the pages (and an email draft's sender), not by each value, so it may count one
 * the queue then leaves out for a value they may not see.
 */
export async function countPendingFor(userId: string, workspaceId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(pendingChange)
    .where(
      and(
        eq(pendingChange.workspaceId, workspaceId),
        inArray(pendingChange.status, [...OPEN]),
        or(
          and(eq(pendingChange.kind, "email_draft"), eq(pendingChange.senderId, userId)),
          and(sql`${pendingChange.kind} <> 'email_draft'`, sql`${targetRank(userId)} >= ${EDIT_RANK}`),
        ),
      ),
    );
  return row?.n ?? 0;
}

/** The agents and databases of the proposals waiting that the viewer sees, for the queue's filters. */
export async function pendingFacets(userId: string, workspaceId: string) {
  const views = await listPendingChanges(userId, workspaceId);
  const agents = new Map<string, NonNullable<PendingChangeView["agent"]>>();
  const databases = new Map<string, PendingChangeView["database"]>();
  for (const v of views) {
    if (v.agent) agents.set(v.agent.id, v.agent);
    databases.set(v.database.id, v.database);
  }
  return { agents: [...agents.values()], databases: [...databases.values()] };
}

const effective = (c: Pick<Change, "payload" | "editedPayload">) => c.editedPayload ?? c.payload;
const asRow = (p: PendingChangePayload) => p as RowChangePayload;
const asEmail = (p: PendingChangePayload) => p as EmailDraftPayload;

async function viewsOf(viewer: string, where: SQL | undefined, limit: number): Promise<PendingChangeView[]> {
  const rows = await db
    .select({
      change: pendingChange,
      rank: targetRank(viewer),
      rowTitle: rowPage.title,
      rowIcon: rowPage.icon,
      rowProperties: rowPage.properties,
      rowCreatedBy: rowPage.createdBy,
      rowArchived: rowPage.archivedAt,
      databaseTitle: databasePage.title,
      databaseIcon: databasePage.icon,
      agentName: workspaceAgent.name,
      agentIcon: workspaceAgent.icon,
      agentUserId: workspaceAgent.userId,
      runKept: agentRun.id,
      deciderName: decider.name,
      senderName: sender.name,
    })
    .from(pendingChange)
    .innerJoin(databasePage, eq(databasePage.id, pendingChange.databaseId))
    .leftJoin(rowPage, eq(rowPage.id, pendingChange.rowId))
    .leftJoin(workspaceAgent, eq(workspaceAgent.id, pendingChange.agentId))
    .leftJoin(agentRun, eq(agentRun.id, pendingChange.agentRunId))
    .leftJoin(decider, eq(decider.id, pendingChange.decidedBy))
    .leftJoin(sender, eq(sender.id, pendingChange.senderId))
    .where(where)
    .orderBy(desc(pendingChange.updatedAt), desc(pendingChange.id))
    .limit(limit);
  if (!rows.length) return [];

  // Each database's properties and the viewer's access to them, once.
  const databaseIds = [...new Set(rows.filter((r) => r.change.kind !== "email_draft").map((r) => r.change.databaseId))];
  const schemas = new Map(
    await Promise.all(databaseIds.map(async (id) => [id, { properties: await getProperties(id), access: await propertyAccessFor(viewer, id) }] as const)),
  );
  const mailReadable = new Map<string, Promise<boolean>>();
  const readsMail = (rowId: string) => {
    if (!mailReadable.has(rowId)) mailReadable.set(rowId, rowMailAccess(viewer, rowId).then(Boolean));
    return mailReadable.get(rowId)!;
  };

  type Prepared = { r: (typeof rows)[number]; fields: { property: Awaited<ReturnType<typeof getProperties>>[number] | null; before: unknown; now: unknown; after: unknown }[]; editable: boolean };
  const prepared: Prepared[] = [];
  for (const r of rows) {
    const c = r.change;
    const level = levelFromRank(r.rank);
    if (c.kind === "email_draft") {
      if (!c.rowId || r.rowArchived || !(await readsMail(c.rowId))) continue;
      prepared.push({ r, fields: [], editable: c.senderId === viewer && hasLevel(level, "edit") });
      continue;
    }
    const schema = schemas.get(c.databaseId)!;
    const accessRow = { properties: (r.rowProperties ?? {}) as Record<string, unknown>, createdBy: r.rowCreatedBy };
    const payload = asRow(effective(c));
    const before = c.before ?? { properties: {} };
    const current = (r.rowProperties ?? {}) as Record<string, unknown>;
    // Values of properties deleted since are left out (approving leaves them out too). A value the
    // viewer may not see keeps the whole proposal from them: its diff would show it.
    const props = Object.keys(payload.properties ?? {}).flatMap((id) => schema.properties.find((p) => p.id === id) ?? []);
    const ids = props.map((p) => p.id);
    if (schema.access.visible(props).length !== props.length || ids.some((id) => !atLeast(schema.access.levelOf(id, accessRow), "view"))) continue;
    const fields: Prepared["fields"] = [];
    if (payload.title !== undefined) {
      fields.push({ property: null, before: c.kind === "create_row" ? null : (before.title ?? null), now: c.kind === "create_row" ? null : (r.rowTitle ?? null), after: payload.title });
    }
    for (const prop of props) {
      fields.push({
        property: prop,
        before: c.kind === "create_row" ? null : before.properties[prop.id],
        now: c.kind === "create_row" ? null : current[prop.id],
        after: payload.properties[prop.id],
      });
    }
    const editable = hasLevel(level, "edit") && ids.every((id) => atLeast(schema.access.levelOf(id, accessRow), "edit_values"));
    prepared.push({ r, fields, editable });
  }

  const ids = referencedIds(prepared.flatMap(({ fields }) => fields.flatMap((f) => [f.before, f.now, f.after].map((value) => ({ type: f.property?.type ?? null, value })))));
  const lookups = await loadLookups(viewer, [...ids.people], [...ids.pages]);
  const read = (f: Prepared["fields"][number], value: unknown): ActivityValue =>
    f.property ? resolveValue(f.property.type, f.property.options.options ?? [], value, lookups) : resolveValue("text", [], value, lookups);

  return prepared.map(({ r, fields, editable }) => {
    const c = r.change;
    const views: PendingFieldView[] = fields.map((f) => {
      const changed = c.kind === "update_row" && !sameValue(f.before, f.now);
      return {
        property: f.property ? { id: f.property.id, name: f.property.name, type: f.property.type } : null,
        before: c.kind === "create_row" ? null : read(f, f.before),
        now: changed ? read(f, f.now) : null,
        after: read(f, f.after),
        raw: f.after ?? null,
        conflict: changed && !sameValue(f.now, f.after),
      };
    });
    const payload = effective(c);
    return {
      id: c.id,
      workspaceId: c.workspaceId,
      kind: c.kind,
      status: c.status,
      error: c.error,
      reason: c.reason,
      database: { id: c.databaseId, title: r.databaseTitle ?? "", icon: r.databaseIcon ?? null },
      row: c.rowId && r.rowTitle !== null ? { id: c.rowId, title: r.rowTitle, icon: r.rowIcon ?? null } : null,
      agent: c.agentId && r.agentName !== null && r.agentUserId ? { id: c.agentId, name: r.agentName, icon: r.agentIcon ?? null, userId: r.agentUserId } : null,
      runId: r.runKept ?? null,
      fields: views,
      markdown: c.kind === "create_row" ? (asRow(payload).markdown ?? null) : null,
      email: c.kind === "email_draft" ? { ...asEmail(payload), sender: { id: c.senderId ?? "", name: r.senderName ?? "" } } : null,
      sequence: c.source.kind === "sequence" ? { sequenceId: c.source.sequenceId, name: c.source.name, enrollmentId: c.source.enrollmentId, step: c.source.step, steps: c.source.steps } : null,
      edited: c.editedPayload !== null,
      conflict: views.some((v) => v.conflict),
      canApprove: isOpen(c.status) && editable,
      createdAt: c.createdAt.toISOString(),
      expiresAt: c.expiresAt.toISOString(),
      decidedAt: c.decidedAt?.toISOString() ?? null,
      decidedBy: c.decidedBy ? { id: c.decidedBy, name: r.deciderName ?? "" } : null,
    };
  });
}

// ----------------------------------------------------------------------------------- answering

/** The proposal, still to be answered, for someone who may answer it (they see it and could make it). */
async function answerable(userId: string, changeId: string): Promise<{ change: Change; view: PendingChangeView }> {
  const view = await getPendingChange(userId, changeId);
  if (!view) throw new PendingChangeError("notFound", "No change waiting for review has this id, or you may not see it.");
  const [change] = await db.select().from(pendingChange).where(eq(pendingChange.id, changeId));
  if (!change) throw new PendingChangeError("notFound", "No change waiting for review has this id, or you may not see it.");
  if (!isOpen(change.status)) throw new PendingChangeError("decided", "This change was already answered.");
  if (!view.canApprove) {
    throw change.kind === "email_draft" ? new AccessError("Only the person whose mailbox it goes out from may send or dismiss an email draft.") : new AccessError();
  }
  return { change, view };
}

/**
 * A reviewer's edit of a proposal, checked as they would make it: a row change keeps to the
 * values it proposed (a value can be changed or left out, the title too), each checked against its
 * property as the reviewer; an email keeps its recipients the row's, and its subject on one line.
 */
async function checkEdit(userId: string, change: Change, edit: unknown): Promise<PendingChangePayload> {
  if (!edit || typeof edit !== "object" || Array.isArray(edit)) throw new PendingChangeError("invalid", "The edit must be an object.");
  const e = edit as Record<string, unknown>;
  if (change.kind === "email_draft") {
    const was = asEmail(change.payload);
    const subject = typeof e.subject === "string" ? e.subject : was.subject;
    const text = typeof e.text === "string" ? e.text.replace(/\r\n/g, "\n") : was.text;
    if (/[\r\n]/.test(subject)) throw new PendingChangeError("invalid", "An email's subject is one line.");
    if (!subject.trim() && !text.trim()) throw new PendingChangeError("invalid", "An email needs a subject or a text.");
    const list = (value: unknown, fallback: string[]) => {
      if (value === undefined) return fallback;
      if (!Array.isArray(value)) throw new PendingChangeError("invalid", "Recipients are a list of addresses.");
      const out = value.map(normalizeAddress);
      if (out.some((a) => !a)) throw new PendingChangeError("invalid", "A recipient's address isn't valid.");
      return [...new Set(out as string[])];
    };
    const to = list(e.to, was.to);
    if (!to.length) throw new PendingChangeError("invalid", "An email needs a recipient.");
    return { to, cc: list(e.cc, was.cc ?? []).filter((a) => !to.includes(a)), subject: subject.trim(), text, replyTo: was.replyTo };
  }
  const was = asRow(change.payload);
  const out: RowChangePayload = { properties: {} };
  if (e.title !== undefined) {
    if (typeof e.title !== "string" || !e.title.trim()) throw new PendingChangeError("invalid", "A row's title can't be empty.");
    if (was.title === undefined && change.kind === "update_row") throw new PendingChangeError("invalid", "This change doesn't rename the row.");
    out.title = e.title.trim().slice(0, 500);
  } else if (was.title !== undefined && change.kind === "create_row") out.title = was.title;
  const properties = e.properties === undefined ? was.properties : e.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) throw new PendingChangeError("invalid", "properties are values by property id.");
  const given = properties as Record<string, unknown>;
  if (Object.keys(given).length) {
    const [row] = change.rowId ? await db.select({ properties: page.properties, createdBy: page.createdBy }).from(page).where(eq(page.id, change.rowId)) : [];
    try {
      // By property id or name, values as the row tools take them; stored as the row would store them.
      out.properties = await normalizeRowProperties(userId, change.databaseId, given, (row?.properties ?? {}) as Record<string, unknown>, { createdBy: row?.createdBy ?? null });
    } catch (error) {
      if (error instanceof PropertyValueError) throw new PendingChangeError("invalid", error.message);
      throw error;
    }
    const extra = Object.keys(out.properties).filter((id) => !(id in (was.properties ?? {})));
    if (extra.length) throw new PendingChangeError("invalid", "An edit changes or leaves out the values proposed; it can't set others.");
  }
  if (change.kind === "create_row") {
    if (!out.title) throw new PendingChangeError("invalid", "A new row needs a title.");
    const markdown = e.markdown === undefined ? was.markdown : typeof e.markdown === "string" ? e.markdown : undefined;
    if (markdown) out.markdown = markdown;
  }
  if (change.kind === "update_row" && out.title === undefined && !Object.keys(out.properties).length) {
    throw new PendingChangeError("invalid", "The edit leaves nothing to change: dismiss the proposal instead.");
  }
  return out;
}

/** Saves a reviewer's edit of a proposal without answering it; what approving then makes. */
export async function editPendingChange(userId: string, changeId: string, edit: unknown): Promise<PendingChangeView> {
  const { change } = await answerable(userId, changeId);
  const payload = await checkEdit(userId, change, edit);
  await db.update(pendingChange).set({ editedPayload: payload, updatedAt: new Date() }).where(eq(pendingChange.id, changeId));
  return (await getPendingChange(userId, changeId))!;
}

export type ApproveOptions = {
  /** An edit to make instead of what was proposed (saved with it). */
  payload?: unknown;
  /** Approve although the row changed since, in a value the proposal sets. */
  force?: boolean;
  actor?: WriteActor;
};

/**
 * Approves a proposal and makes it, as the approver: a row added or changed with their access (and
 * each value checked as theirs), the row's activity crediting the agent; an email queued from the
 * sender's mailbox. A row that changed since in a value it sets needs `force`. A change that can't
 * be made (a value no longer valid, the mailbox gone) is kept as failed with why, to edit and
 * approve again or dismiss.
 */
export async function approvePendingChange(userId: string, changeId: string, options: ApproveOptions = {}): Promise<PendingChangeView> {
  const { change, view } = await answerable(userId, changeId);
  let current = change;
  if (options.payload !== undefined) {
    const payload = await checkEdit(userId, change, options.payload);
    [current] = await db.update(pendingChange).set({ editedPayload: payload, updatedAt: new Date() }).where(eq(pendingChange.id, changeId)).returning();
  }
  const fresh = options.payload !== undefined ? ((await getPendingChange(userId, changeId)) ?? view) : view;
  if (fresh.conflict && !options.force) {
    throw new PendingChangeError("conflict", "The row changed since this was proposed, in a value it sets. Look at it again, and approve anyway (force) or dismiss it.");
  }
  // Taken first, so two people approving at once make it once.
  const [taken] = await db
    .update(pendingChange)
    .set({ status: "approved", decidedBy: userId, decidedAt: new Date(), error: null, updatedAt: new Date() })
    .where(and(eq(pendingChange.id, changeId), inArray(pendingChange.status, [...OPEN])))
    .returning();
  if (!taken) throw new PendingChangeError("decided", "This change was already answered.");
  const actor = options.actor ?? { userId };
  let resultId: string | null = null;
  try {
    resultId = await make(userId, actor, current);
  } catch (error) {
    const message = failure(error);
    if (message === null) {
      // Not theirs to make after all (their access changed meanwhile): it waits again.
      await db.update(pendingChange).set({ status: change.status, decidedBy: null, decidedAt: null }).where(eq(pendingChange.id, changeId));
      throw error;
    }
    await db.update(pendingChange).set({ status: "failed", error: message.slice(0, 500) }).where(eq(pendingChange.id, changeId));
    await audit(userId, current, view, "review.approved", { outcome: "failed" });
    signalQueue(change.workspaceId, [change.databaseId]);
    return (await getPendingChange(userId, changeId))!;
  }
  await db
    .update(pendingChange)
    .set({ ...(current.kind === "create_row" ? { rowId: resultId } : { resultId }) })
    .where(eq(pendingChange.id, changeId));
  await audit(userId, current, view, "review.approved", { outcome: "done" });
  signalQueue(change.workspaceId, [change.databaseId]);
  return (await getPendingChange(userId, changeId)) ?? { ...view, status: "approved", canApprove: false };
}

/** Why making an approved change failed, for the reviewer; null for what isn't the change's fault (access). */
function failure(error: unknown): string | null {
  if (error instanceof AccessError) return null;
  if (error instanceof PropertyValueError || error instanceof ToolInputError) return error.message;
  if (error instanceof RowMailError) return `mail:${error.code}`;
  if ((error as { code?: unknown }).code === "pageLocked") return "pageLocked";
  console.error("[review] could not make an approved change", redactError(error));
  return "error";
}

/** Makes the change as the approver: the row changed or added, or the email queued. Returns the new row's or message's id. */
async function make(userId: string, actor: WriteActor, change: Change): Promise<string | null> {
  const ctx: ops.OperationContext = { userId, actor };
  const payload = effective(change);
  if (change.kind === "email_draft") {
    if (!change.rowId || change.senderId !== userId) throw new AccessError();
    const email = asEmail(payload);
    const id = await queueRowEmail(userId, change.rowId, { to: email.to, cc: email.cc, subject: email.subject, text: email.text, replyTo: email.replyTo });
    sendSoon();
    return id;
  }
  const row = asRow(payload);
  // Properties deleted since the proposal are left out, as the queue shows it.
  const live = new Set((await getProperties(change.databaseId)).map((p) => p.id));
  const kept = Object.fromEntries(Object.entries(row.properties ?? {}).filter(([id]) => live.has(id)));
  const properties = Object.keys(kept).length ? (kept as NonNullable<ops.Args<"updateDatabaseRow">["properties"]>) : undefined;
  if (change.kind === "update_row" && row.title === undefined && !properties) throw new ToolInputError("The properties this change sets were deleted.");
  return asApprovedProposal(change.proposedBy ?? userId, async () => {
    if (change.kind === "update_row") {
      if (!change.rowId) throw new ToolInputError("The row is gone.");
      await ops.updateDatabaseRow(ctx, { row_id: change.rowId, title: row.title, properties });
      return null;
    }
    const made = await ops.createDatabaseRow(ctx, { database_id: change.databaseId, title: row.title ?? "", properties, markdown: row.markdown });
    return made.id as string;
  });
}

/** Dismisses a proposal: nothing is made. */
export async function dismissPendingChange(userId: string, changeId: string): Promise<PendingChangeView> {
  const { change, view } = await answerable(userId, changeId);
  const [taken] = await db
    .update(pendingChange)
    .set({ status: "dismissed", decidedBy: userId, decidedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(pendingChange.id, changeId), inArray(pendingChange.status, [...OPEN])))
    .returning();
  if (!taken) throw new PendingChangeError("decided", "This change was already answered.");
  await audit(userId, change, view, "review.dismissed");
  signalQueue(change.workspaceId, [change.databaseId]);
  return (await getPendingChange(userId, changeId)) ?? { ...view, status: "dismissed", canApprove: false };
}

export type BulkOutcome = { id: string; ok: true; change: PendingChangeView } | { id: string; ok: false; code: PendingChangeErrorCode | "accessDenied"; error: string };

/**
 * Answers several proposals the same way, each on its own: one that can't be (answered already,
 * changed under it, not the person's) is skipped with why, the rest go on. Approving in bulk never
 * overwrites a row that changed since unless `force`.
 */
export async function decidePendingChanges(userId: string, ids: string[], decision: "approve" | "dismiss", options: { force?: boolean; actor?: WriteActor } = {}): Promise<BulkOutcome[]> {
  const out: BulkOutcome[] = [];
  for (const id of [...new Set(ids)].slice(0, MAX_PENDING_PAGE)) {
    try {
      const change = decision === "approve" ? await approvePendingChange(userId, id, { force: options.force, actor: options.actor }) : await dismissPendingChange(userId, id);
      out.push({ id, ok: true, change });
    } catch (error) {
      if (error instanceof PendingChangeError) out.push({ id, ok: false, code: error.code, error: error.message });
      else if (error instanceof AccessError) out.push({ id, ok: false, code: "accessDenied", error: error.message || "You may not answer this change." });
      else throw error;
    }
  }
  return out;
}

async function audit(userId: string, change: Change, view: PendingChangeView, action: "review.approved" | "review.dismissed", extra: Record<string, unknown> = {}) {
  await recordAudit({
    workspaceId: change.workspaceId,
    actorId: userId,
    action,
    target: { type: "page", id: change.rowId ?? change.databaseId, label: view.row?.title ?? view.database.title },
    details: { kind: change.kind, agent: view.agent?.name ?? null, changeId: change.id, ...(change.editedPayload ? { edited: true } : {}), ...extra },
  });
}

// ----------------------------------------------------------------------------------- cleanup

/**
 * The daily cleanup (retention.ts): proposals no one answered within PENDING_CHANGE_DAYS expire, and
 * answered or expired ones go PENDING_CHANGE_HISTORY_DAYS later. Their inbox notifications show
 * only while something waits, so nothing else needs to go. Returns how many expired and went.
 */
export async function expirePendingChanges({ now = new Date(), workspaceIds }: { now?: Date; workspaceIds?: string[] } = {}) {
  if (workspaceIds?.length === 0) return { expired: 0, deleted: 0 };
  const scope = workspaceIds ? inArray(pendingChange.workspaceId, workspaceIds) : undefined;
  const expired = await db
    .update(pendingChange)
    .set({ status: "expired", updatedAt: now })
    .where(and(scope, inArray(pendingChange.status, [...OPEN]), lte(pendingChange.expiresAt, now)))
    .returning({ id: pendingChange.id, workspaceId: pendingChange.workspaceId, databaseId: pendingChange.databaseId });
  const cutoff = new Date(now.getTime() - PENDING_CHANGE_HISTORY_DAYS * DAY_MS);
  const deleted = await db
    .delete(pendingChange)
    .where(and(scope, sql`${pendingChange.status} not in ('pending', 'failed')`, sql`coalesce(${pendingChange.decidedAt}, ${pendingChange.expiresAt}) <= ${cutoff.toISOString()}`))
    .returning({ id: pendingChange.id });
  for (const ws of new Set(expired.map((e) => e.workspaceId))) {
    signalQueue(
      ws,
      expired.filter((e) => e.workspaceId === ws).map((e) => e.databaseId),
    );
  }
  return { expired: expired.length, deleted: deleted.length };
}

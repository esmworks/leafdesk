/**
 * Asking people to approve a page. Someone who can edit a page or row asks one to twenty people who
 * can open it to approve it, all of them or any one; sending saves the page as a named version
 * ("Sent for approval") and the request is about that version. Each approver hears of it in the
 * inbox and sees a banner under the title until they approve or ask for changes (with a comment).
 * Anyone asking for changes ends the round; everyone approving (or one, with "any") ends it
 * approved, renames the version "Approved" and tells the requester. One open round per page: a new
 * one withdraws it, and the requester or anyone with full access can withdraw it. Rules that need
 * no database are lib/page-approvals; the header reads `approvalHeader` with the page
 * (server/page-meta), the badge's popover `approvalHistory`.
 *
 * Approvals say something about the workspace's own reading of the page: published pages, exports
 * and copies don't carry them. Versions a round points at are never pruned (server/retention.ts).
 */
import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { createTranslator } from "next-intl";
import { db } from "@/db";
import { page, pageApproval, pageApprovalDecision, pageSnapshot, user } from "@/db/schema";
import { loadMessages } from "@/i18n/messages";
import { PAGE_HEADER_EVENT } from "@/lib/collab-constants";
import {
  checkApprovalRequest,
  checkDecision,
  roundOutcome,
  type ApprovalDecision,
  type ApprovalErrorCode,
  type ApprovalHeader,
  type ApprovalRound,
} from "@/lib/page-approvals";
import { AccessError, isGuest, requireMembership, requirePageAccess, resolvePageAccess } from "@/server/access";
import { notAgentUser } from "@/server/agents/users";
import { recordAudit } from "@/server/audit";
import { getCollab } from "@/server/collab/bridge";
import { recipientLocale } from "@/server/mail/locale";
import { pageRecipients, recordApprovalDecided, recordApprovalRequest, withdrawApprovalRequests } from "@/server/notifications";
import { workspacePeople } from "@/server/workspaces";

export class ApprovalError extends Error {
  constructor(
    readonly code: ApprovalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ApprovalError";
  }
}

/** How many past rounds the history shows. */
const HISTORY_LIMIT = 30;

const todayUtc = (now = new Date()) => now.toISOString().slice(0, 10);

/** A version's name ("Sent for approval", "Approved") in the language `userId` last used. */
async function versionLabel(userId: string, which: "sent" | "approved") {
  const locale = await recipientLocale(userId, null);
  const messages = await loadMessages(locale);
  const t = createTranslator({ locale, messages: { versions: messages.page.approval.versions }, namespace: "versions" });
  return t(which);
}

/** Whether `pageId` changed since this version: its title or body is no longer the version's. */
const changedSince = (pageTitle: SQL | string, pageBody: SQL | string) =>
  sql<boolean>`(${pageSnapshot.id} is not null and (${pageSnapshot.title} is distinct from ${pageTitle} or ${pageSnapshot.contentMarkdown} is distinct from ${pageBody}))`;

/** The page someone may ask approval of: edit access, a member (not a guest), a page or row outside templates and the trash. */
async function requireRequestable(userId: string, pageId: string) {
  const found = await requirePageAccess(userId, pageId, "edit");
  if (found.kind === "database") throw new ApprovalError("database", "Databases aren't approved; their rows and pages are");
  if (found.isTemplate || found.inTemplate) throw new ApprovalError("template", "Templates and the pages in them aren't approved");
  if (found.archivedAt) throw new ApprovalError("inTrash", "Restore the page from the trash first");
  const membership = await requireMembership(userId, found.workspaceId);
  if (isGuest(membership.role)) throw new ApprovalError("guest", "Guests can't ask for approval");
  return found;
}

export type ApprovalCandidate = { id: string; name: string; email: string; image: string | null };

/** Who `userId` may ask to approve the page: the people (not agents) who can open it, but themselves. */
export async function approvalCandidates(userId: string, pageId: string): Promise<ApprovalCandidate[]> {
  const found = await requireRequestable(userId, pageId);
  const people = (await workspacePeople(found.workspaceId)).filter((p) => p.id !== userId);
  const allowed = new Set(await pageRecipients(people.map((p) => p.id), pageId));
  return people
    .filter((p) => allowed.has(p.id))
    .map(({ id, name, email, image }) => ({ id, name, email, image }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Asks the approvers in `input` (checked by lib/page-approvals `checkApprovalRequest`; each must be
 * able to open the page now) to approve the page as it is now, as `userId`. Saves the page as a
 * version named "Sent for approval" and withdraws the round still open, if any.
 */
export async function requestApproval(
  userId: string,
  pageId: string,
  input: { approverIds?: unknown; rule?: unknown; dueDate?: unknown; note?: unknown },
): Promise<{ id: string; workspaceId: string; withdrew: string | null }> {
  const found = await requireRequestable(userId, pageId);
  const checked = checkApprovalRequest(input, userId, todayUtc());
  if (!checked.ok) throw new ApprovalError(checked.code, `The request isn't valid (${checked.code})`);
  const { approverIds, rule, dueDate, note } = checked.value;
  const reachable = new Set(await pageRecipients(approverIds, pageId));
  if (approverIds.some((id) => !reachable.has(id))) throw new ApprovalError("approvers", "Every approver must be able to open the page");

  const snapshotId = await getCollab().snapshot(pageId, "manual", { userId }, await versionLabel(userId, "sent"));
  const now = new Date();
  const { id, withdrew } = await db.transaction(async (tx) => {
    const [old] = await tx
      .update(pageApproval)
      .set({ status: "withdrawn", decidedAt: now })
      .where(and(eq(pageApproval.pageId, pageId), eq(pageApproval.status, "open")))
      .returning({ id: pageApproval.id });
    const [made] = await tx
      .insert(pageApproval)
      .values({ workspaceId: found.workspaceId, pageId, snapshotId, requestedBy: userId, rule, note, dueDate, createdAt: now })
      .returning({ id: pageApproval.id });
    await tx.insert(pageApprovalDecision).values(approverIds.map((approver) => ({ approvalId: made.id, userId: approver })));
    return { id: made.id, withdrew: old?.id ?? null };
  });

  await withdrawApprovalRequests(found.workspaceId, pageId);
  await recordApprovalRequest(found.workspaceId, userId, pageId, approverIds);
  const names = await db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, approverIds));
  const target = { type: "page" as const, id: pageId, label: found.title };
  await recordAudit([
    ...(withdrew ? [{ workspaceId: found.workspaceId, actorId: userId, action: "page.approval_withdrawn" as const, target, details: { approvalId: withdrew } }] : []),
    {
      workspaceId: found.workspaceId,
      actorId: userId,
      action: "page.approval_requested",
      target,
      details: { approvalId: id, rule, dueDate, names: approverIds.map((a) => names.find((n) => n.id === a)?.name ?? "") },
    },
  ]);
  getCollab().broadcast(`page:${pageId}`, PAGE_HEADER_EVENT);
  return { id, workspaceId: found.workspaceId, withdrew };
}

async function roundOf(approvalId: string) {
  const [round] = await db.select().from(pageApproval).where(eq(pageApproval.id, approvalId)).limit(1);
  if (!round) throw new AccessError();
  return round;
}

/**
 * `userId` approves the round or asks for changes (a comment saying what is needed). They must be
 * one of its approvers who hasn't decided, and still able to open the page. When this ends the
 * round, its version is renamed "Approved" (on approval) and the requester hears how it ended.
 */
export async function decideApproval(
  userId: string,
  approvalId: string,
  decision: unknown,
  comment: unknown,
): Promise<{ workspaceId: string; pageId: string; status: ApprovalRound["status"] }> {
  const checked = checkDecision(decision, comment);
  if (!checked.ok) throw new ApprovalError(checked.code, `The decision isn't valid (${checked.code})`);
  const round = await roundOf(approvalId);
  const found = await requirePageAccess(userId, round.pageId, "view");
  if (found.archivedAt) throw new ApprovalError("inTrash", "Restore the page from the trash first");
  const approvedName = round.requestedBy ? await versionLabel(round.requestedBy, "approved") : await versionLabel(userId, "approved");
  const now = new Date();
  const status = await db.transaction(async (tx) => {
    // One decision at a time per round, so the last two approvals can't both miss the end.
    const [locked] = await tx.execute<{ status: string }>(sql`select status from page_approval where id = ${approvalId} for update`);
    if (locked?.status !== "open") throw new ApprovalError("closed", "This request is no longer waiting for decisions");
    const [mine] = await tx
      .select({ decision: pageApprovalDecision.decision })
      .from(pageApprovalDecision)
      .where(and(eq(pageApprovalDecision.approvalId, approvalId), eq(pageApprovalDecision.userId, userId)));
    if (!mine) throw new ApprovalError("notApprover", "You weren't asked to approve this page");
    if (mine.decision) throw new ApprovalError("decided", "You already decided");
    await tx
      .update(pageApprovalDecision)
      .set({ decision: checked.decision, comment: checked.comment, decidedAt: now })
      .where(and(eq(pageApprovalDecision.approvalId, approvalId), eq(pageApprovalDecision.userId, userId)));
    const all = await tx.select({ decision: pageApprovalDecision.decision }).from(pageApprovalDecision).where(eq(pageApprovalDecision.approvalId, approvalId));
    const outcome = roundOutcome(round.rule, all.map((d) => d.decision));
    if (outcome !== "open") {
      await tx.update(pageApproval).set({ status: outcome, decidedAt: now }).where(eq(pageApproval.id, approvalId));
      if (outcome === "approved" && round.snapshotId) await tx.update(pageSnapshot).set({ name: approvedName }).where(eq(pageSnapshot.id, round.snapshotId));
    }
    return outcome;
  });

  await recordAudit({
    workspaceId: round.workspaceId,
    actorId: userId,
    action: "page.approval_decided",
    target: { type: "page", id: round.pageId, label: found.title },
    details: { approvalId, decision: checked.decision, ended: status !== "open" },
  });
  if (status !== "open") {
    await withdrawApprovalRequests(round.workspaceId, round.pageId);
    if (round.requestedBy) {
      try {
        await recordApprovalDecided(round.workspaceId, round.requestedBy, userId, round.pageId, status);
      } catch (error) {
        console.error("[page approvals] could not tell the requester", error);
      }
    }
  }
  getCollab().broadcast(`page:${round.pageId}`, PAGE_HEADER_EVENT);
  return { workspaceId: round.workspaceId, pageId: round.pageId, status };
}

/** Withdraws an open round: its requester (while they can open the page) or someone with full access. */
export async function withdrawApproval(userId: string, approvalId: string): Promise<{ workspaceId: string; pageId: string }> {
  const round = await roundOf(approvalId);
  const { page: found, level } = await resolvePageAccess(userId, round.pageId);
  if (!found || level === "none") throw new AccessError();
  if (round.requestedBy !== userId && level !== "full") throw new ApprovalError("notRequester", "Only who asked, or someone with full access, can withdraw it");
  const [done] = await db
    .update(pageApproval)
    .set({ status: "withdrawn", decidedAt: new Date() })
    .where(and(eq(pageApproval.id, approvalId), eq(pageApproval.status, "open")))
    .returning({ id: pageApproval.id });
  if (!done) throw new ApprovalError("closed", "This request is no longer waiting for decisions");
  await withdrawApprovalRequests(round.workspaceId, round.pageId);
  await recordAudit({
    workspaceId: round.workspaceId,
    actorId: userId,
    action: "page.approval_withdrawn",
    target: { type: "page", id: round.pageId, label: found.title },
    details: { approvalId },
  });
  getCollab().broadcast(`page:${round.pageId}`, PAGE_HEADER_EVENT);
  return { workspaceId: round.workspaceId, pageId: round.pageId };
}

/**
 * What the header shows of the page's approvals to `userId` (who the caller checked can open it):
 * its latest round that wasn't withdrawn, or null when there is none.
 */
export async function approvalHeader(userId: string, pageId: string): Promise<ApprovalHeader | null> {
  const [round] = await db
    .select({
      id: pageApproval.id,
      status: pageApproval.status,
      rule: pageApproval.rule,
      note: pageApproval.note,
      dueDate: pageApproval.dueDate,
      snapshotId: pageApproval.snapshotId,
      requestedById: pageApproval.requestedBy,
      requestedBy: user.name,
      createdAt: pageApproval.createdAt,
      decidedAt: pageApproval.decidedAt,
      changed: changedSince(sql`${page.title}`, sql`${page.contentMarkdown}`),
    })
    .from(pageApproval)
    .innerJoin(page, eq(page.id, pageApproval.pageId))
    .leftJoin(pageSnapshot, eq(pageSnapshot.id, pageApproval.snapshotId))
    .leftJoin(user, eq(user.id, pageApproval.requestedBy))
    .where(and(eq(pageApproval.pageId, pageId), sql`${pageApproval.status} <> 'withdrawn'`))
    .orderBy(desc(pageApproval.createdAt))
    .limit(1);
  if (!round || round.status === "withdrawn") return null;
  const decisions = await db
    .select({ userId: pageApprovalDecision.userId, name: user.name, decision: pageApprovalDecision.decision })
    .from(pageApprovalDecision)
    .leftJoin(user, eq(user.id, pageApprovalDecision.userId))
    .where(eq(pageApprovalDecision.approvalId, round.id))
    .orderBy(asc(pageApprovalDecision.decidedAt));
  const mine = decisions.find((d) => d.userId === userId);
  return {
    id: round.id,
    status: round.status,
    rule: round.rule,
    changed: Boolean(round.changed),
    requestedById: round.requestedById,
    requestedBy: round.requestedBy,
    requestedAt: round.createdAt.toISOString(),
    decidedAt: round.decidedAt?.toISOString() ?? null,
    approvedBy: decisions.filter((d) => d.decision === "approved").map((d) => d.name ?? ""),
    total: decisions.length,
    ask: round.status === "open" && mine && mine.decision === null ? { note: round.note, dueDate: round.dueDate, snapshotId: round.snapshotId } : null,
  };
}

/** The page's approval rounds, newest first, for someone who can open it. */
export async function approvalHistory(userId: string, pageId: string): Promise<ApprovalRound[]> {
  await requirePageAccess(userId, pageId, "view");
  const rounds = await db
    .select({
      id: pageApproval.id,
      status: pageApproval.status,
      rule: pageApproval.rule,
      note: pageApproval.note,
      dueDate: pageApproval.dueDate,
      createdAt: pageApproval.createdAt,
      decidedAt: pageApproval.decidedAt,
      requestedById: pageApproval.requestedBy,
      requestedBy: user.name,
      snapshotId: pageApproval.snapshotId,
    })
    .from(pageApproval)
    .leftJoin(user, eq(user.id, pageApproval.requestedBy))
    .where(eq(pageApproval.pageId, pageId))
    .orderBy(desc(pageApproval.createdAt))
    .limit(HISTORY_LIMIT);
  if (!rounds.length) return [];
  const decisions = await db
    .select({
      approvalId: pageApprovalDecision.approvalId,
      userId: pageApprovalDecision.userId,
      name: user.name,
      decision: pageApprovalDecision.decision,
      comment: pageApprovalDecision.comment,
      decidedAt: pageApprovalDecision.decidedAt,
      canOpen: sql<boolean>`page_access_level(${pageApprovalDecision.userId}, ${pageId}) > 0`,
    })
    .from(pageApprovalDecision)
    .innerJoin(user, and(eq(user.id, pageApprovalDecision.userId), notAgentUser(user.id)))
    .where(
      inArray(
        pageApprovalDecision.approvalId,
        rounds.map((r) => r.id),
      ),
    )
    .orderBy(sql`${pageApprovalDecision.decidedAt} asc nulls last`, asc(user.name));
  return rounds.map((r) => ({
    id: r.id,
    status: r.status,
    rule: r.rule,
    note: r.note,
    dueDate: r.dueDate,
    createdAt: r.createdAt.toISOString(),
    decidedAt: r.decidedAt?.toISOString() ?? null,
    requestedById: r.requestedById,
    requestedBy: r.requestedBy,
    snapshotId: r.snapshotId,
    decisions: decisions
      .filter((d) => d.approvalId === r.id)
      .map((d) => ({
        userId: d.userId,
        name: d.name,
        decision: d.decision as ApprovalDecision | null,
        comment: d.comment,
        decidedAt: d.decidedAt?.toISOString() ?? null,
        canOpen: Boolean(d.canOpen),
      })),
  }));
}

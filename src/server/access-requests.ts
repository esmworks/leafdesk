import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { accessRequest, user, workspace } from "@/db/schema";
import {
  ACCESS_REQUEST_LIMIT,
  cleanRequestMessage,
  isAbove,
  type ApprovalLevel,
  type MoreAccessLevel,
  type RequestedLevel,
} from "@/lib/access-requests";
import { env } from "@/lib/env";
import { pageLabel } from "@/lib/labels";
import { sharedLimiter, takeAll } from "@/lib/rate-limit";
import { AccessError, findMembership, levelFromRank, pageAccessOf, rankOf, requirePageAccess, workspaceRoleOf, type AccessLevel } from "@/server/access";
import { recordAudit } from "@/server/audit";
import { accessApprovedEmail, accessDeclinedEmail } from "@/server/mail";
import { recipientLocale, requestLocale } from "@/server/mail/locale";
import { emailTranslator } from "@/server/mail/templates";
import { recordAccessRequest, signalInbox, skipShareEmail } from "@/server/notifications";
import { setPagePermission, sharePageByEmail } from "@/server/permissions";
import { mailNow } from "@/server/share-emails";
import { canInviteGuests, workspaceSettings } from "@/server/workspaces";
import { refuseInLocalMode } from "@/server/local-mode";

/**
 * Asking for access to a page from the "You don't have access" screen, and answering the request.
 *
 * The screen is what a signed-in person gets for any page they can't open, including pages that
 * don't exist, so it must not tell the two apart: `requestPageAccess` answers the same whatever
 * the page, and only stores a request when there is one to make (the page exists, isn't in the
 * trash, the person can't open it and its workspace takes requests). Everyone with full access to
 * the page hears about it (inbox and email) and can approve it, picking a level, or decline it.
 * People outside the workspace can ask too; approving brings them in as guests through
 * `sharePageByEmail`, so the workspace's guest invite policy decides whether that is allowed.
 *
 * Someone who can already open a page may ask for more from its Share menu (`requestMoreAccess`):
 * comment or edit access, whatever they have less of. That page is known to them, so the answer
 * says what happened. Approvers give the level asked for or another one above what the requester
 * has. A person has one request per page: asking for more than the pending one asks again.
 */

export type AccessRequestOutcome = "sent" | "rateLimited";

/** An answer to a request that can't be given (a level the requester already has). */
export class AccessRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessRequestError";
  }
}

const limiter = () => sharedLimiter("access-request", ACCESS_REQUEST_LIMIT.count, ACCESS_REQUEST_LIMIT.windowMs);

/** Scripts and tests: start the per-person limit over. */
export function resetAccessRequestLimits() {
  limiter().reset();
}

/**
 * Whether the screen for a page of `workspaceId` (the one in its address) offers to ask for
 * access. It goes by the address, never by the page, so the answer is the same for a page that
 * doesn't exist; a workspace that doesn't exist gets the default.
 */
export async function accessRequestsOffered(workspaceId: string) {
  // On one computer there is no one else to ask.
  if (env.localMode) return false;
  return (await workspaceSettings(workspaceId)).accessRequests;
}

/**
 * Asks the people with full access to `pageId` to let `userId` in. Answers "sent" whether or not a
 * request was stored, so nobody learns from it whether the page exists, and "rateLimited" once the
 * person asked too often (every call counts, for the same reason). Asking again while a request is
 * pending keeps the first one, message included.
 *
 * The lookups and writes run through `defer`: the "You don't have access" screen passes Next's
 * `after`, so they happen once the answer is on its way and its timing can't tell an existing page
 * from a missing one either. Without it (tests, scripts) they run before answering.
 */
export async function requestPageAccess(
  userId: string,
  pageId: string,
  message?: unknown,
  defer: (work: () => Promise<void>) => void | Promise<void> = (work) => work(),
): Promise<AccessRequestOutcome> {
  refuseInLocalMode();
  if (takeAll([[limiter(), userId]]) > 0) return "rateLimited";
  // Read while the request is still there: deferred work runs without it.
  const locale = await requestLocale();
  await defer(async () => void (await storeAccessRequest(userId, pageId, cleanRequestMessage(message), locale, "view")));
  return "sent";
}

/**
 * The SQL condition under which a stored request still waits: the requester has less than they
 * asked for (requests of people who got in some other way since are left out everywhere).
 */
export const stillWanted = sql`page_access_level(${accessRequest.requesterId}, ${accessRequest.pageId}) < ${rankOf(accessRequest.level)}`;

/**
 * Stores the request for `wanted` and tells the people who can answer it, when there is anything
 * to ask for: "view" (any access) only without access, more only with less than that. A request
 * still pending for as much or more stays as it was ("pending"); one for less, or one already
 * answered some other way, gives way to the new one.
 */
async function storeAccessRequest(
  userId: string,
  pageId: string,
  message: string | null,
  locale: string,
  wanted: RequestedLevel,
): Promise<"stored" | "pending" | "nothing"> {
  // Without the sign-in policies: a policy holding back their session doesn't give them access.
  const { page: target, level } = await pageAccessOf(userId, pageId);
  if (!target || target.archivedAt || !isAbove(wanted, level)) return "nothing";
  if (wanted !== "view" && level === "none") return "nothing";
  if (!(await workspaceSettings(target.workspaceId)).accessRequests) return "nothing";
  const created = await db.transaction(async (tx) => {
    const [pending] = await tx
      .select({ id: accessRequest.id, level: accessRequest.level, wanted: sql<boolean>`${stillWanted}` })
      .from(accessRequest)
      .where(and(eq(accessRequest.pageId, pageId), eq(accessRequest.requesterId, userId)))
      .for("update");
    if (pending?.wanted && !isAbove(wanted, pending.level)) return null;
    // Its notifications go with it (foreign key).
    if (pending) await tx.delete(accessRequest).where(eq(accessRequest.id, pending.id));
    const [row] = await tx
      .insert(accessRequest)
      .values({ pageId, workspaceId: target.workspaceId, requesterId: userId, level: wanted, message, locale })
      .onConflictDoNothing()
      .returning({ id: accessRequest.id });
    return row ?? null;
  });
  if (!created) return "pending";
  await recordAccessRequest(target.workspaceId, pageId, created.id, userId, locale);
  return "stored";
}

export type MoreAccessOutcome = "sent" | "rateLimited" | "unavailable";

/**
 * From the Share menu of a page `userId` can open: asks the people with full access to it for
 * `level`. "unavailable" when the workspace takes no requests or they already have that much.
 * Asking again while a request for as much is pending keeps that one ("sent"). AccessError
 * without access to the page.
 */
export async function requestMoreAccess(userId: string, pageId: string, level: MoreAccessLevel, message?: unknown): Promise<MoreAccessOutcome> {
  refuseInLocalMode();
  const target = await requirePageAccess(userId, pageId, "view");
  if (!(await accessRequestsOffered(target.workspaceId))) return "unavailable";
  if (takeAll([[limiter(), userId]]) > 0) return "rateLimited";
  const stored = await storeAccessRequest(userId, pageId, cleanRequestMessage(message), await requestLocale(), level);
  return stored === "nothing" ? "unavailable" : "sent";
}

/** The level `userId` asked for on the page while that request waits; null without one. */
export async function pendingRequestOf(userId: string, pageId: string): Promise<RequestedLevel | null> {
  const [row] = await db
    .select({ level: accessRequest.level })
    .from(accessRequest)
    .where(and(eq(accessRequest.pageId, pageId), eq(accessRequest.requesterId, userId), stillWanted));
  return row?.level ?? null;
}

export type PendingAccessRequest = {
  id: string;
  requesterId: string;
  name: string;
  /** Null for guests asking about someone in the workspace: guests don't learn members' addresses. */
  email: string | null;
  image: string | null;
  message: string | null;
  /** What they asked for: "view" is any access (from the no-access screen). */
  level: RequestedLevel;
  /** What they have now: none, or less than `level` for those asking for more. */
  current: AccessLevel;
  createdAt: Date;
  /** They are in the workspace (member or guest); otherwise approving adds them as a guest. */
  inWorkspace: boolean;
  /** The user may approve it: always for people in the workspace, for others when they may invite guests. */
  approvable: boolean;
};

/**
 * The page's pending requests, oldest first, for someone with full access to it (the share panel).
 * Requests of people who got in some other way since are left out.
 */
export async function listAccessRequests(actorId: string, pageId: string): Promise<PendingAccessRequest[]> {
  const target = await requirePageAccess(actorId, pageId, "full");
  const rows = await db
    .select({
      id: accessRequest.id,
      requesterId: accessRequest.requesterId,
      name: user.name,
      email: user.email,
      image: user.image,
      message: accessRequest.message,
      level: accessRequest.level,
      current: sql<number>`page_access_level(${accessRequest.requesterId}, ${accessRequest.pageId})`,
      createdAt: accessRequest.createdAt,
      role: workspaceRoleOf(accessRequest.requesterId, accessRequest.workspaceId),
    })
    .from(accessRequest)
    .innerJoin(user, eq(user.id, accessRequest.requesterId))
    .where(and(eq(accessRequest.pageId, pageId), stillWanted))
    .orderBy(asc(accessRequest.createdAt));
  const mayInvite = rows.some((r) => r.role === null) && (await canInviteGuests(actorId, target.workspaceId));
  // A guest with full access sees who asked, but not the address of anyone in the workspace (as in
  // listPagePermissions). Someone outside it gave theirs by asking.
  const asGuest = (await findMembership(actorId, target.workspaceId))?.role === "guest";
  return rows.map(({ role, current, ...r }) => ({
    ...r,
    current: levelFromRank(current),
    email: asGuest && role !== null && r.requesterId !== actorId ? null : r.email,
    inWorkspace: role !== null,
    approvable: role !== null || mayInvite,
  }));
}

/** How many requests wait on the page. Only for those who may see them (full access). */
export async function countAccessRequests(pageId: string) {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(accessRequest)
    .where(and(eq(accessRequest.pageId, pageId), stillWanted));
  return row?.n ?? 0;
}

/**
 * A request `actorId` may answer (full access to its page); AccessError for any other id. With the
 * language of the answer to the requester: theirs, else the one they asked in.
 */
async function answerable(actorId: string, requestId: string) {
  const [request] = await db
    .select({
      id: accessRequest.id,
      pageId: accessRequest.pageId,
      workspaceId: accessRequest.workspaceId,
      requesterId: accessRequest.requesterId,
      level: accessRequest.level,
      locale: accessRequest.locale,
      email: user.email,
    })
    .from(accessRequest)
    .innerJoin(user, eq(user.id, accessRequest.requesterId))
    .where(eq(accessRequest.id, requestId))
    .limit(1);
  if (!request) throw new AccessError();
  const target = await requirePageAccess(actorId, request.pageId, "full");
  return { request, target, locale: await recipientLocale(request.requesterId, request.locale) };
}

async function forget(workspaceId: string, requestId: string) {
  // Its notifications go with it (foreign key), so every approver's inbox updates.
  await db.delete(accessRequest).where(eq(accessRequest.id, requestId));
  signalInbox(workspaceId);
}

const pageLink = (workspaceId: string, pageId: string) => `${env.appUrl}/w/${workspaceId}/p/${pageId}`;

/**
 * Gives the requester `level` on the page: their own entry when they are in the workspace, else
 * they join as a guest (refused with PermissionError "invitesRestricted" when `actorId` may not
 * invite guests; the request then stays). `level` may differ from the one asked for, but must be
 * more than they have (AccessRequestError otherwise: sharing less would take access away). Emails
 * them the answer, in their own language, instead of the usual share email.
 */
export async function approveAccessRequest(actorId: string, requestId: string, level: ApprovalLevel) {
  const { request, target, locale } = await answerable(actorId, requestId);
  const { level: current } = await pageAccessOf(request.requesterId, request.pageId);
  if (!isAbove(level, current)) throw new AccessRequestError("They already have that much access");
  if (await findMembership(request.requesterId, request.workspaceId)) {
    await setPagePermission(actorId, request.pageId, request.requesterId, level);
  } else {
    await sharePageByEmail(actorId, request.pageId, request.email, level);
  }
  await forget(request.workspaceId, request.id);
  // After the sharing (recorded on its own as a permission change) and the request are done.
  await recordAudit({
    workspaceId: request.workspaceId,
    actorId,
    action: "access_request.approved",
    target: { type: "page", id: request.pageId },
    subject: { type: "user", id: request.requesterId },
    details: { level, requested: request.level },
  });
  await skipShareEmail(request.requesterId, request.pageId);
  const [[actor], [space]] = await Promise.all([
    db.select({ name: user.name }).from(user).where(eq(user.id, actorId)),
    db.select({ name: workspace.name }).from(workspace).where(eq(workspace.id, request.workspaceId)),
  ]);
  const content = accessApprovedEmail(locale, {
    actorName: actor?.name ?? "",
    pageTitle: pageLabel(target.title, emailTranslator(locale)("share.untitled")),
    workspaceName: space?.name ?? "",
    level,
    link: pageLink(request.workspaceId, request.pageId),
  });
  mailNow({ to: request.email, ...content });
  return { workspaceId: request.workspaceId, pageId: request.pageId };
}

/**
 * Drops the request and tells the requester, without naming the page, its workspace or who
 * declined; only someone who can open the page (they asked for more) hears its title.
 */
export async function declineAccessRequest(actorId: string, requestId: string) {
  const { request, target, locale } = await answerable(actorId, requestId);
  await forget(request.workspaceId, request.id);
  await recordAudit({
    workspaceId: request.workspaceId,
    actorId,
    action: "access_request.declined",
    target: { type: "page", id: request.pageId },
    subject: { type: "user", id: request.requesterId },
    details: { requested: request.level },
  });

  const link = pageLink(request.workspaceId, request.pageId);
  // Someone asking for more can open the page: they may learn its title.
  const more =
    request.level !== "view" && (await pageAccessOf(request.requesterId, request.pageId)).level !== "none"
      ? { level: request.level, pageTitle: pageLabel(target.title, emailTranslator(locale)("share.untitled")) }
      : undefined;
  mailNow({ to: request.email, ...accessDeclinedEmail(locale, { link, more }) });
  return { workspaceId: request.workspaceId, pageId: request.pageId };
}

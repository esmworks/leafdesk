import { and, asc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import {
  DEFAULT_WORKSPACE_SETTINGS,
  ssoProvider,
  user,
  workspace,
  workspaceInvitation,
  workspaceJoinRequest,
  workspaceMember,
  workspaceSso,
  type JoinRequestKind,
  type JoinRequestSource,
  type JoinRequestStatus,
  type WorkspaceRole,
  type WorkspaceSettings,
} from "@/db/schema";
import { normalizeEmail } from "@/lib/emails";
import { env } from "@/lib/env";
import { type Access, automaticAccess, domainAccess, onAllowedDomain } from "@/lib/membership-policy";
import { sharedLimiter, takeAll } from "@/lib/rate-limit";
import { domainsFromColumn, emailDomain } from "@/lib/sso-config";
import { AccessError, findMembership, requireMembership } from "@/server/access";
import { recordAudit } from "@/server/audit";
import { joinRequestDecidedEmail, mailStatus, sendMail, type OutgoingMail } from "@/server/mail";
import { recipientLocale, requestLocale } from "@/server/mail/locale";
import { recordJoinRequest, withdrawJoinRequest } from "@/server/notifications";
import {
  type AddMemberResult,
  addMemberAs,
  claimPageInvitations,
  joinAsMember,
  type Tx,
  WorkspaceError,
} from "@/server/workspaces";
import { refuseInLocalMode } from "@/server/local-mode";

/**
 * Join requests (issue #56): people asking to be let into a workspace, and members asking to invite
 * someone while the workspace wants that approved. Owners see them in Settings > Members >
 * Requests and in their inbox, and approve or decline; the one who asked hears back by email when
 * the server sends email. The rules for who may do what are in lib/membership-policy.ts.
 *
 * Allowed email domains also act on their own: signing up, signing in or verifying an address on
 * one of them joins the workspace or asks to (`applyDomainPolicies`, from lib/auth.ts), once per
 * person and workspace. Only verified addresses count there. Email and password accounts are
 * verified through the link Better Auth emails, which needs SMTP (see lib/auth.ts); without it only
 * accounts whose provider vouches for the address (Google, GitHub, single sign-on, SCIM) are.
 * A domain does nothing, there or in the workspace switcher, until the workspace has proven it by
 * DNS (server/allowed-domains.ts).
 */

/** Explicit requests a person may send (to any workspace), and invitations a member may ask for. */
const REQUEST_LIMIT = [10, 60 * 60_000] as const;
const INVITE_REQUEST_LIMIT = [100, 60 * 60_000] as const;

type Reader = Pick<typeof db, "select">;

/** The person's join request for the workspace (pending, or how it was decided), or null. */
export async function joinRecordOf(reader: Reader, workspaceId: string, userId: string): Promise<JoinRequestStatus | null> {
  const [row] = await reader
    .select({ status: workspaceJoinRequest.status })
    .from(workspaceJoinRequest)
    .where(
      and(
        eq(workspaceJoinRequest.workspaceId, workspaceId),
        eq(workspaceJoinRequest.kind, "join"),
        eq(workspaceJoinRequest.userId, userId),
      ),
    )
    .limit(1);
  return row?.status ?? null;
}

const joinTarget = {
  target: [workspaceJoinRequest.workspaceId, workspaceJoinRequest.userId],
  targetWhere: sql`${workspaceJoinRequest.kind} = 'join'`,
};

/**
 * Inside the transaction that takes someone out of the workspace: leaves the record that they were
 * in (`accepted`, when they left) or that an owner or their identity provider turned them out
 * (`declined`), so an allowed domain doesn't bring them straight back.
 */
export async function rememberDeparture(tx: Tx, workspaceId: string, userId: string, status: "accepted" | "declined", decidedBy: string | null) {
  const [account] = await tx.select({ email: user.email }).from(user).where(eq(user.id, userId));
  if (!account) return;
  await tx
    .insert(workspaceJoinRequest)
    .values({
      workspaceId,
      kind: "join",
      userId,
      email: normalizeEmail(account.email),
      requestedBy: userId,
      status,
      decidedBy,
      decidedAt: new Date(),
    })
    .onConflictDoUpdate({ ...joinTarget, set: { status, decidedBy, decidedAt: new Date() } });
}

/**
 * Someone joined by another way (an invitation, the join link, an owner adding them, single
 * sign-on) while their request waited: it counts as accepted, and leaves the owners' inboxes.
 */
export async function settleJoinRequest(workspaceId: string, userId: string) {
  const settled = await db
    .update(workspaceJoinRequest)
    .set({ status: "accepted", decidedAt: new Date() })
    .where(
      and(
        eq(workspaceJoinRequest.workspaceId, workspaceId),
        eq(workspaceJoinRequest.kind, "join"),
        eq(workspaceJoinRequest.userId, userId),
        eq(workspaceJoinRequest.status, "pending"),
      ),
    )
    .returning({ id: workspaceJoinRequest.id });
  for (const { id } of settled) await withdrawJoinRequest(workspaceId, id);
}

function limitRequests(name: string, [count, windowMs]: readonly [number, number], key: string) {
  if (takeAll([[sharedLimiter(name, count, windowMs), key]]) > 0) {
    throw new WorkspaceError("tooManyRequests", "Too many requests; try again later.");
  }
}

/**
 * Files a request from `userId` to join, or renews a decided one; an owner hears about it. A
 * request that already waits stays as it is: one pending request per person and workspace.
 */
async function fileJoinRequest(workspaceId: string, userId: string, email: string, source: JoinRequestSource) {
  const locale = await requestLocale();
  const [row] = await db
    .insert(workspaceJoinRequest)
    .values({ workspaceId, kind: "join", userId, email: normalizeEmail(email), requestedBy: userId, source, status: "pending", locale })
    .onConflictDoUpdate({
      ...joinTarget,
      set: { status: "pending", email: normalizeEmail(email), source, locale, createdAt: new Date(), decidedBy: null, decidedAt: null },
      setWhere: sql`${workspaceJoinRequest.status} <> 'pending'`,
    })
    .returning({ id: workspaceJoinRequest.id });
  if (!row) return "pending" as const;
  await recordJoinRequest(workspaceId, row.id, userId, locale);
  return "requested" as const;
}

/** A request the person asked for themselves (the join link, the switcher): rate limited per person. */
export async function requestToJoinFrom(workspaceId: string, userId: string, email: string, source: JoinRequestSource) {
  refuseInLocalMode();
  if ((await joinRecordOf(db, workspaceId, userId)) === "pending") return "pending" as const;
  limitRequests("join-request", REQUEST_LIMIT, userId);
  return fileJoinRequest(workspaceId, userId, email, source);
}

/**
 * A member asks to invite `email` while the workspace wants members' invitations approved. One
 * request per address and workspace: asking again (or another member asking) changes nothing.
 */
export async function requestInvitation(actorId: string, workspaceId: string, email: string, role: WorkspaceRole) {
  refuseInLocalMode();
  limitRequests("invite-request", INVITE_REQUEST_LIMIT, actorId);
  const locale = await requestLocale();
  const [row] = await db
    .insert(workspaceJoinRequest)
    .values({ workspaceId, kind: "invite", email: normalizeEmail(email), role, requestedBy: actorId, source: "member", locale })
    .onConflictDoNothing({
      target: [workspaceJoinRequest.workspaceId, workspaceJoinRequest.email],
      where: sql`${workspaceJoinRequest.kind} = 'invite'`,
    })
    .returning({ id: workspaceJoinRequest.id });
  if (!row) return "pending" as const;
  await recordJoinRequest(workspaceId, row.id, actorId, locale);
  return "requested" as const;
}

type Account = { id: string; email: string; emailVerified: boolean };

async function accountOf(userId: string): Promise<Account | null> {
  const [row] = await db
    .select({ id: user.id, email: user.email, emailVerified: user.emailVerified })
    .from(user)
    .where(eq(user.id, userId));
  return row ?? null;
}

type DomainWorkspace = {
  id: string;
  name: string;
  icon: string | null;
  /** With the domains its single sign-on connection verified, which count as proven allowed domains. */
  settings: WorkspaceSettings & { ssoDomains: string[] };
  record: JoinRequestStatus | null;
};

/**
 * Workspaces that allow the domain of `email` (or a parent domain of it), having proven that
 * domain (see server/allowed-domains.ts), and that `userId` isn't in, with their join request
 * there. Only `workspaceId` when given.
 */
async function domainWorkspaces(account: Account, workspaceId?: string): Promise<DomainWorkspace[]> {
  const domain = emailDomain(account.email);
  if (!domain) return [];
  // a@eu.example.com matches workspaces allowing eu.example.com or example.com (not "com").
  const labels = domain.split(".");
  const candidates = labels.slice(0, -1).map((_, i) => labels.slice(i).join("."));
  const rows = await db
    .select({
      id: workspace.id,
      name: workspace.name,
      icon: workspace.icon,
      settings: workspace.settings,
      record: workspaceJoinRequest.status,
      ssoDomains: ssoProvider.domain,
    })
    .from(workspace)
    .leftJoin(
      workspaceJoinRequest,
      and(
        eq(workspaceJoinRequest.workspaceId, workspace.id),
        eq(workspaceJoinRequest.kind, "join"),
        eq(workspaceJoinRequest.userId, account.id),
      ),
    )
    .leftJoin(workspaceSso, eq(workspaceSso.workspaceId, workspace.id))
    .leftJoin(ssoProvider, and(eq(ssoProvider.providerId, workspaceSso.providerId), eq(ssoProvider.domainVerified, true)))
    .where(
      and(
        workspaceId ? eq(workspace.id, workspaceId) : undefined,
        sql`${workspace.settings}->'allowedDomains' ?| array[${sql.join(
          candidates.map((c) => sql`${c}`),
          sql`, `,
        )}]::text[]`,
        sql`not exists (select 1 from ${workspaceMember} wm where wm.workspace_id = ${workspace.id} and wm.user_id = ${account.id})`,
      ),
    )
    .orderBy(asc(workspace.name));
  return rows
    .map(({ ssoDomains, ...r }) => ({
      ...r,
      settings: { ...DEFAULT_WORKSPACE_SETTINGS, ...r.settings, ssoDomains: domainsFromColumn(ssoDomains) },
    }))
    .filter((r) => onAllowedDomain(account.email, r.settings));
}

/** Joins through an allowed domain: a member, their record accepted. Returns whether they were added. */
async function joinThroughDomain(workspaceId: string, account: Account) {
  const joined = await joinAsMember(workspaceId, account.id, account.email, "domain");
  await db
    .insert(workspaceJoinRequest)
    .values({
      workspaceId,
      kind: "join",
      userId: account.id,
      email: normalizeEmail(account.email),
      requestedBy: account.id,
      source: "domain",
      status: "accepted",
      decidedAt: new Date(),
    })
    .onConflictDoUpdate({ ...joinTarget, set: { status: "accepted", decidedAt: new Date() } });
  return joined;
}

/**
 * What signing up, signing in or verifying an address does (lib/auth.ts): for each workspace that
 * allows the verified address's domain and hasn't dealt with the person yet, join it or ask to, as
 * its domain rule says. Returns the workspaces joined. Unverified addresses do nothing.
 */
export async function applyDomainPolicies(userId: string): Promise<string[]> {
  if (env.localMode) return [];
  const account = await accountOf(userId);
  if (!account?.emailVerified) return [];
  const joined: string[] = [];
  for (const ws of await domainWorkspaces(account)) {
    const access = automaticAccess(ws.settings, { email: account.email, emailVerified: true, record: ws.record });
    if (access === "join" && (await joinThroughDomain(ws.id, account))) joined.push(ws.id);
    if (access === "request") await fileJoinRequest(ws.id, account.id, account.email, "domain");
  }
  return joined;
}

export type JoinableWorkspace = { id: string; name: string; icon: string | null; access: Exclude<Access, null> };

/** The workspaces the user's email domain lets them join or ask to join, for the workspace switcher. */
export async function joinableWorkspaces(userId: string): Promise<JoinableWorkspace[]> {
  if (env.localMode) return [];
  const account = await accountOf(userId);
  if (!account) return [];
  return (await domainWorkspaces(account)).flatMap((ws) => {
    const access = domainAccess(ws.settings, { email: account.email, emailVerified: account.emailVerified, record: ws.record });
    return access ? [{ id: ws.id, name: ws.name, icon: ws.icon, access }] : [];
  });
}

/**
 * "Join" or "Request to join" in the workspace switcher: does what joinableWorkspaces offered.
 * Refuses (AccessError) what it didn't offer, without saying whether the workspace exists.
 */
export async function joinFromSwitcher(userId: string, workspaceId: string): Promise<"joined" | "requested" | "pending"> {
  refuseInLocalMode();
  const account = await accountOf(userId);
  if (!account) throw new AccessError();
  if (await findMembership(userId, workspaceId)) return "joined";
  const [ws] = await domainWorkspaces(account, workspaceId);
  if (!ws) throw new AccessError();
  const access = domainAccess(ws.settings, { email: account.email, emailVerified: account.emailVerified, record: ws.record });
  if (access === "join") {
    await joinThroughDomain(workspaceId, account);
    return "joined";
  }
  if (access === "pending") return "pending";
  if (access === "request") return requestToJoinFrom(workspaceId, userId, account.email, "switcher");
  throw new AccessError();
}

export type JoinRequestItem = {
  id: string;
  kind: JoinRequestKind;
  /** `join`: the requester's address; `invite`: who the member wants to invite. */
  email: string;
  role: WorkspaceRole;
  source: JoinRequestSource | null;
  createdAt: Date;
  /** Who asked: the requester, or the member. */
  askerName: string | null;
  askerEmail: string | null;
  askerImage: string | null;
};

const asker = alias(user, "asker");

/** The requests waiting for an owner, oldest first. Owners only. */
export async function listJoinRequests(actorId: string, workspaceId: string): Promise<JoinRequestItem[]> {
  await requireMembership(actorId, workspaceId, "owner");
  return db
    .select({
      id: workspaceJoinRequest.id,
      kind: workspaceJoinRequest.kind,
      email: workspaceJoinRequest.email,
      role: workspaceJoinRequest.role,
      source: workspaceJoinRequest.source,
      createdAt: workspaceJoinRequest.createdAt,
      askerName: asker.name,
      askerEmail: asker.email,
      askerImage: asker.image,
    })
    .from(workspaceJoinRequest)
    .leftJoin(asker, eq(asker.id, workspaceJoinRequest.requestedBy))
    .where(and(eq(workspaceJoinRequest.workspaceId, workspaceId), eq(workspaceJoinRequest.status, "pending")))
    .orderBy(asc(workspaceJoinRequest.createdAt));
}

type Decided = {
  id: string;
  kind: JoinRequestKind;
  userId: string | null;
  email: string;
  role: WorkspaceRole;
  requestedBy: string | null;
  locale: string | null;
};

/** Takes a waiting request off the list (locked, so two owners can't both decide it). */
async function takePending(tx: Tx, workspaceId: string, requestId: string): Promise<Decided> {
  const [request] = await tx
    .select({
      id: workspaceJoinRequest.id,
      kind: workspaceJoinRequest.kind,
      userId: workspaceJoinRequest.userId,
      email: workspaceJoinRequest.email,
      role: workspaceJoinRequest.role,
      requestedBy: workspaceJoinRequest.requestedBy,
      locale: workspaceJoinRequest.locale,
    })
    .from(workspaceJoinRequest)
    .where(
      and(
        eq(workspaceJoinRequest.id, requestId),
        eq(workspaceJoinRequest.workspaceId, workspaceId),
        eq(workspaceJoinRequest.status, "pending"),
      ),
    )
    .for("update");
  if (!request) throw new WorkspaceError("requestHandled", "This request was already handled.");
  return request;
}

/**
 * Lets the request in. Someone asking to join becomes a member; a member's request to invite
 * someone goes out as that member's invitation (added right away when an account has the address,
 * verified, see addMemberAs), which is returned so the owner can share its link. Owners only.
 */
export async function approveJoinRequest(actorId: string, workspaceId: string, requestId: string) {
  refuseInLocalMode();
  await requireMembership(actorId, workspaceId, "owner");
  let result: AddMemberResult | null = null;
  const request = await db.transaction(async (tx) => {
    const request = await takePending(tx, workspaceId, requestId);
    await recordAudit({ workspaceId, actorId, ...decisionEvent(request, "join_request.approved") }, tx);
    if (request.kind === "invite") {
      // The invitation (or the addition) that follows is recorded on its own, by addMemberAs.
      await tx.delete(workspaceJoinRequest).where(eq(workspaceJoinRequest.id, request.id));
      return request;
    }
    await tx
      .update(workspaceJoinRequest)
      .set({ status: "accepted", decidedBy: actorId, decidedAt: new Date() })
      .where(eq(workspaceJoinRequest.id, request.id));
    const [account] = await tx
      .select({ email: user.email, emailVerified: user.emailVerified })
      .from(user)
      .where(eq(user.id, request.userId!));
    const email = normalizeEmail(account?.email ?? request.email);
    const added = await tx
      .insert(workspaceMember)
      .values({ workspaceId, userId: request.userId!, role: "member", invitedBy: actorId })
      .onConflictDoNothing()
      .returning({ userId: workspaceMember.userId });
    // As with the join link: invitations by email (to the workspace, or to its pages) are only
    // taken up for a verified address, so someone using another person's address gets none of them.
    if (account?.emailVerified) {
      await tx
        .delete(workspaceInvitation)
        .where(and(eq(workspaceInvitation.workspaceId, workspaceId), eq(workspaceInvitation.email, email)));
      await claimPageInvitations(tx, workspaceId, request.userId!, email);
    }
    if (added.length) {
      await recordAudit(
        {
          workspaceId,
          actorId,
          action: "member.added",
          target: { type: "user", id: request.userId! },
          details: { role: "member", via: "join_request" },
        },
        tx,
      );
    }
    return request;
  });
  if (request.kind === "invite") {
    // The invitation names the member who asked, while they are still in the workspace.
    const inviter = request.requestedBy && (await findMembership(request.requestedBy, workspaceId)) ? request.requestedBy : actorId;
    try {
      result = await addMemberAs(inviter, workspaceId, request.email, request.role);
    } catch (error) {
      // They joined some other way meanwhile: nothing left to do.
      if (!(error instanceof WorkspaceError && error.code === "alreadyMember")) throw error;
      result = { kind: "added" };
    }
  }
  await withdrawJoinRequest(workspaceId, request.id);
  await emailDecision(workspaceId, request, true);
  return result;
}

/** Turns the request down; someone asking to join may ask again later (see domainAccess). Owners only. */
export async function declineJoinRequest(actorId: string, workspaceId: string, requestId: string) {
  refuseInLocalMode();
  await requireMembership(actorId, workspaceId, "owner");
  const request = await db.transaction(async (tx) => {
    const request = await takePending(tx, workspaceId, requestId);
    await recordAudit({ workspaceId, actorId, ...decisionEvent(request, "join_request.declined") }, tx);
    if (request.kind === "invite") {
      await tx.delete(workspaceJoinRequest).where(eq(workspaceJoinRequest.id, request.id));
    } else {
      await tx
        .update(workspaceJoinRequest)
        .set({ status: "declined", decidedBy: actorId, decidedAt: new Date() })
        .where(eq(workspaceJoinRequest.id, request.id));
    }
    return request;
  });
  await withdrawJoinRequest(workspaceId, request.id);
  await emailDecision(workspaceId, request, false);
}

/**
 * The audit event of an owner's decision: about the person who asked to join, or the address a
 * member asked to invite.
 */
function decisionEvent(request: Decided, action: "join_request.approved" | "join_request.declined") {
  return {
    action,
    target:
      request.kind === "join"
        ? { type: "user" as const, id: request.userId }
        : { type: "email" as const, id: request.email, label: request.email },
    details: { kind: request.kind, role: request.role },
  };
}

let mailer: (mail: OutgoingMail) => Promise<void> = sendMail;

/** Scripts and tests: capture decision emails instead of sending them (null restores sending). */
export function setJoinRequestMailer(send: ((mail: OutgoingMail) => Promise<void>) | null) {
  mailer = send ?? sendMail;
}

/**
 * Tells whoever asked how the owner decided, in their language, else the one they used when asking.
 * Never throws: the decision stands either way.
 */
async function emailDecision(workspaceId: string, request: Decided, approved: boolean) {
  if (mailStatus() === "disabled" || !request.requestedBy) return;
  try {
    const [[recipient], [space]] = await Promise.all([
      db.select({ email: user.email }).from(user).where(eq(user.id, request.requestedBy)),
      db.select({ name: workspace.name }).from(workspace).where(eq(workspace.id, workspaceId)),
    ]);
    if (!recipient) return;
    const locale = await recipientLocale(request.requestedBy, request.locale);
    const link = request.kind === "join" ? `${env.appUrl}/w/${workspaceId}` : `${env.appUrl}/w/${workspaceId}/settings?tab=members`;
    const content = joinRequestDecidedEmail(locale, {
      kind: request.kind,
      approved,
      email: request.email,
      workspaceName: space?.name ?? "",
      link,
    });
    await mailer({ to: recipient.email, ...content });
  } catch (error) {
    console.error("could not send join request decision email", error);
  }
}

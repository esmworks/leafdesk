import { randomBytes } from "node:crypto";
import { and, asc, eq, gt, inArray, isNotNull, max, ne, or, sql } from "drizzle-orm";
import { getLocale, getTranslations } from "next-intl/server";
import { db } from "@/db";
import {
  account,
  agentConversation,
  aiAccount,
  aiConversation,
  aiMemory,
  apiToken,
  calendarFeed,
  databaseView,
  DEFAULT_WORKSPACE_SETTINGS,
  file,
  mailbox,
  notification,
  page,
  pageInvitation,
  passkey,
  pageChunk,
  pageGroupPermission,
  pageIndexState,
  pagePermission,
  propertyPermission,
  sensitiveFinding,
  sensitiveScan,
  session,
  ssoProvider,
  user,
  workspace,
  workspaceAgent,
  workspaceInvitation,
  workspaceMember,
  workspaceSso,
  type WorkspaceRole,
  type WorkspaceSettings,
} from "@/db/schema";
import { isLocale, type Locale } from "@/i18n/config";
import { type DeletionPlan, planAccountDeletion, type WorkspaceStanding } from "@/lib/account";
import { isAgentEmail } from "@/lib/agents";
import { isReservedEmail } from "@/lib/reserved-emails";
import { isEmail, MAX_BULK_EMAILS, normalizeEmail } from "@/lib/emails";
import { assignableRoles, invitationApplies, linkAccess, memberInviteMode, verifiedAllowedDomains } from "@/lib/membership-policy";
import { managesPeople, mayChangeRole, mayRemove } from "@/lib/workspace-roles";
import { TRASH_RETENTION_CHOICES } from "@/lib/retention";
import { parseDomains } from "@/lib/sso-config";
import { parseCalloutStyles } from "@/lib/callout-styles";
import { parseAiMonthlyLimit } from "@/lib/ai-usage";
import { cleanSidebarLayout, type SidebarLayout } from "@/lib/sidebar-sections";
import { env } from "@/lib/env";
import { canCreateWorkspace } from "@/lib/instance-admin";
import { invitationEmail, mailStatus, sendMail } from "@/server/mail";
import {
  AccessError,
  findMembership,
  FULL_RANK,
  getMembership,
  isGuest,
  requireMember,
  requireMembership,
  requirePeopleManager,
  workspacesHiddenFromApp,
} from "@/server/access";
import { isAgentUser, notAgentUser } from "@/server/agents/users";
import { ssoVerifiedDomains } from "@/server/allowed-domains";
import { changedValues, recordAudit } from "@/server/audit";
import { firstAdminId } from "@/server/first-admin";
import type { QueuedObject } from "@/server/files";
import { joinRecordOf, rememberDeparture, requestInvitation, requestToJoinFrom, settleJoinRequest } from "@/server/join-requests";
import { workspacesHolding, workspacesWithHolds } from "@/server/legal-hold";
import { turkishGenitive } from "@/lib/turkish";
import { getCollab } from "@/server/collab/bridge";
import { attachDefaultStorage } from "@/server/storage/accounts";
import { StorageSettingsError } from "@/server/storage/errors";
import { kickMoves, planMovesAway } from "@/server/storage/moves";
import { CONNECTED_APPS_MODES } from "@/server/connected-app";
import { dropFromGroups } from "@/server/groups";
import { dropFromTeamspaces, setUpGeneralTeamspace } from "@/server/teamspaces";
import { refuseInLocalMode } from "@/server/local-mode";

/** "Erhan's workspace" / "Erhan'ın çalışma alanı", in the language of the sign-up request. */
async function personalWorkspaceName(userName: string) {
  const firstName = userName.trim().split(/\s+/)[0] || "My";
  try {
    const [locale, t] = await Promise.all([getLocale(), getTranslations("home")]);
    return t("personalWorkspace", { name: locale === "tr" ? turkishGenitive(firstName) : firstName });
  } catch {
    // Outside a request (scripts, tests) there is no locale to read.
    return `${firstName}'s workspace`;
  }
}

/** "General" / "Genel": the teamspace every new workspace starts with, in the creator's language. */
async function generalTeamspaceName() {
  try {
    return (await getTranslations("home"))("generalTeamspace");
  } catch {
    return "General";
  }
}

/**
 * Every account's own workspace, made at sign-up (and on the home page for someone who left all
 * of theirs). WORKSPACE_CREATION doesn't apply: everyone needs somewhere to land.
 */
export async function createPersonalWorkspace(userId: string, userName: string) {
  const [name, general] = await Promise.all([personalWorkspaceName(userName), generalTeamspaceName()]);
  const created = await db.transaction(async (tx) => {
    const [ws] = await tx
      .insert(workspace)
      .values({ name })
      .returning({ id: workspace.id });
    await tx.insert(workspaceMember).values({ workspaceId: ws.id, userId, role: "owner" });
    await setUpGeneralTeamspace(tx, ws.id, userId, general);
    return ws;
  });
  await attachDefaultStorage(userId, created.id);
}

export type WorkspaceErrorCode =
  | "nameRequired"
  | "twoFactorFirst"
  | "ssoFirst"
  | "alreadyMember"
  | "notMember"
  | "lastOwner"
  | "lastOwnerRemove"
  | "invitationInvalid"
  | "invitationEmailMismatch"
  | "emailRequired"
  | "invalidEmail"
  | "tooManyEmails"
  | "joinLinkInvalid"
  | "transferToSelf"
  | "transferToGuest"
  | "invalidSetting"
  | "invalidDomain"
  /** A callout style that doesn't pass parseCalloutStyles (lib/callout-styles); the detail says what. */
  | "invalidCalloutStyle"
  | "requestHandled"
  | "tooManyRequests"
  | "creationRestricted"
  /** Deleting the workspace: the name typed to confirm it isn't the workspace's. */
  | "confirmationMismatch"
  /** Deleting the workspace: someone else deleted it meanwhile. */
  | "workspaceDeleted"
  /** The person is an agent's user: agents are changed in their own settings. */
  | "agentUser"
  /** Leaving: the person's storage holds the workspace's files and there is nowhere they may move to. */
  | "storageNoDestination"
  /** Leaving: the workspace's files are being moved into the person's storage right now. */
  | "storageMoveInProgress"
  /** Approved networks: an entry that isn't an address or range; the detail is its text. */
  | "invalidNetwork"
  /** Approved networks: a label longer than MAX_NETWORK_LABEL; the detail is its entry. */
  | "invalidNetworkLabel"
  /** Approved networks: more than MAX_ALLOWED_NETWORKS. */
  | "tooManyNetworks"
  /** Approved networks: the list leaves out the saving owner's own address (the detail; empty when unknown). */
  | "ipLocksYouOut";

/**
 * An expected failure the user can act on. `code` is stable and translated by the UI; the
 * English `message` is for logs. `detail` fills the translation's `{detail}` (the domain that
 * can't be allowed, …).
 */
export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;
  readonly detail: string;

  constructor(code: WorkspaceErrorCode, message: string, detail = "") {
    super(message);
    this.name = "WorkspaceError";
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Whether this account may create workspaces beyond its personal one (WORKSPACE_CREATION, see
 * lib/instance-admin.ts). Looked up by id, so every caller gets the same answer.
 */
export async function mayCreateWorkspace(userId: string) {
  if (env.workspaceCreation === "everyone") return true;
  const [[row], firstAdmin] = await Promise.all([
    db.select({ id: user.id, email: user.email, emailVerified: user.emailVerified }).from(user).where(eq(user.id, userId)).limit(1),
    firstAdminId(),
  ]);
  return canCreateWorkspace(row, env.workspaceCreation, undefined, firstAdmin);
}

export async function createWorkspace(userId: string, name: string) {
  if (!(await mayCreateWorkspace(userId))) {
    throw new WorkspaceError("creationRestricted", "Only the server's administrators can create workspaces.");
  }
  const clean = name.trim().slice(0, 80);
  if (!clean) throw new WorkspaceError("nameRequired", "Give the workspace a name.");
  const general = await generalTeamspaceName();
  const created = await db.transaction(async (tx) => {
    // Someone with a default AI account of their own (OWN_AI_KEYS_ENABLED) runs the new workspace's AI on it.
    const [own] = env.ownAiKeysEnabled
      ? await tx.select({ id: aiAccount.id }).from(aiAccount).where(and(eq(aiAccount.userId, userId), eq(aiAccount.isDefault, true))).limit(1)
      : [];
    const [ws] = await tx
      .insert(workspace)
      .values({ name: clean, aiAccountId: own?.id ?? null })
      .returning({ id: workspace.id });
    await tx.insert(workspaceMember).values({ workspaceId: ws.id, userId, role: "owner" });
    await setUpGeneralTeamspace(tx, ws.id, userId, general);
    return ws;
  });
  // Someone with a default storage account keeps the new workspace's files there from the start.
  await attachDefaultStorage(userId, created.id);
  return created;
}

/** How many workspaces each of these accounts is in, as a guest too (the instance admin's list). */
export async function workspaceCounts(userIds: string[]): Promise<Map<string, number>> {
  if (!userIds.length) return new Map();
  const rows = await db
    .select({ userId: workspaceMember.userId, count: sql<number>`count(*)::int` })
    .from(workspaceMember)
    .where(inArray(workspaceMember.userId, userIds))
    .groupBy(workspaceMember.userId);
  return new Map(rows.map((r) => [r.userId, r.count]));
}

/** The user's workspaces with their role, oldest first. */
/** The user's workspaces, oldest first; for a connected app, without those hidden from it. */
export async function listWorkspaces(userId: string) {
  const [rows, hidden] = await Promise.all([
    db
      .select({ id: workspace.id, name: workspace.name, icon: workspace.icon, role: workspaceMember.role })
      .from(workspace)
      .innerJoin(workspaceMember, eq(workspaceMember.workspaceId, workspace.id))
      .where(eq(workspaceMember.userId, userId))
      .orderBy(asc(workspace.createdAt)),
    workspacesHiddenFromApp(userId),
  ]);
  return hidden.size ? rows.filter((w) => !hidden.has(w.id)) : rows;
}

export async function getWorkspace(userId: string, workspaceId: string) {
  const { role } = await requireMembership(userId, workspaceId);
  const [ws] = await db
    .select({ id: workspace.id, name: workspace.name, icon: workspace.icon })
    .from(workspace)
    .where(eq(workspace.id, workspaceId))
    .limit(1);
  return { ...ws, role };
}

export async function renameWorkspace(userId: string, workspaceId: string, name: string) {
  await requireMembership(userId, workspaceId, "owner");
  const clean = name.trim().slice(0, 80);
  if (!clean) throw new WorkspaceError("nameRequired", "Give the workspace a name.");
  await db.transaction(async (tx) => {
    const [before] = await tx.select({ name: workspace.name }).from(workspace).where(eq(workspace.id, workspaceId)).for("update");
    await tx.update(workspace).set({ name: clean }).where(eq(workspace.id, workspaceId));
    if (before && before.name !== clean) {
      await recordAudit(
        {
          workspaceId,
          actorId: userId,
          action: "workspace.renamed",
          target: { type: "workspace", id: workspaceId, label: clean },
          details: { from: before.name, to: clean },
        },
        tx,
      );
    }
  });
}

/**
 * Everyone in the workspace, guests included, but not its agents' users. Guests themselves can't
 * list it.
 */
export async function listMembers(userId: string, workspaceId: string) {
  await requireMember(userId, workspaceId);
  return db
    .select({
      userId: user.id,
      name: user.name,
      email: user.email,
      image: user.image,
      role: workspaceMember.role,
      joinedAt: workspaceMember.createdAt,
    })
    .from(workspaceMember)
    .innerJoin(user, eq(user.id, workspaceMember.userId))
    .where(and(eq(workspaceMember.workspaceId, workspaceId), notAgentUser(workspaceMember.userId)))
    .orderBy(asc(workspaceMember.createdAt));
}

export type WorkspacePerson = { id: string; name: string; email: string; image: string | null; role: WorkspaceRole };

/**
 * Everyone in a workspace, guests included, for person properties, mentions and the like. Agents'
 * users aren't people: they are left out. No access check: callers decide what the user may see of
 * it (guests only get the people already assigned).
 */
export async function workspacePeople(workspaceId: string): Promise<WorkspacePerson[]> {
  return db
    .select({ id: user.id, name: user.name, email: user.email, image: user.image, role: workspaceMember.role })
    .from(workspaceMember)
    .innerJoin(user, eq(user.id, workspaceMember.userId))
    .where(and(eq(workspaceMember.workspaceId, workspaceId), notAgentUser(workspaceMember.userId)));
}

/** How someone can sign in: a password, single sign-on, a passkey, or another provider's account (by its id: "github"). */
export type SignInMethod = "password" | "sso" | "passkey" | (string & {});

export type DomainPerson = {
  userId: string;
  name: string;
  email: string;
  image: string | null;
  emailVerified: boolean;
  /** Their role here, or null for someone not in the workspace. */
  role: WorkspaceRole | null;
  /** When a session of theirs was last used (sessions are renewed once a day while in use); null without one. */
  lastActiveAt: Date | null;
  signIn: SignInMethod[];
};

/** The most people listed at once from the workspace's domains. */
export const DOMAIN_PEOPLE_LIMIT = 500;

/**
 * The workspace's verified email domains: those its single sign-on connection verified, and its
 * allowed domains proven by DNS or by that connection (server/allowed-domains.ts). Subdomains count.
 */
export async function verifiedDomainsOf(workspaceId: string): Promise<string[]> {
  const [settings, ssoDomains] = await Promise.all([workspaceSettings(workspaceId), ssoVerifiedDomains(db, workspaceId)]);
  return [...new Set([...ssoDomains, ...verifiedAllowedDomains({ ...settings, ssoDomains })])].sort();
}

/**
 * Accounts on this server with an address in the workspace's verified domains (see
 * verifiedDomainsOf), in the workspace or not, for Settings > Security: their role here, when they
 * were last active and how they can sign in. Agents aren't people: they are left out. Owners only;
 * none without verified domains.
 */
export async function domainPeople(actorId: string, workspaceId: string): Promise<{ domains: string[]; people: DomainPerson[]; more: boolean }> {
  await requireMembership(actorId, workspaceId, "owner");
  const domains = await verifiedDomainsOf(workspaceId);
  if (!domains.length) return { domains, people: [], more: false };
  const host = sql`split_part(lower(${user.email}), '@', 2)`;
  const rows = await db
    .select({
      userId: user.id,
      name: user.name,
      email: user.email,
      image: user.image,
      emailVerified: user.emailVerified,
      role: workspaceMember.role,
      lastActiveAt: sql<Date | null>`(select max(${session.updatedAt}) from ${session} where ${session.userId} = ${user.id})`.mapWith(session.updatedAt),
      providers: sql<string[]>`array(select distinct case when ${account.providerId} = 'credential' then (case when ${account.password} is not null then 'password' end) when exists (select 1 from ${ssoProvider} where ${ssoProvider.providerId} = ${account.providerId}) then 'sso' else ${account.providerId} end from ${account} where ${account.userId} = ${user.id})`,
      hasPasskey: sql<boolean>`exists (select 1 from ${passkey} where ${passkey.userId} = ${user.id})`,
    })
    .from(user)
    .leftJoin(workspaceMember, and(eq(workspaceMember.userId, user.id), eq(workspaceMember.workspaceId, workspaceId)))
    .where(and(notAgentUser(user.id), or(...domains.map((d) => sql`(${host} = ${d} or right(${host}, ${d.length + 1}) = ${`.${d}`})`))))
    .orderBy(sql`${workspaceMember.role} is null`, asc(user.name), asc(user.email))
    .limit(DOMAIN_PEOPLE_LIMIT + 1);
  const people = rows.slice(0, DOMAIN_PEOPLE_LIMIT).map((r) => ({
    userId: r.userId,
    name: r.name,
    email: r.email,
    image: r.image,
    emailVerified: Boolean(r.emailVerified),
    role: r.role,
    lastActiveAt: r.lastActiveAt,
    signIn: [...(r.providers ?? []).filter((p): p is string => Boolean(p)), ...(r.hasPasskey ? ["passkey"] : [])],
  }));
  return { domains, people, more: rows.length > DOMAIN_PEOPLE_LIMIT };
}

/** When each member last changed a page in this workspace (content, title, properties, trash). */
export async function lastEdits(userId: string, workspaceId: string): Promise<Map<string, Date>> {
  await requireMember(userId, workspaceId);
  const rows = await db
    .select({ userId: page.updatedBy, at: max(page.updatedAt) })
    .from(page)
    .where(and(eq(page.workspaceId, workspaceId), isNotNull(page.updatedBy)))
    .groupBy(page.updatedBy);
  return new Map(rows.flatMap((r) => (r.userId && r.at ? [[r.userId, r.at] as const] : [])));
}

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const newToken = () => randomBytes(32).toString("base64url");
export const invitationLink = (token: string) => `${env.appUrl}/invite/${token}`;
export const joinLink = (token: string) => `${env.appUrl}/join/${token}`;

/**
 * - `sent`: the invitation email went out (or, in development without SMTP, to the log).
 * - `failed`: SMTP is set up but sending failed; the owner has to share the link.
 * - `off`: no email on this server; the owner shares the link.
 */
export type InvitationDelivery = "sent" | "failed" | "off";

export type AddMemberResult =
  | { kind: "added" }
  | { kind: "invited"; email: string; link: string; delivery: InvitationDelivery }
  /** The workspace wants members' invitations approved: an owner decides (see server/join-requests.ts). */
  | { kind: "requested"; email: string };

/** The inviter's interface language; the invitee has none yet. */
async function requestLocale(): Promise<Locale> {
  try {
    const locale = await getLocale();
    return isLocale(locale) ? locale : "en";
  } catch {
    return "en";
  }
}

async function emailInvitation(
  actorId: string,
  workspaceId: string,
  invitation: { email: string; role: WorkspaceRole; link: string },
): Promise<InvitationDelivery> {
  if (mailStatus() === "disabled") return "off";
  try {
    const [[inviter], [ws], locale] = await Promise.all([
      db.select({ name: user.name }).from(user).where(eq(user.id, actorId)).limit(1),
      db.select({ name: workspace.name }).from(workspace).where(eq(workspace.id, workspaceId)).limit(1),
      requestLocale(),
    ]);
    const content = invitationEmail(locale, {
      inviterName: inviter?.name ?? "",
      workspaceName: ws?.name ?? "",
      ...invitation,
    });
    await sendMail({ to: invitation.email, ...content });
    return "sent";
  } catch (error) {
    console.error("could not send invitation email", error);
    return "failed";
  }
}

/**
 * How `actorId` may add members (Settings > Security, "Who can add members"): right away, through a
 * request an owner approves, or not at all (AccessError), and with which roles. Members add members
 * only. Throws for guests and people outside the workspace.
 */
async function memberInviteModeFor(actorId: string, workspaceId: string, role?: WorkspaceRole) {
  const [{ role: actorRole }, settings] = await Promise.all([requireMembership(actorId, workspaceId), workspaceSettings(workspaceId)]);
  const mode = memberInviteMode(actorRole, settings);
  if (mode === "denied" || (role !== undefined && !assignableRoles(actorRole).includes(role))) throw new AccessError();
  return mode;
}

/**
 * Makes an agent's user (see server/agents) a guest of the workspace, in the agent's own
 * transaction: as a guest it sees only the pages shared with it. No access check: createAgent
 * checks that the actor owns the workspace.
 */
export async function addAgentMembership(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  workspaceId: string,
  agentUserId: string,
  invitedBy: string,
) {
  await tx.insert(workspaceMember).values({ workspaceId, userId: agentUserId, role: "guest", invitedBy });
}

/**
 * Adds the account that uses this email, when its address is verified. Otherwise (no account, or
 * one nobody proved the address of) creates (or renews) an invitation and emails its link when the
 * server can send email; the owner can always share the link themselves. While the workspace wants
 * members' invitations approved, a member's addition becomes a request instead.
 */
export async function addMember(
  actorId: string,
  workspaceId: string,
  email: string,
  role: WorkspaceRole,
): Promise<AddMemberResult> {
  const mode = await memberInviteModeFor(actorId, workspaceId, role);
  const clean = normalizeEmail(email);
  if (isReservedEmail(clean)) throw new WorkspaceError("invalidEmail", "Agents can't be added to a workspace.");
  if (mode === "request") {
    const [existing] = await db
      .select({ one: sql<number>`1` })
      .from(workspaceMember)
      .innerJoin(user, eq(user.id, workspaceMember.userId))
      .where(and(eq(workspaceMember.workspaceId, workspaceId), eq(sql`lower(${user.email})`, clean)))
      .limit(1);
    if (existing) throw new WorkspaceError("alreadyMember", "This person is already a member.");
    await requestInvitation(actorId, workspaceId, clean, role);
    return { kind: "requested", email: clean };
  }
  return addMemberAs(actorId, workspaceId, clean, role);
}

/**
 * What adding a member does once allowed: adds the account with this email, or invites it in the
 * name of `actorId`. No access check: addMember, and an owner approving a member's request
 * (server/join-requests.ts, where the invitation names the member who asked), check first.
 *
 * Only an account with a verified address is added. Anyone can sign up with someone else's
 * address, and nobody has to verify it to sign in, so an unverified account is treated as no
 * account: the address gets the invitation, and only its mailbox has the link.
 */
export async function addMemberAs(
  actorId: string,
  workspaceId: string,
  email: string,
  role: WorkspaceRole,
): Promise<Exclude<AddMemberResult, { kind: "requested" }>> {
  refuseInLocalMode();
  const clean = normalizeEmail(email);
  // Agents' users are added only to their own workspace, by creating the agent.
  if (isReservedEmail(clean)) throw new WorkspaceError("invalidEmail", "Agents can't be added to a workspace.");
  const [target] = await db
    .select({ id: user.id, emailVerified: user.emailVerified })
    .from(user)
    .where(and(eq(sql`lower(${user.email})`, clean), notAgentUser(user.id)))
    .limit(1);
  if (!target?.emailVerified) {
    const token = newToken();
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
    await db
      .insert(workspaceInvitation)
      .values({ workspaceId, email: clean, role, token, invitedBy: actorId, expiresAt })
      .onConflictDoUpdate({
        target: [workspaceInvitation.workspaceId, workspaceInvitation.email],
        set: { role, token, invitedBy: actorId, expiresAt, createdAt: new Date() },
      });
    const link = invitationLink(token);
    const delivery = await emailInvitation(actorId, workspaceId, { email: clean, role, link });
    // After the upsert and the email: the invitation stands either way.
    await recordAudit({ workspaceId, actorId, action: "invitation.sent", target: { type: "email", id: clean, label: clean }, details: { role } });
    return { kind: "invited", email: clean, link, delivery };
  }
  const inserted = await db.transaction(async (tx) => {
    const rows = await tx
      .insert(workspaceMember)
      .values({ workspaceId, userId: target.id, role, invitedBy: actorId })
      .onConflictDoNothing()
      .returning({ userId: workspaceMember.userId });
    await tx
      .delete(workspaceInvitation)
      .where(and(eq(workspaceInvitation.workspaceId, workspaceId), eq(workspaceInvitation.email, clean)));
    if (rows.length) {
      await claimPageInvitations(tx, workspaceId, target.id, clean);
      await recordAudit({ workspaceId, actorId, action: "member.added", target: { type: "user", id: target.id }, details: { role } }, tx);
    }
    return rows;
  });
  if (inserted.length) await settleJoinRequest(workspaceId, target.id);
  if (!inserted.length) throw new WorkspaceError("alreadyMember", "This person is already a member.");
  return { kind: "added" };
}

const ROLE_RANK: Record<WorkspaceRole, number> = { guest: 0, member: 1, membership_admin: 2, owner: 3 };

/**
 * Invites someone without an account as a guest, so a page can be shared with them. A pending
 * invitation keeps its link, and its role when that is higher. Needs `canInviteGuests`.
 */
export async function inviteGuest(actorId: string, workspaceId: string, email: string) {
  if (!(await canInviteGuests(actorId, workspaceId))) throw new AccessError();
  const clean = normalizeEmail(email);
  if (isReservedEmail(clean)) throw new WorkspaceError("invalidEmail", "Agents can't be invited.");
  const [existing] = await db
    .select({ token: workspaceInvitation.token, role: workspaceInvitation.role, expiresAt: workspaceInvitation.expiresAt })
    .from(workspaceInvitation)
    .where(and(eq(workspaceInvitation.workspaceId, workspaceId), eq(workspaceInvitation.email, clean)))
    .limit(1);
  const live = existing && existing.expiresAt > new Date() ? existing : null;
  const token = live?.token ?? newToken();
  const role: WorkspaceRole = live && ROLE_RANK[live.role] > ROLE_RANK.guest ? live.role : "guest";
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
  await db
    .insert(workspaceInvitation)
    .values({ workspaceId, email: clean, role, token, invitedBy: actorId, expiresAt })
    .onConflictDoUpdate({
      target: [workspaceInvitation.workspaceId, workspaceInvitation.email],
      set: { role, token, invitedBy: actorId, expiresAt },
    });
  const link = invitationLink(token);
  const delivery = await emailInvitation(actorId, workspaceId, { email: clean, role, link });
  await recordAudit({ workspaceId, actorId, action: "invitation.sent", target: { type: "email", id: clean, label: clean }, details: { role } });
  return { link, delivery };
}

/** Adds an existing account to the workspace as a guest, if they aren't in it yet. Needs `canInviteGuests`. */
export async function addGuest(actorId: string, workspaceId: string, userId: string, email: string) {
  if (!(await canInviteGuests(actorId, workspaceId))) throw new AccessError();
  if (isAgentEmail(email) || (await isAgentUser(userId))) throw new WorkspaceError("agentUser", "Agents can't be added as guests.");
  await db.transaction(async (tx) => {
    const rows = await tx
      .insert(workspaceMember)
      .values({ workspaceId, userId, role: "guest", invitedBy: actorId })
      .onConflictDoNothing()
      .returning({ userId: workspaceMember.userId });
    if (rows.length) {
      await claimPageInvitations(tx, workspaceId, userId, normalizeEmail(email));
      await recordAudit(
        { workspaceId, actorId, action: "member.added", target: { type: "user", id: userId }, details: { role: "guest", via: "share" } },
        tx,
      );
    }
  });
}

/** Turns pages shared with `email` before they had an account into their page permissions. */
export async function claimPageInvitations(
  tx: Pick<typeof db, "execute" | "delete">,
  workspaceId: string,
  userId: string,
  email: string,
) {
  await tx.execute(sql`
    insert into ${pagePermission} (id, page_id, workspace_id, user_id, level, created_by)
    select gen_random_uuid()::text, pi.page_id, pi.workspace_id, ${userId}, pi.level, pi.invited_by
    from ${pageInvitation} pi
    where pi.workspace_id = ${workspaceId} and pi.email = ${email}
    on conflict (page_id, user_id) do nothing
  `);
  await tx
    .delete(pageInvitation)
    .where(and(eq(pageInvitation.workspaceId, workspaceId), eq(pageInvitation.email, email)));
}

export type BulkAddResult =
  | ({ email: string } & AddMemberResult)
  | { email: string; kind: "error"; code: WorkspaceErrorCode };

/**
 * Adds several people at once, reporting each address separately so one bad address doesn't
 * stop the rest. Owners, and members as "Who can add members" allows (see addMember).
 */
export async function addMembers(
  actorId: string,
  workspaceId: string,
  emails: string[],
  role: WorkspaceRole,
): Promise<BulkAddResult[]> {
  refuseInLocalMode();
  await memberInviteModeFor(actorId, workspaceId, role);
  const unique = [...new Set(emails.map(normalizeEmail).filter(Boolean))];
  if (!unique.length) throw new WorkspaceError("emailRequired", "Enter at least one email address.");
  if (unique.length > MAX_BULK_EMAILS) {
    throw new WorkspaceError("tooManyEmails", `Add at most ${MAX_BULK_EMAILS} people at a time.`);
  }
  const results: BulkAddResult[] = [];
  for (const email of unique) {
    if (!isEmail(email)) {
      results.push({ email, kind: "error", code: "invalidEmail" });
      continue;
    }
    try {
      results.push({ email, ...(await addMember(actorId, workspaceId, email, role)) });
    } catch (error) {
      if (!(error instanceof WorkspaceError)) throw error;
      results.push({ email, kind: "error", code: error.code });
    }
  }
  return results;
}

/**
 * Pending invitations, including expired ones so they can be renewed. Owners and membership
 * admins; invitations to become an owner (and their links) only owners see.
 */
export async function listInvitations(actorId: string, workspaceId: string) {
  const { role: actorRole } = await requirePeopleManager(actorId, workspaceId);
  const rows = await db
    .select({
      id: workspaceInvitation.id,
      email: workspaceInvitation.email,
      role: workspaceInvitation.role,
      token: workspaceInvitation.token,
      expiresAt: workspaceInvitation.expiresAt,
    })
    .from(workspaceInvitation)
    .where(
      and(eq(workspaceInvitation.workspaceId, workspaceId), actorRole === "owner" ? undefined : ne(workspaceInvitation.role, "owner")),
    )
    .orderBy(asc(workspaceInvitation.createdAt));
  return rows.map(({ token, ...row }) => ({ ...row, link: invitationLink(token) }));
}

/** Withdraws an invitation. Owners and membership admins; an invitation to become an owner, owners only. */
export async function revokeInvitation(actorId: string, workspaceId: string, invitationId: string) {
  const { role: actorRole } = await requirePeopleManager(actorId, workspaceId);
  await db.transaction(async (tx) => {
    const revoked = await tx
      .delete(workspaceInvitation)
      .where(
        and(
          eq(workspaceInvitation.workspaceId, workspaceId),
          eq(workspaceInvitation.id, invitationId),
          actorRole === "owner" ? undefined : ne(workspaceInvitation.role, "owner"),
        ),
      )
      .returning({ email: workspaceInvitation.email, role: workspaceInvitation.role });
    // Pages shared with them by email go with the invitation.
    for (const { email, role } of revoked) {
      await tx
        .delete(pageInvitation)
        .where(and(eq(pageInvitation.workspaceId, workspaceId), eq(pageInvitation.email, email)));
      await recordAudit(
        { workspaceId, actorId, action: "invitation.revoked", target: { type: "email", id: email, label: email }, details: { role } },
        tx,
      );
    }
  });
}

/** The unexpired invitation behind a link, or null. Callers must not reveal the token elsewhere. */
export async function findInvitation(token: string) {
  if (!token || env.localMode) return null;
  const [row] = await db
    .select({
      email: workspaceInvitation.email,
      role: workspaceInvitation.role,
      workspaceId: workspaceInvitation.workspaceId,
      workspaceName: workspace.name,
    })
    .from(workspaceInvitation)
    .innerJoin(workspace, eq(workspace.id, workspaceInvitation.workspaceId))
    .where(and(eq(workspaceInvitation.token, token), gt(workspaceInvitation.expiresAt, new Date())))
    .limit(1);
  return row ?? null;
}

export async function emailHasAccount(email: string) {
  const [row] = await db
    .select({ id: user.id })
    .from(user)
    .where(and(eq(sql`lower(${user.email})`, normalizeEmail(email)), notAgentUser(user.id)))
    .limit(1);
  return Boolean(row);
}

/** Whether this link lets `email` create an account while public sign-up is closed. */
export async function invitationAllowsSignUp(token: string, email: string) {
  const invitation = await findInvitation(token);
  return invitation !== null && invitation.email === normalizeEmail(email);
}

/**
 * Redeems an invitation for the signed-in account. The account's email must be the invited one,
 * so a forwarded link can't be used by someone else. Returns the workspace id.
 */
export async function acceptInvitation(token: string, userId: string, userEmail: string) {
  refuseInLocalMode();
  const workspaceId = await db.transaction(async (tx) => {
    const [invitation] = await tx
      .select({
        id: workspaceInvitation.id,
        workspaceId: workspaceInvitation.workspaceId,
        email: workspaceInvitation.email,
        role: workspaceInvitation.role,
        invitedBy: workspaceInvitation.invitedBy,
      })
      .from(workspaceInvitation)
      .where(and(eq(workspaceInvitation.token, token), gt(workspaceInvitation.expiresAt, new Date())))
      .for("update");
    if (!invitation) throw new WorkspaceError("invitationInvalid", "This invitation is invalid or has expired.");
    if (invitation.email !== normalizeEmail(userEmail)) {
      throw new WorkspaceError("invitationEmailMismatch", "This invitation is for a different email address.");
    }
    await tx
      .insert(workspaceMember)
      .values({ workspaceId: invitation.workspaceId, userId, role: invitation.role, invitedBy: invitation.invitedBy })
      .onConflictDoNothing();
    await tx.delete(workspaceInvitation).where(eq(workspaceInvitation.id, invitation.id));
    await claimPageInvitations(tx, invitation.workspaceId, userId, invitation.email);
    await recordAudit(
      {
        workspaceId: invitation.workspaceId,
        actorId: userId,
        action: "invitation.accepted",
        target: { type: "email", id: invitation.email, label: invitation.email },
        details: { role: invitation.role },
      },
      tx,
    );
    return invitation.workspaceId;
  });
  await settleJoinRequest(workspaceId, userId);
  return workspaceId;
}

/** The workspace's join link, or null while it is turned off. Owners only. */
export async function getJoinLink(actorId: string, workspaceId: string) {
  await requireMembership(actorId, workspaceId, "owner");
  const [row] = await db
    .select({ token: workspace.inviteLinkToken })
    .from(workspace)
    .where(eq(workspace.id, workspaceId))
    .limit(1);
  return row?.token ? joinLink(row.token) : null;
}

/**
 * Turns the join link on (keeping an existing token), off, or replaces it so the old link stops
 * working. Returns the link, or null when off. Owners only.
 */
export async function setJoinLink(actorId: string, workspaceId: string, mode: "enable" | "disable" | "regenerate") {
  refuseInLocalMode();
  await requireMembership(actorId, workspaceId, "owner");
  const token =
    mode === "disable" ? null : mode === "regenerate" ? newToken() : sql`coalesce(${workspace.inviteLinkToken}, ${newToken()})`;
  const row = await db.transaction(async (tx) => {
    const [before] = await tx
      .select({ token: workspace.inviteLinkToken })
      .from(workspace)
      .where(eq(workspace.id, workspaceId))
      .for("update");
    const [after] = await tx
      .update(workspace)
      .set({ inviteLinkToken: token })
      .where(eq(workspace.id, workspaceId))
      .returning({ token: workspace.inviteLinkToken });
    // Turning on a link that was on already (or off one that was off) changes nothing to record.
    if (before && (mode === "regenerate" || Boolean(before.token) !== Boolean(after?.token))) {
      const action = mode === "regenerate" ? "join_link.regenerated" : mode === "disable" ? "join_link.disabled" : "join_link.enabled";
      await recordAudit({ workspaceId, actorId, action, target: { type: "join_link" } }, tx);
    }
    return after;
  });
  return row?.token ? joinLink(row.token) : null;
}

/** The workspace behind a join link, or null. */
export async function findJoinLink(token: string) {
  if (!token || env.localMode) return null;
  const [row] = await db
    .select({ workspaceId: workspace.id, workspaceName: workspace.name })
    .from(workspace)
    .where(eq(workspace.inviteLinkToken, token))
    .limit(1);
  return row ?? null;
}

/**
 * What the join link lets this person do (linkAccess), their live invitation if it is theirs to use
 * (invitationApplies: their address is verified), and whether their address is verified at all.
 */
async function linkDecision(
  reader: Pick<typeof db, "select">,
  ws: { id: string; settings: Partial<WorkspaceSettings> },
  userId: string,
  email: string,
) {
  const [[invitation], [account], record, ssoDomains] = await Promise.all([
    reader
      .select({ role: workspaceInvitation.role, invitedBy: workspaceInvitation.invitedBy, expiresAt: workspaceInvitation.expiresAt })
      .from(workspaceInvitation)
      .where(and(eq(workspaceInvitation.workspaceId, ws.id), eq(workspaceInvitation.email, email))),
    reader.select({ emailVerified: user.emailVerified }).from(user).where(eq(user.id, userId)),
    joinRecordOf(reader, ws.id, userId),
    ssoVerifiedDomains(reader, ws.id),
  ]);
  const emailVerified = account?.emailVerified === true;
  const pending = invitation && invitation.expiresAt > new Date() ? invitation : null;
  const live = pending && invitationApplies({ emailVerified, invited: true }) ? pending : null;
  const settings = { ...DEFAULT_WORKSPACE_SETTINGS, ...ws.settings, ssoDomains };
  const access = linkAccess(settings, { email, emailVerified, record, invited: pending !== null });
  return { access, live, emailVerified };
}

/** For the join page: what opening the link would do for this signed-in person, before they choose. */
export async function joinLinkAccess(token: string, userId: string, userEmail: string) {
  if (env.localMode) return null;
  const [ws] = token
    ? await db.select({ id: workspace.id, settings: workspace.settings }).from(workspace).where(eq(workspace.inviteLinkToken, token)).limit(1)
    : [];
  if (!ws) return null;
  return (await linkDecision(db, ws, userId, normalizeEmail(userEmail))).access;
}

/**
 * - `joined`: in the workspace now (or already was).
 * - `requested`: the link asked an owner instead (see linkAccess); `pending`: had asked already.
 */
export type LinkJoinResult = { workspaceId: string; status: "joined" | "requested" | "pending" };

/**
 * Joins the workspace of a join link. People join as members, unless an unexpired invitation for
 * their email gives them another role; that invitation is used up, and its sender invited them
 * (the link alone invites nobody). While the workspace takes join requests from anyone with the
 * link, the link files a request instead for those who can't join directly (see linkAccess).
 *
 * Invitations by email (to the workspace, or to pages in it) are only taken up for a verified
 * address: someone who signed up with another person's address joins as if there were none, and
 * leaves them for the real owner of the address.
 */
export async function joinWithLink(token: string, userId: string, userEmail: string): Promise<LinkJoinResult> {
  refuseInLocalMode();
  const email = normalizeEmail(userEmail);
  const outcome = await db.transaction(async (tx) => {
    const [ws] = token
      ? await tx
          .select({ id: workspace.id, settings: workspace.settings })
          .from(workspace)
          .where(eq(workspace.inviteLinkToken, token))
          .limit(1)
      : [];
    if (!ws) throw new WorkspaceError("joinLinkInvalid", "This join link is invalid or was turned off.");
    if (await findMembership(userId, ws.id)) return { workspaceId: ws.id, access: "join" as const, joined: false };
    const { access, live, emailVerified } = await linkDecision(tx, ws, userId, email);
    if (access !== "join") return { workspaceId: ws.id, access, joined: false };
    if (emailVerified) {
      await tx
        .delete(workspaceInvitation)
        .where(and(eq(workspaceInvitation.workspaceId, ws.id), eq(workspaceInvitation.email, email)));
    }
    const role = live?.role ?? "member";
    await tx
      .insert(workspaceMember)
      .values({ workspaceId: ws.id, userId, role, invitedBy: live?.invitedBy ?? null })
      .onConflictDoNothing();
    if (emailVerified) await claimPageInvitations(tx, ws.id, userId, email);
    await recordAudit(
      { workspaceId: ws.id, actorId: userId, action: "member.joined", target: { type: "user", id: userId }, details: { role, via: "link" } },
      tx,
    );
    return { workspaceId: ws.id, access, joined: true };
  });
  const { workspaceId, access, joined } = outcome;
  if (access === "join") {
    if (joined) await settleJoinRequest(workspaceId, userId);
    return { workspaceId, status: "joined" };
  }
  if (access === "pending") return { workspaceId, status: "pending" };
  if (access !== "request") throw new AccessError();
  return { workspaceId, status: await requestToJoinFrom(workspaceId, userId, email, "link") };
}

/** Locks the owner rows so concurrent demotions/removals can't leave a workspace ownerless. */
async function countOwners(workspaceId: string, tx: Pick<typeof db, "select">) {
  const owners = await tx
    .select({ userId: workspaceMember.userId })
    .from(workspaceMember)
    .where(and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.role, "owner")))
    .for("update");
  return owners.length;
}

/** Refuses changing an agent's user as a member: agents are changed in their own settings. */
async function refuseAgentUser(targetId: string) {
  if (await isAgentUser(targetId)) throw new WorkspaceError("agentUser", "This is an agent; change it in the agent's settings.");
}

/**
 * Changes someone's role. Owners change any; membership admins any between membership admin,
 * member and guest (`mayChangeRole`): they never make, unmake or touch an owner.
 */
export async function setMemberRole(actorId: string, workspaceId: string, targetId: string, role: WorkspaceRole) {
  const actor = await requirePeopleManager(actorId, workspaceId);
  await refuseAgentUser(targetId);
  const previous = await db.transaction(async (tx) => {
    const [current] = await tx
      .select({ role: workspaceMember.role })
      .from(workspaceMember)
      .where(and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, targetId)))
      .for("update");
    if (!current) throw new WorkspaceError("notMember", "This person is not a member.");
    if (!mayChangeRole(actor.role, current.role, role)) throw new AccessError();
    if (current.role === "owner" && role !== "owner" && (await countOwners(workspaceId, tx)) <= 1) {
      throw new WorkspaceError("lastOwner", "A workspace needs at least one owner.");
    }
    await tx
      .update(workspaceMember)
      .set({ role })
      .where(and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, targetId)));
    // Becoming a guest strands no page: what they had as a member through the defaults or
    // "everyone", owners have too, and their own entries keep applying. Guests aren't in teamspaces.
    // Nor in groups: a group's pages and teamspaces are for owners and members.
    if (isGuest(role) && !isGuest(current.role)) {
      await dropFromTeamspaces(tx, workspaceId, targetId, await heirFor(tx, workspaceId, actorId, actor.role));
      await dropFromGroups(tx, workspaceId, targetId);
    }
    if (current.role !== role) {
      await recordAudit(
        { workspaceId, actorId, action: "member.role_changed", target: { type: "user", id: targetId }, details: { from: current.role, to: role } },
        tx,
      );
    }
    return current.role;
  });
  // Open editors keep the access checked when they connected. A move to guest drops those
  // connections as removeMember does; any other change checks them again: an owner made a member
  // keeps only what their teamspaces and shares give members.
  if (isGuest(role) && !isGuest(previous)) await getCollab().disconnectUser(targetId, workspaceId);
  else if (role !== previous) await getCollab().disconnectLostAccess(workspaceId, [targetId]);
}

/** Makes another member an owner and the acting owner a member, in one step. */
export async function transferOwnership(actorId: string, workspaceId: string, targetId: string) {
  await requireMembership(actorId, workspaceId, "owner");
  if (targetId === actorId) throw new WorkspaceError("transferToSelf", "Choose someone else to make owner.");
  await refuseAgentUser(targetId);
  await db.transaction(async (tx) => {
    const [target] = await tx
      .select({ role: workspaceMember.role })
      .from(workspaceMember)
      .where(and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, targetId)))
      .for("update");
    if (!target) throw new WorkspaceError("notMember", "This person is not a member.");
    // Handing the workspace to someone from outside it is too easy to get wrong; make them a member first.
    if (isGuest(target.role)) throw new WorkspaceError("transferToGuest", "Make them a member before making them owner.");
    // The actor stays an owner until the target is one, so the workspace is never ownerless.
    await tx
      .update(workspaceMember)
      .set({ role: "owner" })
      .where(and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, targetId)));
    const demoted = await tx
      .update(workspaceMember)
      .set({ role: "member" })
      .where(
        and(
          eq(workspaceMember.workspaceId, workspaceId),
          eq(workspaceMember.userId, actorId),
          eq(workspaceMember.role, "owner"),
        ),
      )
      .returning({ userId: workspaceMember.userId });
    // Another owner demoted the actor meanwhile: nothing to hand over.
    if (!demoted.length) throw new AccessError();
    await recordAudit(
      {
        workspaceId,
        actorId,
        action: "member.ownership_transferred",
        target: { type: "user", id: targetId },
        details: { from: target.role },
      },
      tx,
    );
  });
  // The acting owner is a member now: their open editors are checked again (see setMemberRole).
  await getCollab().disconnectLostAccess(workspaceId, [actorId]);
}

/**
 * Inside the transaction that takes someone out of the workspace, after handOverOrphanedPages
 * (their entries are what tells it which pages they alone could manage): what they were given in
 * it goes, so coming back (an invitation, the join link, an access request, single sign-on, SCIM)
 * starts from what the workspace gives everyone. Their own entries on pages and properties, their
 * calendar feeds of the workspace, and API tokens that only reach it.
 */
async function forgetWorkspaceGrants(tx: Tx, workspaceId: string, userId: string) {
  await tx.delete(pagePermission).where(and(eq(pagePermission.workspaceId, workspaceId), eq(pagePermission.userId, userId)));
  await tx
    .delete(propertyPermission)
    .where(and(eq(propertyPermission.workspaceId, workspaceId), eq(propertyPermission.userId, userId)));
  const views = tx
    .select({ id: databaseView.id })
    .from(databaseView)
    .innerJoin(page, eq(page.id, databaseView.databaseId))
    .where(eq(page.workspaceId, workspaceId));
  await tx
    .delete(calendarFeed)
    .where(and(eq(calendarFeed.userId, userId), or(eq(calendarFeed.workspaceId, workspaceId), inArray(calendarFeed.viewId, views))));
  await tx.delete(apiToken).where(and(eq(apiToken.userId, userId), eq(apiToken.workspaceId, workspaceId)));
}

/**
 * Owners can remove anyone, membership admins anyone but owners (`mayRemove`); everyone else can
 * only remove themselves (leave).
 */
export async function removeMember(actorId: string, workspaceId: string, targetId: string) {
  // Leaving works without meeting the two-step policy: nobody should have to set it up to get out.
  const actor = actorId === targetId ? await findMembership(actorId, workspaceId) : await requireMembership(actorId, workspaceId);
  if (!actor || (actorId !== targetId && !managesPeople(actor.role))) throw new AccessError();
  // Archiving an agent takes it out of the lists; its membership stays, so its edits keep its name.
  await refuseAgentUser(targetId);
  let released: AiAccountRelease | null = null;
  await db.transaction(async (tx) => {
    const [current] = await tx
      .select({ role: workspaceMember.role })
      .from(workspaceMember)
      .where(and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, targetId)))
      .for("update");
    if (!current) throw new WorkspaceError("notMember", "This person is not a member.");
    if (actorId !== targetId && !mayRemove(actor.role, current.role)) throw new AccessError();
    if (current.role === "owner" && (await countOwners(workspaceId, tx)) <= 1) {
      throw new WorkspaceError("lastOwnerRemove", "A workspace needs at least one owner. Make someone else an owner first.");
    }
    // Files of the workspace kept in their storage move to an owner's, before they are out. Someone
    // leaving can't while there is nowhere for them to go; someone removed is, and owners are told.
    await moveFilesAway(tx, targetId, workspaceId, actorId === targetId ? "left" : "removed", actorId);
    await tx
      .delete(workspaceMember)
      .where(and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, targetId)));
    released = await releaseAiAccount(tx, workspaceId, targetId);
    // An owner removing someone takes over what only they managed; someone leaving, or removed by a
    // membership admin (who manages people, not their pages), hands it to an owner.
    const heir = actorId !== targetId ? await heirFor(tx, workspaceId, actorId, actor.role) : await oldestOwner(tx, workspaceId);
    await dropFromTeamspaces(tx, workspaceId, targetId, heir);
    if (heir) await handOverOrphanedPages(tx, workspaceId, heir);
    await forgetWorkspaceGrants(tx, workspaceId, targetId);
    // Their AI chat and agent chat conversations quote the workspace's pages, and what it
    // remembers about them is the workspace's context: they go with them.
    await tx.delete(aiConversation).where(and(eq(aiConversation.workspaceId, workspaceId), eq(aiConversation.userId, targetId)));
    await tx.delete(agentConversation).where(and(eq(agentConversation.workspaceId, workspaceId), eq(agentConversation.userId, targetId)));
    await tx.delete(aiMemory).where(and(eq(aiMemory.workspaceId, workspaceId), eq(aiMemory.userId, targetId)));
    // Their mailbox in the workspace (and its password) goes too; the mail it brought stays on rows.
    await tx.delete(mailbox).where(and(eq(mailbox.workspaceId, workspaceId), eq(mailbox.userId, targetId)));
    // An allowed email domain doesn't bring them back on their next sign-in; someone an owner
    // removed can't come back through it on their own either, only ask (see domainAccess).
    await rememberDeparture(tx, workspaceId, targetId, actorId === targetId ? "accepted" : "declined", actorId);
    await recordAudit(
      {
        workspaceId,
        actorId,
        action: actorId === targetId ? "member.left" : "member.removed",
        target: { type: "user", id: targetId },
        details: { role: current.role },
      },
      tx,
    );
  });
  kickMoves();
  await getCollab().disconnectUser(targetId, workspaceId);
  if (released) await afterAiAccountReleased([released]);
}

/**
 * Queues moving the workspace's files out of `userId`'s storage (see storage/moves.ts) as they
 * leave (refused when the files have nowhere to go) or are removed (going ahead, with a blocked
 * move for owners to see).
 */
async function moveFilesAway(tx: Tx, userId: string, workspaceId: string, reason: "left" | "removed", actorId: string | null) {
  try {
    await planMovesAway(tx, { userId, workspaceIds: [workspaceId], reason, actorId, mode: reason === "left" ? "refuse" : "block" });
  } catch (error) {
    if (error instanceof StorageSettingsError && error.code === "noDestination") {
      throw new WorkspaceError("storageNoDestination", "This workspace's files are in your storage and there is nowhere they can move to.");
    }
    if (error instanceof StorageSettingsError && error.code === "moveInProgress") {
      throw new WorkspaceError("storageMoveInProgress", "This workspace's files are being moved into your storage. Wait for it to finish.");
    }
    throw error;
  }
}

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** A workspace whose AI no longer runs on someone's own AI account, and the owners' inbox items about it. */
export type AiAccountRelease = { workspaceId: string; notificationIds: string[] };

/**
 * Takes `userId`'s own AI account (OWN_AI_KEYS_ENABLED) off the workspace, inside the transaction
 * that takes them out of it: nobody pays for a workspace they are no longer in. Its AI falls back to
 * the server's settings, or none (see aiTargetFor). The owners who stay find out in their inbox.
 * Null when the workspace didn't run on their account.
 */
export async function releaseAiAccount(tx: Tx, workspaceId: string, userId: string): Promise<AiAccountRelease | null> {
  const released = await tx
    .update(workspace)
    .set({ aiAccountId: null })
    .where(and(eq(workspace.id, workspaceId), sql`${workspace.aiAccountId} in (select ${aiAccount.id} from ${aiAccount} where ${aiAccount.userId} = ${userId})`))
    .returning({ id: workspace.id });
  if (!released.length) return null;
  return { workspaceId, notificationIds: await tellOwnersAiAccountGone(tx, workspaceId, userId) };
}

/**
 * Inbox items for the workspace's owners (but `payerId`) that its AI no longer runs on `payerId`'s
 * own AI account; their ids, to push once the transaction commits (afterAiAccountReleased).
 */
export async function tellOwnersAiAccountGone(tx: Tx, workspaceId: string, payerId: string): Promise<string[]> {
  const owners = await tx
    .select({ id: workspaceMember.userId })
    .from(workspaceMember)
    .where(and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.role, "owner"), ne(workspaceMember.userId, payerId), notAgentUser(workspaceMember.userId)));
  if (!owners.length) return [];
  const rows = await tx
    .insert(notification)
    .values(owners.map((o) => ({ userId: o.id, workspaceId, kind: "ai_account_detached" as const, actorId: payerId })))
    .returning({ id: notification.id });
  return rows.map((r) => r.id);
}

/**
 * After the transaction that took AI accounts off workspaces: their open inboxes refresh, the
 * owners' devices get the news, and their semantic search index is made again with the model they
 * have now (or dropped without one).
 */
export async function afterAiAccountReleased(released: AiAccountRelease[]) {
  if (!released.length) return;
  const [{ signalInbox }, { pushNotifications }, { reindexWorkspace }] = await Promise.all([
    import("@/server/notifications"),
    import("@/server/push"),
    import("@/server/semantic-index"),
  ]);
  for (const { workspaceId, notificationIds } of released) {
    try {
      signalInbox(workspaceId);
      pushNotifications(notificationIds);
    } catch (error) {
      console.error("[ai] could not tell owners about a detached AI account", error);
    }
    await reindexWorkspace(workspaceId).catch((error) => console.error("[ai] could not index a workspace again", error));
  }
}

async function standingsOf(reader: Pick<typeof db, "select">, userId: string): Promise<WorkspaceStanding[]> {
  const rows = await reader
    .select({
      id: workspace.id,
      name: workspace.name,
      role: workspaceMember.role,
      // Agents' users aren't people: a workspace with only its owner and agents is theirs alone.
      people: sql<number>`(select count(*)::int from ${workspaceMember} x where x.workspace_id = ${workspace.id} and ${notAgentUser(sql`x.user_id`)})`,
      owners: sql<number>`(select count(*)::int from ${workspaceMember} x where x.workspace_id = ${workspace.id} and x.role = 'owner')`,
    })
    .from(workspaceMember)
    .innerJoin(workspace, eq(workspace.id, workspaceMember.workspaceId))
    .where(eq(workspaceMember.userId, userId))
    .orderBy(asc(workspace.createdAt));
  return rows.map((r) => ({ ...r, people: Number(r.people), owners: Number(r.owners) }));
}

/** What deleting `userId`'s account would do to each of their workspaces (see lib/account.ts). */
export async function accountDeletionPlan(userId: string): Promise<DeletionPlan> {
  const standing = planAccountDeletion(await standingsOf(db, userId));
  const plan = withLegalHolds(standing, await accountHolds(db, userId, standing));
  if (!plan.left.length) return plan;
  // Files of the workspaces they leave that are in their storage move first, where they can.
  const { moving, stuck } = await planMovesAway(db, { userId, workspaceIds: plan.left.map((w) => w.id), reason: "accountDeleted", actorId: userId, mode: "preview" });
  const named = (ids: string[]) => plan.left.filter((w) => ids.includes(w.id)).map(({ id, name }) => ({ id, name }));
  return { ...plan, storageMoves: named(moving), storageStuck: named(stuck) };
}

/**
 * For deleting an account (server/account.ts), inside its transaction: unless `plan.blockers`
 * names workspaces the person is the only owner of (then nothing changes), deletes the workspaces
 * nobody else is in, with their pages and files (returning the files' storage keys, to remove once
 * the transaction commits), and leaves the others the way leaving does: an owner takes over the
 * pages only this person could manage.
 *
 * The deleted workspaces' single sign-on connections are for the caller to cut off as removing one
 * does (cutOffConnection, with the provider ids returned), last in its transaction: the people who
 * signed in through them, members or not by now, may be in other workspaces, and a backup brings a
 * workspace's id, and with it its connection's provider id, back. The sign-ins point at the provider
 * id without a foreign key, so they outlive the workspace's rows. A connection the person set up in
 * a workspace that stays, whether or not they are still in it, passes to an owner there: the SSO
 * plugin's provider row belongs to whoever set it up, and would go with their account.
 */
export async function withdrawFromWorkspaces(
  tx: Tx,
  userId: string,
): Promise<{ plan: DeletionPlan; fileKeys: QueuedObject[]; providerIds: string[]; aiReleased: AiAccountRelease[] }> {
  const ids = (
    await tx.select({ id: workspaceMember.workspaceId }).from(workspaceMember).where(eq(workspaceMember.userId, userId))
  ).map((r) => r.id);
  // Locking the workspaces holds off people joining them (adding a member takes a key-share lock
  // on its workspace row) until this transaction ends, and serializes it with deleting the
  // workspace or another account in it. Also those whose connection they set up, so the owner who
  // takes it over isn't deleting their account meanwhile.
  const locked = [...new Set([...ids, ...(await connectionsSetUpBy(tx, userId)).map((c) => c.workspaceId)])];
  if (locked.length) {
    await tx.select({ id: workspace.id }).from(workspace).where(inArray(workspace.id, locked)).orderBy(asc(workspace.id)).for("update");
  }
  const standing = planAccountDeletion(await standingsOf(tx, userId));
  const plan = withLegalHolds(standing, await accountHolds(tx, userId, standing));
  if (plan.blockers.length || plan.legalHolds?.length) return { plan, fileKeys: [], providerIds: [], aiReleased: [] };
  // Files of the workspaces they leave that are in their storage move to an owner's (or the
  // server's) once this commits; their storage account outlives them until the moves are done.
  // Refused (rolling everything back) when some have nowhere to go.
  if (plan.left.length) {
    try {
      await planMovesAway(tx, { userId, workspaceIds: plan.left.map((w) => w.id), reason: "accountDeleted", actorId: userId, mode: "refuse" });
    } catch (error) {
      if (error instanceof StorageSettingsError && (error.code === "noDestination" || error.code === "moveInProgress")) {
        return {
          plan: { ...plan, storageStuck: plan.left.filter((w) => w.name === error.detail).map(({ id, name }) => ({ id, name })) },
          fileKeys: [],
          providerIds: [],
          aiReleased: [],
        };
      }
      throw error;
    }
  }

  const fileKeys: QueuedObject[] = [];
  const providerIds: string[] = [];
  const aiReleased: AiAccountRelease[] = [];
  const deleted = plan.deleted.map((w) => w.id);
  if (deleted.length) {
    const connections = await tx
      .select({ providerId: workspaceSso.providerId })
      .from(workspaceSso)
      .where(inArray(workspaceSso.workspaceId, deleted));
    providerIds.push(...connections.map((c) => c.providerId));
    const files = await tx
      .delete(file)
      .where(inArray(file.workspaceId, deleted))
      .returning({ key: file.storageKey, storageId: file.storageId, objectId: file.storageObjectId });
    fileKeys.push(...files);
    await deleteWorkspaces(tx, deleted);
  }
  for (const { id, role } of plan.left) {
    // Recorded while the account is still there: the event keeps their name, the id is cleared.
    await recordAudit(
      { workspaceId: id, actorId: userId, action: "member.left", target: { type: "user", id: userId }, details: { role, via: "account_deleted" } },
      tx,
    );
    await tx.delete(workspaceMember).where(and(eq(workspaceMember.workspaceId, id), eq(workspaceMember.userId, userId)));
    const released = await releaseAiAccount(tx, id, userId);
    if (released) aiReleased.push(released);
    const heir = await oldestOwner(tx, id);
    if (heir) await handOverOrphanedPages(tx, id, heir);
  }
  // Once they are out of every workspace, so the heir is someone who stays (the deleted
  // workspaces' connections are gone by now).
  for (const { workspaceId, providerId } of await connectionsSetUpBy(tx, userId)) {
    const heir = await oldestOwner(tx, workspaceId);
    if (heir) await tx.update(ssoProvider).set({ userId: heir }).where(eq(ssoProvider.providerId, providerId));
  }
  return { plan, fileKeys, providerIds, aiReleased };
}

/**
 * The workspaces whose legal holds keep `userId`'s account (server/legal-hold.ts): one on them, or
 * any in a workspace the plan deletes with it.
 */
async function accountHolds(reader: Pick<typeof db, "select" | "selectDistinct" | "execute">, userId: string, plan: DeletionPlan) {
  const found = new Map<string, { id: string; name: string }>();
  for (const w of [...(await workspacesHolding(userId, reader)), ...(await workspacesWithHolds(plan.deleted.map((d) => d.id), reader))]) {
    found.set(w.id, w);
  }
  return [...found.values()];
}

const withLegalHolds = (plan: DeletionPlan, holds: { id: string; name: string }[]): DeletionPlan => (holds.length ? { ...plan, legalHolds: holds } : plan);

/** The single sign-on connections whose provider row belongs to `userId`, who set them up. */
async function connectionsSetUpBy(reader: Pick<typeof db, "select">, userId: string) {
  return reader
    .select({ workspaceId: workspaceSso.workspaceId, providerId: workspaceSso.providerId })
    .from(workspaceSso)
    .innerJoin(ssoProvider, eq(ssoProvider.providerId, workspaceSso.providerId))
    .where(eq(ssoProvider.userId, userId));
}

/**
 * Locks the workspace's row until the transaction ends, so nobody joins it meanwhile (adding a
 * member takes a key-share lock on it), and checks that `userId` still owns it. Changes to its
 * single sign-on connection take it first (server/sso.ts), as deleting the workspace or the account
 * of someone in it does: they then write the connection's rows and the workspace's audit log, whose
 * entry needs its row too, and in the other order each could hold what the other waits for.
 */
export async function lockAsOwner(tx: Tx, userId: string, workspaceId: string) {
  const [locked] = await tx.select({ id: workspace.id }).from(workspace).where(eq(workspace.id, workspaceId)).for("update");
  if (!locked) throw new WorkspaceError("workspaceDeleted", "The workspace was deleted meanwhile.");
  const [member] = await tx
    .select({ role: workspaceMember.role })
    .from(workspaceMember)
    .where(and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, userId)))
    .limit(1);
  if (member?.role !== "owner") throw new AccessError();
}

/**
 * For deleting a workspace (server/workspace-deletion.ts), inside its transaction: locks it as its
 * owner (lockAsOwner) and returns the other people in it, to tell them it's gone.
 */
export async function lockOwnedWorkspace(tx: Tx, userId: string, workspaceId: string) {
  await lockAsOwner(tx, userId, workspaceId);
  return tx
    .select({ userId: user.id, email: user.email, name: user.name })
    .from(workspaceMember)
    .innerJoin(user, eq(user.id, workspaceMember.userId))
    .where(and(eq(workspaceMember.workspaceId, workspaceId), ne(workspaceMember.userId, userId), notAgentUser(workspaceMember.userId)));
}

/**
 * Deletes workspaces, with what belongs to them, inside the caller's transaction. Their agents'
 * users belong to them too: they go along, rather than staying behind as users of no workspace.
 */
export async function deleteWorkspaces(tx: Tx, workspaceIds: string[]) {
  if (!workspaceIds.length) return;
  const agentUsers = (
    await tx.select({ userId: workspaceAgent.userId }).from(workspaceAgent).where(inArray(workspaceAgent.workspaceId, workspaceIds))
  ).map((a) => a.userId);
  await tx.delete(workspace).where(inArray(workspace.id, workspaceIds));
  if (agentUsers.length) await tx.delete(user).where(inArray(user.id, agentUsers));
}

/**
 * The workspace's longest-standing owner: heir of what nobody else can manage when no owner made
 * the change (the person left, their provider removed them), and who acts for SCIM group changes.
 */
export async function oldestOwner(reader: Pick<typeof db, "select">, workspaceId: string) {
  const [owner] = await reader
    .select({ userId: workspaceMember.userId })
    .from(workspaceMember)
    .where(and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.role, "owner")))
    .orderBy(asc(workspaceMember.createdAt))
    .limit(1);
  return owner?.userId ?? null;
}

/**
 * Who takes over the pages and teamspaces only `actorId`'s change left without a manager
 * (handOverOrphanedPages, dropFromTeamspaces): the acting owner, or for a membership admin, who
 * manages people and not their pages, the workspace's longest-standing owner.
 */
export async function heirFor(tx: Pick<typeof db, "select">, workspaceId: string, actorId: string, actorRole: WorkspaceRole) {
  return actorRole === "owner" ? actorId : await oldestOwner(tx, workspaceId);
}

/**
 * After someone leaves the workspace (or a group loses a member or is deleted), gives `heirId` full
 * access to every page nobody in the workspace can manage any more, so no page is stranded where
 * nobody can share or delete it. Only pages with entries of their own (for people or groups) can be
 * stranded: the others inherit from a parent, or are open to every member. Private pages stay
 * private from everyone else.
 */
export async function handOverOrphanedPages(tx: Tx, workspaceId: string, heirId: string) {
  // Same lock as sharing changes, so one can't strand a page this has just checked.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`page_permission:${workspaceId}`}))`);
  const handed = await tx.execute<{ page_id: string }>(sql`
    insert into ${pagePermission} (id, page_id, workspace_id, user_id, level, created_by)
    select gen_random_uuid()::text, p.id, p.workspace_id, ${heirId}, 'full', ${heirId}
    from ${page} p
    where p.workspace_id = ${workspaceId}
      and (exists (select 1 from ${pagePermission} pp where pp.page_id = p.id)
        or exists (select 1 from ${pageGroupPermission} gp where gp.page_id = p.id))
      and not exists (
        select 1 from ${workspaceMember} wm
        where wm.workspace_id = ${workspaceId} and page_access_level(wm.user_id, p.id) = ${FULL_RANK}
      )
    on conflict (page_id, user_id) do update set level = 'full', created_by = excluded.created_by, created_at = now()
    returning page_id
  `);
  return handed.length;
}

/** The workspace's policies, defaults filled in. For server code that enforces them. */
export async function workspaceSettings(workspaceId: string): Promise<WorkspaceSettings> {
  const [row] = await db
    .select({ settings: workspace.settings })
    .from(workspace)
    .where(eq(workspace.id, workspaceId))
    .limit(1);
  return { ...DEFAULT_WORKSPACE_SETTINGS, ...row?.settings };
}

/** The policies, for owners and members to read (guests don't see workspace settings). */
export async function getWorkspaceSettings(userId: string, workspaceId: string) {
  await requireMember(userId, workspaceId);
  return workspaceSettings(workspaceId);
}

/**
 * How many people in the workspace, guests included, have neither an authenticator app nor a
 * passkey: the ones "require two-step verification" would send to set one up. Owners only.
 */
export async function countMembersWithoutTwoFactor(actorId: string, workspaceId: string) {
  await requireMembership(actorId, workspaceId, "owner");
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(workspaceMember)
    .innerJoin(user, eq(user.id, workspaceMember.userId))
    .where(
      and(
        eq(workspaceMember.workspaceId, workspaceId),
        notAgentUser(user.id),
        sql`not (coalesce(${user.twoFactorEnabled}, false) or exists (select 1 from ${passkey} where ${passkey.userId} = ${user.id}))`,
      ),
    );
  return row?.count ?? 0;
}

/**
 * The choices of each setting; allowedDomains, a list, is checked on its own (parseDomains).
 * allowedDomainsVerified isn't one: only proving a domain sets it (server/allowed-domains.ts).
 */
const SETTING_VALUES: {
  [K in Exclude<keyof WorkspaceSettings, "allowedDomains" | "allowedDomainsVerified" | "calloutStyles" | "aiMonthlyLimitUsd">]: readonly WorkspaceSettings[K][];
} = {
  guestInvites: ["owners", "members"],
  guestPrivatePages: [false, true],
  publishing: ["owners", "members", "off"],
  requireTwoFactor: [false, true],
  teamspaceCreation: ["owners", "members"],
  agentCreation: ["owners", "members"],
  loginMethod: ["any", "sso"],
  ai: [true, false],
  aiMemory: [true, false],
  aiWebSearch: [false, true],
  trashRetentionDays: TRASH_RETENTION_CHOICES,
  memberInvites: ["owners", "members_with_approval", "any_member"],
  domainJoin: ["join", "request"],
  joinRequests: ["nobody", "allowed_domains", "anyone_with_link"],
  export: [true, false],
  connectedApps: CONNECTED_APPS_MODES,
  accessRequests: [true, false],
  email: [false, true],
  pageViews: [true, false],
  sensitiveContent: [false, true],
};

/**
 * Changes some policies, leaving the rest as they are. Owners only. Requiring two-step
 * verification also needs the owner's own session to pass it (`strongSession`, see
 * isStrongSession), so turning it on can't shut the owner out of their workspace.
 */
export async function updateWorkspaceSettings(
  actorId: string,
  workspaceId: string,
  patch: Partial<WorkspaceSettings>,
  { strongSession = false }: { strongSession?: boolean } = {},
) {
  await requireMembership(actorId, workspaceId, "owner");
  if (patch.requireTwoFactor === true && !strongSession) {
    throw new WorkspaceError("twoFactorFirst", "Turn on two-step verification for your own account first");
  }
  if (patch.loginMethod === "sso" && !(await ssoAvailable(workspaceId))) {
    throw new WorkspaceError("ssoFirst", "Set up single sign-on and verify its domains first");
  }
  const clean: Partial<WorkspaceSettings> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === "allowedDomains") {
      // Public mail services (gmail.com, …) can't be allowed: anyone could sign up on them.
      const parsed = Array.isArray(value) && value.every((d) => typeof d === "string") ? parseDomains(value) : null;
      if (!parsed?.ok) {
        throw new WorkspaceError("invalidDomain", `Can't allow ${parsed ? parsed.invalid : "that"}`, parsed ? parsed.invalid : "");
      }
      clean.allowedDomains = parsed.domains;
      continue;
    }
    if (key === "aiMonthlyLimitUsd") {
      const limit = parseAiMonthlyLimit(value);
      if (limit === undefined) throw new WorkspaceError("invalidSetting", `Unknown setting ${key}=${String(value)}`);
      clean.aiMonthlyLimitUsd = limit;
      continue;
    }
    if (key === "calloutStyles") {
      const parsed = parseCalloutStyles(value);
      if (!parsed.ok) {
        throw new WorkspaceError("invalidCalloutStyle", `Can't save callout style ${parsed.index + 1}: ${parsed.problem}`, parsed.problem);
      }
      clean.calloutStyles = parsed.styles;
      continue;
    }
    const allowed = Object.hasOwn(SETTING_VALUES, key)
      ? (SETTING_VALUES[key as keyof typeof SETTING_VALUES] as readonly unknown[])
      : [];
    if (!allowed.includes(value)) throw new WorkspaceError("invalidSetting", `Unknown setting ${key}=${String(value)}`);
    Object.assign(clean, { [key]: value });
  }
  await db.transaction(async (tx) => {
    const [before] = await tx.select({ settings: workspace.settings }).from(workspace).where(eq(workspace.id, workspaceId)).for("update");
    // A domain taken off the list loses its proof: listed again, it has to be verified again.
    const proofs = clean.allowedDomains && {
      allowedDomainsVerified: (before?.settings.allowedDomainsVerified ?? []).filter((d) => clean.allowedDomains!.includes(d)),
    };
    await tx
      .update(workspace)
      .set({ settings: sql`${workspace.settings} || ${JSON.stringify({ ...clean, ...proofs })}::jsonb` })
      .where(eq(workspace.id, workspaceId));
    // Only the keys whose value changed, defaults filled in on both sides.
    const changes = changedValues({ ...DEFAULT_WORKSPACE_SETTINGS, ...before?.settings }, clean);
    if (Object.keys(changes).length) {
      await recordAudit(
        { workspaceId, actorId, action: "workspace.settings_changed", target: { type: "workspace", id: workspaceId }, details: { changes } },
        tx,
      );
    }
  });
  // AI off: the workspace's content leaves the semantic search index too (see semantic-index.ts).
  if (clean.ai === false) {
    await db.delete(pageChunk).where(eq(pageChunk.workspaceId, workspaceId));
    await db.delete(pageIndexState).where(eq(pageIndexState.workspaceId, workspaceId));
  }
  // Detection off: what it found, and which pages it read, are forgotten (turned on again, it reads everything anew).
  if (clean.sensitiveContent === false) {
    await db.delete(sensitiveFinding).where(eq(sensitiveFinding.workspaceId, workspaceId));
    await db.delete(sensitiveScan).where(eq(sensitiveScan.workspaceId, workspaceId));
  }
  // Open editors were let in before; the ones the policy now holds back reconnect and are refused.
  if (clean.requireTwoFactor === true || clean.loginMethod === "sso") await getCollab().disconnectHeldBack(workspaceId);
}

/**
 * Whether members of the workspace can sign in with single sign-on: it has a connection with
 * verified domains, or the instance has its own provider. "SSO only" needs one of them.
 */
export async function ssoAvailable(workspaceId: string) {
  if (env.localMode) return false;
  if (env.instanceOidc) return true;
  const [row] = await db
    .select({ one: sql<number>`1` })
    .from(workspaceSso)
    .innerJoin(ssoProvider, eq(ssoProvider.providerId, workspaceSso.providerId))
    .where(and(eq(workspaceSso.workspaceId, workspaceId), eq(ssoProvider.domainVerified, true)))
    .limit(1);
  return row !== undefined;
}

/**
 * Adds someone to the workspace as a member on their own behalf (single sign-on through the
 * workspace's connection, or its identity provider over SCIM). Someone already in the workspace
 * keeps their role. Pending page invitations for their address come along, as when an owner adds
 * them. They came in on their own, so nobody invited them, unless an unexpired invitation to the
 * workspace was waiting for their address: its sender did. Returns whether they were added.
 *
 * Single sign-on doesn't bring back someone who left the workspace, or whom it kept out (an owner
 * or its identity provider removed them, or an owner declined their request to join): a new
 * connection, or one pointed at another identity provider, makes everyone's next sign-in through
 * it their first again. An invitation to join as a member or owner does, as their identity
 * provider does over SCIM.
 */
export async function joinAsMember(workspaceId: string, userId: string, email: string, via: "sso" | "scim" | "domain") {
  const clean = normalizeEmail(email);
  if (isAgentEmail(clean) || (await isAgentUser(userId))) return false;
  const joined = await db.transaction(async (tx) => {
    const [invitation] = await tx
      .select({ role: workspaceInvitation.role, invitedBy: workspaceInvitation.invitedBy })
      .from(workspaceInvitation)
      .where(
        and(
          eq(workspaceInvitation.workspaceId, workspaceId),
          eq(workspaceInvitation.email, clean),
          gt(workspaceInvitation.expiresAt, new Date()),
        ),
      );
    if (via === "sso" && (!invitation || invitation.role === "guest")) {
      // Waits for a removal under way, so the departure it records is read below.
      const [member] = await tx
        .select({ role: workspaceMember.role })
        .from(workspaceMember)
        .where(and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, userId)))
        .for("update");
      if (member) return false;
      const record = await joinRecordOf(tx, workspaceId, userId);
      if (record === "accepted" || record === "declined") return false;
    }
    const rows = await tx
      .insert(workspaceMember)
      .values({ workspaceId, userId, role: "member", invitedBy: invitation?.invitedBy ?? null })
      .onConflictDoNothing()
      .returning({ userId: workspaceMember.userId });
    if (!rows.length) return false;
    await tx
      .delete(workspaceInvitation)
      .where(and(eq(workspaceInvitation.workspaceId, workspaceId), eq(workspaceInvitation.email, clean)));
    await claimPageInvitations(tx, workspaceId, userId, clean);
    // They joined on their own, through single sign-on or their email domain, or their identity
    // provider added them (a SCIM request is recorded as its own, see server/audit.ts).
    await recordAudit(
      {
        workspaceId,
        actorId: userId,
        action: via === "scim" ? "member.added" : "member.joined",
        target: { type: "user", id: userId },
        details: { role: "member", via },
      },
      tx,
    );
    return true;
  });
  if (joined) await settleJoinRequest(workspaceId, userId);
  return joined;
}

/**
 * Takes someone out of the workspace without an owner doing it (their identity provider over
 * SCIM): what an owner removing them does, with the oldest owner taking over what only they could
 * manage. Owners can't be removed this way. Returns false when they weren't in the workspace.
 */
export async function removeMemberByProvider(workspaceId: string, userId: string) {
  let released: AiAccountRelease | null = null;
  const removed = await db.transaction(async (tx) => {
    const [current] = await tx
      .select({ role: workspaceMember.role })
      .from(workspaceMember)
      .where(and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, userId)))
      .for("update");
    if (!current) return false;
    if (current.role === "owner") throw new WorkspaceError("lastOwnerRemove", "Owners are managed in the app");
    await moveFilesAway(tx, userId, workspaceId, "removed", null);
    await tx.delete(workspaceMember).where(and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, userId)));
    released = await releaseAiAccount(tx, workspaceId, userId);
    // Their AI chat and agent chat conversations quote the workspace's pages, and what it
    // remembers about them is the workspace's context: they go with the membership.
    await tx.delete(aiConversation).where(and(eq(aiConversation.workspaceId, workspaceId), eq(aiConversation.userId, userId)));
    await tx.delete(agentConversation).where(and(eq(agentConversation.workspaceId, workspaceId), eq(agentConversation.userId, userId)));
    await tx.delete(aiMemory).where(and(eq(aiMemory.workspaceId, workspaceId), eq(aiMemory.userId, userId)));
    const heir = await oldestOwner(tx, workspaceId);
    await dropFromTeamspaces(tx, workspaceId, userId, heir);
    if (heir) await handOverOrphanedPages(tx, workspaceId, heir);
    await forgetWorkspaceGrants(tx, workspaceId, userId);
    await rememberDeparture(tx, workspaceId, userId, "declined", null);
    await recordAudit(
      { workspaceId, actorId: null, action: "member.removed", target: { type: "user", id: userId }, details: { role: current.role, via: "scim" } },
      tx,
    );
    return true;

  });
  if (removed) {
    kickMoves();
    await getCollab().disconnectUser(userId, workspaceId);
  }
  if (released) await afterAiAccountReleased([released]);
  return removed;
}

/**
 * Whether the user may bring people from outside the workspace in as guests, by sharing a page
 * with them: owners and membership admins always, members when the workspace allows it, guests never.
 */
export async function canInviteGuests(userId: string, workspaceId: string) {
  // No guests when Leafdesk runs on one computer: there is no one to bring in.
  if (env.localMode) return false;
  const [membership, settings] = await Promise.all([getMembership(userId, workspaceId), workspaceSettings(workspaceId)]);
  if (!membership) return false;
  return managesPeople(membership.role) || (membership.role === "member" && settings.guestInvites === "members");
}

/**
 * How the user may add members (Settings > Security, "Who can add members"): right away, by asking
 * an owner, or not at all (null).
 */
export async function memberInviteAccess(userId: string, workspaceId: string): Promise<"direct" | "request" | null> {
  if (env.localMode) return null;
  const [membership, settings] = await Promise.all([getMembership(userId, workspaceId), workspaceSettings(workspaceId)]);
  const mode = memberInviteMode(membership?.role ?? null, settings);
  return mode === "denied" ? null : mode;
}

/**
 * Pure: whether someone with this role may publish under the workspace's publishing setting:
 * owners unless publishing is off, members when it allows them, guests never.
 */
export function mayPublish(role: WorkspaceRole, publishing: WorkspaceSettings["publishing"]) {
  if (publishing === "off" || isGuest(role)) return false;
  return role === "owner" || publishing === "members";
}

/**
 * Whether the user may publish pages (and open forms) of the workspace to the web, on top of full
 * access to the page (see mayPublish).
 */
export async function canPublish(userId: string, workspaceId: string) {
  const [membership, settings] = await Promise.all([getMembership(userId, workspaceId), workspaceSettings(workspaceId)]);
  return membership ? mayPublish(membership.role, settings.publishing) : false;
}

/**
 * Whether the workspace serves what is published: not while publishing is off, which keeps the
 * publications and the site to bring them back when it is turned on again.
 */
export async function publishingOn(workspaceId: string) {
  return (await workspaceSettings(workspaceId)).publishing !== "off";
}

/** Whether the workspace lets people export its pages (Markdown, CSV, ZIP, the print view). */
export async function exportAllowed(workspaceId: string) {
  return (await workspaceSettings(workspaceId)).export !== false;
}

/**
 * Whether the user may add pages at the top of the workspace: owners and members add pages
 * everyone sees ("shared"), guests pages only they see ("private") when the workspace allows it.
 */
export async function topLevelAccess(userId: string, workspaceId: string): Promise<"shared" | "private" | null> {
  const [membership, settings] = await Promise.all([getMembership(userId, workspaceId), workspaceSettings(workspaceId)]);
  if (!membership) return null;
  if (!isGuest(membership.role)) return "shared";
  return settings.guestPrivatePages ? "private" : null;
}

export async function requireTopLevel(userId: string, workspaceId: string) {
  const access = await topLevelAccess(userId, workspaceId);
  if (!access) throw new AccessError();
  return access;
}

/** How the user arranged the sidebar in this workspace (see lib/sidebar-sections); empty when not a member. */
export async function getSidebarLayout(userId: string, workspaceId: string): Promise<SidebarLayout> {
  const [row] = await db
    .select({ sidebar: workspaceMember.sidebar })
    .from(workspaceMember)
    .where(and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, userId)));
  return cleanSidebarLayout(row?.sidebar) ?? {};
}

/**
 * Saves parts of the user's own sidebar layout in this workspace (the lists given replace theirs,
 * the others stay); nothing happens for non-members.
 */
export async function setSidebarLayout(userId: string, workspaceId: string, input: unknown) {
  const patch = cleanSidebarLayout(input);
  if (!patch) throw new Error("Not a sidebar layout");
  await db
    .update(workspaceMember)
    .set({ sidebar: sql`${workspaceMember.sidebar} || ${JSON.stringify(patch)}::jsonb` })
    .where(and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, userId)));
}

/** The member's own switch for the AI chat's memory in this workspace (see server/ai-memory.ts); null when not a member. */
export async function getMemberAiMemory(userId: string, workspaceId: string): Promise<boolean | null> {
  const [row] = await db
    .select({ aiMemory: workspaceMember.aiMemory })
    .from(workspaceMember)
    .where(and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, userId)));
  return row ? row.aiMemory : null;
}

/**
 * Whether the pages the person opens in this workspace are recorded for analytics
 * (server/page-views.ts): only for owners and members, not agents, who left it on, while the
 * workspace records views. `own` is their own switch (null when not a member), `workspace` the
 * owners' one.
 */
export async function pageViewRecording(userId: string, workspaceId: string): Promise<{ own: boolean | null; workspace: boolean; records: boolean }> {
  const [[row], settings] = await Promise.all([
    db
      .select({ role: workspaceMember.role, pageViews: workspaceMember.pageViews })
      .from(workspaceMember)
      .where(and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, userId), notAgentUser(workspaceMember.userId))),
    workspaceSettings(workspaceId),
  ]);
  const workspaceOn = settings.pageViews !== false;
  return { own: row ? row.pageViews : null, workspace: workspaceOn, records: !!row && row.role !== "guest" && row.pageViews && workspaceOn };
}

/** Sets the member's own switch for recording the pages they open in this workspace; false when not a member. */
export async function setMemberPageViews(userId: string, workspaceId: string, on: boolean): Promise<boolean> {
  const changed = await db
    .update(workspaceMember)
    .set({ pageViews: on })
    .where(and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, userId)))
    .returning({ userId: workspaceMember.userId });
  return changed.length > 0;
}

/** Sets the member's own switch for the AI chat's memory in this workspace; false when not a member. */
export async function setMemberAiMemory(userId: string, workspaceId: string, on: boolean): Promise<boolean> {
  const changed = await db
    .update(workspaceMember)
    .set({ aiMemory: on })
    .where(and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, userId)))
    .returning({ userId: workspaceMember.userId });
  return changed.length > 0;
}

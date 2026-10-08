import { and, eq, getTableColumns, ne, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { db } from "@/db";
import {
  page,
  PAGE_LEVELS,
  ssoProvider,
  workspace,
  workspaceMember,
  workspaceSso,
  type PageLevel,
  type WorkspaceRole,
} from "@/db/schema";
import { env } from "@/lib/env";
import { notAgentUser } from "@/server/agents/users";
import { INSTANCE_SSO_PROVIDER_ID, workspaceProviderId } from "@/lib/sso-config";
import { connectedAppCall, connectedAppRefusal, connectedAppsMode, type ConnectedAppCall, type ConnectedAppsMode } from "@/server/connected-app";
import { requestSession } from "@/server/request-session";

/**
 * The one place that decides who may see or change a page. Everything that reads or writes pages
 * goes through `requirePageAccess` (one page) or `pageVisibleTo` (lists, as a SQL condition).
 *
 * The rule itself is the SQL function `page_access_level` (drizzle/0003_page_permission.sql):
 * workspace members get full access unless a page permission on the page or its nearest ancestor
 * says otherwise, and anyone in the workspace can be given access to a page and its subpages.
 *
 * A workspace's sign-in policies (require two-step verification, "SSO only") also hold back the
 * browser sessions that don't meet them: `getMembership` and `resolvePageAccess` (and everything
 * built on them, so server actions and API routes alike) throw a WorkspacePolicyError
 * (TwoFactorRequiredError, SsoRequiredError) for the signed-in user of such a request. The collab
 * server checks its connections itself (collab/authorize.ts); MCP's OAuth tokens, the REST API's
 * personal access tokens (/api/v1) and SCIM tokens are outside the policies: they are credentials
 * handed to a program, revoked in Settings, not sign-ins. Lists filtered only in SQL
 * (`pageVisibleTo`) run after one of those checks, or ask `sessionHeldBack` themselves.
 *
 * Those programs answer to the workspace's connected-apps setting instead (see connected-app.ts):
 * the same checks hide a workspace whose owners turned connected apps off (AccessError, as if the
 * user weren't in it) and refuse writes where they may only read (ConnectedAppReadOnlyError).
 */

export class AccessError extends Error {
  constructor(message = "Not found or access denied") {
    super(message);
    this.name = "AccessError";
  }
}

/**
 * Which of a workspace's sign-in policies holds a session back: "require two-step verification"
 * (`two-factor`) or the "SSO only" login method (`sso`).
 */
export type PolicyHold = "two-factor" | "sso";

/**
 * The workspace's sign-in policy holds back the session serving this request. Pages send it to the
 * page where it can meet the policy (`/two-step/<id>`, `/sso-required/<id>`, see policyGatePath).
 */
export class WorkspacePolicyError extends AccessError {
  constructor(
    readonly workspaceId: string,
    readonly hold: PolicyHold,
    message: string,
  ) {
    super(message);
    this.name = "WorkspacePolicyError";
  }
}

/** The workspace requires two-step verification and the session doesn't pass it (isStrongSession). */
export class TwoFactorRequiredError extends WorkspacePolicyError {
  constructor(workspaceId: string) {
    super(workspaceId, "two-factor", "This workspace requires two-step verification");
    this.name = "TwoFactorRequiredError";
  }
}

/** Members of the workspace must sign in through its single sign-on, and this session didn't. */
export class SsoRequiredError extends WorkspacePolicyError {
  constructor(workspaceId: string) {
    super(workspaceId, "sso", "This workspace requires signing in with single sign-on");
    this.name = "SsoRequiredError";
  }
}

/**
 * The workspace lets connected apps (MCP clients, REST API tokens) only read, and this request of
 * one tried to change something. An AccessError, so whatever turns access errors away turns it away.
 */
export class ConnectedAppReadOnlyError extends AccessError {
  constructor(readonly workspaceId: string) {
    super("The owners of this workspace let connected apps only read it");
    this.name = "ConnectedAppReadOnlyError";
  }
}

export function policyError(workspaceId: string, hold: PolicyHold): WorkspacePolicyError {
  return hold === "sso" ? new SsoRequiredError(workspaceId) : new TwoFactorRequiredError(workspaceId);
}

/** What the policies look at in a browser session. */
export type SessionFacts = {
  /** Passes "require two-step verification" (see isStrongSession). */
  strong: boolean;
  /** The SSO provider the session was signed in through, if any (`session.sso_provider_id`). */
  ssoProviderId: string | null;
};

/** A workspace's policy settings and whether its SSO is usable: what `policyHold` decides on. */
export type PolicyState = {
  role: WorkspaceRole;
  requireTwoFactor: boolean;
  loginMethod: "any" | "sso";
  /** The workspace has an SSO connection with verified domains. */
  hasConnection: boolean;
  /** The instance-wide provider is configured (OIDC_ISSUER…). */
  instanceSso: boolean;
};

/**
 * Pure: whether the policies hold back a session. Two-step applies to everyone in the workspace,
 * guests too. "SSO only" applies to members: owners keep their other ways in (a broken identity
 * provider must not lock the workspace), and guests come from outside the organization. A session
 * counts when it came through the workspace's own connection or the instance provider. While
 * neither exists the policy has nothing to send people to, so it holds nobody back.
 */
export function policyHold(state: PolicyState, facts: SessionFacts, workspaceId: string): PolicyHold | null {
  if (state.requireTwoFactor && !facts.strong) return "two-factor";
  if (state.loginMethod !== "sso" || state.role !== "member") return null;
  if (!state.hasConnection && !state.instanceSso) return null;
  const provider = facts.ssoProviderId;
  if (provider && state.hasConnection && provider === workspaceProviderId(workspaceId)) return null;
  if (provider === INSTANCE_SSO_PROVIDER_ID && state.instanceSso) return null;
  return "sso";
}

/** The workspace's policy state for `userId`, or null when they don't belong to it. */
export async function policyStateOf(userId: string, workspaceId: string): Promise<PolicyState | null> {
  const [row] = await db
    .select({
      role: workspaceMember.role,
      requireTwoFactor: sql<boolean>`coalesce((${workspace.settings}->>'requireTwoFactor')::boolean, false)`,
      loginMethod: sql<string | null>`${workspace.settings}->>'loginMethod'`,
      hasConnection: sql<boolean>`exists (
        select 1 from ${workspaceSso} c join ${ssoProvider} p on p.provider_id = c.provider_id
        where c.workspace_id = ${workspace.id} and coalesce(p.domain_verified, false))`,
    })
    .from(workspaceMember)
    .innerJoin(workspace, eq(workspace.id, workspaceMember.workspaceId))
    .where(and(eq(workspaceMember.userId, userId), eq(workspaceMember.workspaceId, workspaceId)))
    .limit(1);
  if (!row) return null;
  return {
    role: row.role,
    requireTwoFactor: row.requireTwoFactor === true,
    loginMethod: row.loginMethod === "sso" ? "sso" : "any",
    hasConnection: row.hasConnection === true,
    instanceSso: env.instanceOidc !== null,
  };
}

/**
 * The policy holding back `userId`'s session with these facts in the workspace, or null (also when
 * they don't belong to it: their own access checks turn them away without learning its policy).
 */
export async function policyHoldFor(userId: string, workspaceId: string, facts: SessionFacts): Promise<PolicyHold | null> {
  const state = await policyStateOf(userId, workspaceId);
  return state ? policyHold(state, facts, workspaceId) : null;
}

/**
 * Which policy holds back the browser session serving this request, when it belongs to `userId`.
 * Null outside requests, for requests a connected app's token authenticated (they answer to
 * connectedAppHold), for other users (checks on someone else's behalf, like who a page is shared
 * with) and for sessions that pass. Asked once per request and workspace.
 */
export async function sessionHold(userId: string, workspaceId: string): Promise<PolicyHold | null> {
  if (connectedAppCall(userId)) return null;
  const current = await requestSession();
  if (!current || current.userId !== userId) return null;
  let held = current.heldBack.get(workspaceId);
  if (!held) {
    held = policyHoldFor(userId, workspaceId, current);
    current.heldBack.set(workspaceId, held);
  }
  return held;
}

/** The workspace's connected-apps setting, asked once per request. */
function appsModeOf(call: ConnectedAppCall, workspaceId: string): Promise<ConnectedAppsMode> {
  let mode = call.modes.get(workspaceId);
  if (!mode) {
    mode = db
      .select({ mode: sql<string | null>`${workspace.settings}->>'connectedApps'` })
      .from(workspace)
      .where(eq(workspace.id, workspaceId))
      .limit(1)
      .then(([row]) => connectedAppsMode(row?.mode));
    call.modes.set(workspaceId, mode);
  }
  return mode;
}

/**
 * What the workspace's connected-apps setting does to this request (see connectedAppRefusal): null
 * outside connected-app requests and for checks on behalf of someone other than the app's user.
 */
export async function connectedAppHold(userId: string, workspaceId: string): Promise<"hidden" | "readOnly" | null> {
  const call = connectedAppCall(userId);
  return call ? connectedAppRefusal(await appsModeOf(call, workspaceId), call.writing) : null;
}

/**
 * Of the user's workspaces, the ones hidden from the connected app serving this request (owners
 * turned connected apps off); none outside connected-app requests. For lists across workspaces.
 */
export async function workspacesHiddenFromApp(userId: string): Promise<Set<string>> {
  const call = connectedAppCall(userId);
  if (!call) return new Set();
  const rows = await db
    .select({ id: workspace.id })
    .from(workspaceMember)
    .innerJoin(workspace, eq(workspace.id, workspaceMember.workspaceId))
    .where(and(eq(workspaceMember.userId, userId), sql`${workspace.settings}->>'connectedApps' = 'off'`));
  return new Set(rows.map((r) => r.id));
}

/**
 * Whether a workspace policy holds back this request: a sign-in policy its session doesn't meet
 * (see sessionHold), or the connected-apps setting (see connectedAppHold).
 */
export async function sessionHeldBack(userId: string, workspaceId: string): Promise<boolean> {
  return (await sessionHold(userId, workspaceId)) !== null || (await connectedAppHold(userId, workspaceId)) !== null;
}

export async function enforceWorkspacePolicy(userId: string, workspaceId: string) {
  const hold = await sessionHold(userId, workspaceId);
  if (hold) throw policyError(workspaceId, hold);
  const app = await connectedAppHold(userId, workspaceId);
  if (app === "hidden") throw new AccessError();
  if (app === "readOnly") throw new ConnectedAppReadOnlyError(workspaceId);
}


/**
 * The policy error of the first of these workspaces whose sign-in policy holds back the browser
 * session of this request (see sessionHold), or null. For handing out credentials that reach those
 * workspaces outside the sign-in policies (API tokens): a session that may not see a workspace
 * can't open another way into it.
 */
export async function signInPolicyRefusal(userId: string, workspaceIds: Iterable<string>): Promise<WorkspacePolicyError | null> {
  for (const workspaceId of new Set(workspaceIds)) {
    const hold = await sessionHold(userId, workspaceId);
    if (hold) return policyError(workspaceId, hold);
  }
  return null;
}

/**
 * The first of the user's workspaces whose sign-in policies hold back a session with these facts,
 * or null: an app the user connects reaches all of them, so any one holding the session back
 * keeps it from connecting one.
 */
export async function firstPolicyHold(userId: string, facts: SessionFacts): Promise<{ workspaceId: string; hold: PolicyHold } | null> {
  for (const workspaceId of await memberWorkspaceIds(userId)) {
    const hold = await policyHoldFor(userId, workspaceId, facts);
    if (hold) return { workspaceId, hold };
  }
  return null;
}

/** Of these workspace ids, the ones whose policies hold back this request (see sessionHeldBack). */
export async function workspacesHeldBack(userId: string, workspaceIds: Iterable<string>): Promise<Set<string>> {
  const ids = [...new Set(workspaceIds)];
  const held = await Promise.all(ids.map((id) => sessionHeldBack(userId, id)));
  return new Set(ids.filter((_, i) => held[i]));
}

/**
 * - `view`: read the page, its history and, for databases, its rows and schema.
 * - `comment`: also comment on it (see server/comments.ts).
 * - `edit`: change content, title, icon, properties, rows, views; move or trash it.
 * - `full`: also delete it for good (and, later, change who it is shared with).
 */
export type AccessLevel = PageLevel;
export type RequiredLevel = Exclude<AccessLevel, "none">;

const rank = (level: AccessLevel) => PAGE_LEVELS.indexOf(level);

export const hasLevel = (level: AccessLevel, needed: RequiredLevel) => rank(level) >= rank(needed);

/** The rank `page_access_level` returns for full access, for SQL that looks for it. */
export const FULL_RANK = rank("full");

/** The level `page_access_level` returns (0–4) as a name; anything unexpected is `none`. */
export const levelFromRank = (value: unknown): AccessLevel => PAGE_LEVELS[Number(value)] ?? "none";

/** SQL: the user's access rank (0–4) on a page id expression. */
export const accessRank = (userId: string, pageId: SQL) => sql<number>`page_access_level(${userId}, ${pageId})`;

/**
 * The user's role in the workspace, or null. Throws a WorkspacePolicyError when one of the
 * workspace's sign-in policies holds back the session of this request (see `findMembership`).
 */
export async function getMembership(userId: string, workspaceId: string) {
  const membership = await findMembership(userId, workspaceId);
  if (membership) await enforceWorkspacePolicy(userId, workspaceId);
  return membership;
}

/**
 * The role, without the sign-in policies: for the policies themselves and the pages that send people
 * to meet them, and for questions about someone's standing rather than the request's session.
 */
export async function findMembership(userId: string, workspaceId: string) {
  const [row] = await db
    .select({ role: workspaceMember.role })
    .from(workspaceMember)
    .where(and(eq(workspaceMember.userId, userId), eq(workspaceMember.workspaceId, workspaceId)))
    .limit(1);
  return row ?? null;
}

/** Anyone in the workspace, guests included: for reads that filter pages by `pageVisibleTo`. */
export async function requireMembership(userId: string, workspaceId: string, role?: WorkspaceRole) {
  const membership = await getMembership(userId, workspaceId);
  if (!membership || (role && membership.role !== role)) throw new AccessError();
  return membership;
}

export const isGuest = (role: WorkspaceRole) => role === "guest";

/** The workspace's owners: who decides join requests (server/join-requests.ts) and hears about them. */
export async function workspaceOwnerIds(workspaceId: string): Promise<string[]> {
  const rows = await db
    .select({ id: workspaceMember.userId })
    .from(workspaceMember)
    .where(and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.role, "owner"), notAgentUser(workspaceMember.userId)));
  return rows.map((row) => row.id);
}

/**
 * Every workspace the user is in, whatever their role and whatever a connected app may see: where
 * the audit log records what reaches all of them (an app they connected, an API token for all
 * their workspaces, see server/audit.ts).
 */
export async function memberWorkspaceIds(userId: string): Promise<string[]> {
  const rows = await db.select({ id: workspaceMember.workspaceId }).from(workspaceMember).where(eq(workspaceMember.userId, userId));
  return rows.map((row) => row.id);
}

/** SQL: whether the user owns the workspace (an id expression), for filters inside larger queries. */
export const ownsWorkspace = (userId: string, workspaceId: SQL | AnyColumn) =>
  sql<boolean>`exists (select 1 from ${workspaceMember} wm where wm.workspace_id = ${workspaceId} and wm.user_id = ${userId} and wm.role = 'owner')`;

/**
 * An owner or member, not a guest: for creating top-level pages and for seeing who is in the
 * workspace. Must match the roles `page_access_level` gives workspace-wide access to.
 */
export async function requireMember(userId: string, workspaceId: string) {
  const membership = await requireMembership(userId, workspaceId);
  if (isGuest(membership.role)) throw new AccessError();
  return membership;
}

/**
 * The page and the user's access to it; `none` when it doesn't exist or they may not see it. Throws
 * a WorkspacePolicyError when they may, but a sign-in policy of the workspace holds back the session
 * of this request (see `pageAccessOf`).
 */
export async function resolvePageAccess(userId: string, pageId: string) {
  const resolved = await pageAccessOf(userId, pageId);
  if (resolved.page && resolved.level !== "none") await enforceWorkspacePolicy(userId, resolved.page.workspaceId);
  return resolved;
}

/**
 * The page and someone's access to it, without the sign-in policies: what a user's standing allows
 * (a form publisher's, say), not what the request's session may do.
 */
export async function pageAccessOf(userId: string, pageId: string) {
  const [row] = await db
    .select({ ...getTableColumns(page), level: accessRank(userId, sql`${page.id}`) })
    .from(page)
    .where(eq(page.id, pageId))
    .limit(1);
  if (!row) return { page: null, level: "none" as AccessLevel };
  const { level, ...found } = row;
  return { page: found, level: levelFromRank(level) };
}

/**
 * Loads a page the user may access at `needed` level. Throws AccessError otherwise, the same way
 * whether the page is missing or just not theirs, so its existence never leaks.
 */
export async function requirePageAccess(userId: string, pageId: string, needed: RequiredLevel) {
  const { page: found, level } = await resolvePageAccess(userId, pageId);
  if (!found || !hasLevel(level, needed)) throw new AccessError();
  return found;
}

/**
 * Everyone in the workspace with full access to the page (the people who can share it), but
 * `except`: who hears about a request for access to it.
 */
export async function peopleWithFullAccess(workspaceId: string, pageId: string, except?: string): Promise<string[]> {
  const rows = await db
    .select({ userId: workspaceMember.userId })
    .from(workspaceMember)
    .where(
      and(
        eq(workspaceMember.workspaceId, workspaceId),
        except ? ne(workspaceMember.userId, except) : undefined,
        // Agents never get full access; should one have it, it still isn't asked.
        notAgentUser(workspaceMember.userId),
        sql`page_access_level(${workspaceMember.userId}, ${pageId}) = ${FULL_RANK}`,
      ),
    );
  return rows.map((r) => r.userId);
}

/**
 * SQL: someone's role in a workspace, or null when they aren't in it; for lists that say whether
 * a person is in the workspace (an access request's requester, say). Both are SQL expressions.
 */
export const workspaceRoleOf = (userId: SQL | AnyColumn, workspaceId: SQL | AnyColumn) =>
  sql<WorkspaceRole | null>`(select wm.role from ${workspaceMember} wm where wm.workspace_id = ${workspaceId} and wm.user_id = ${userId})`;

/**
 * SQL condition: the user can at least view the page. Pass the alias when the page table is
 * aliased in a raw query (`from page p` → "p").
 */
export function pageVisibleTo(userId: string, alias?: string): SQL {
  return sql`${accessRank(userId, pageIdColumn(alias))} > 0`;
}

/** The page id column, or `alias.id` in raw queries. */
export function pageIdColumn(alias?: string): SQL {
  if (alias !== undefined && !/^[a-z_]+$/.test(alias)) throw new Error(`Bad table alias: ${alias}`);
  return alias ? sql.raw(`"${alias}"."id"`) : sql`${page.id}`;
}

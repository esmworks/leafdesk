import { and, asc, count, desc, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  memberGroup,
  memberGroupMember,
  scimGroup,
  scimIdentity,
  scimToken,
  ssoProvider,
  user,
  workspaceMember,
  workspaceSso,
} from "@/db/schema";
import { cleanName } from "@/lib/account";
import { isAgentEmail } from "@/lib/agents";
import { CLIENT_IP_HEADER } from "@/lib/client-ip";
import { env } from "@/lib/env";
import { sharedLimiter } from "@/lib/rate-limit";
import {
  applyGroupPatch,
  changesFromPatch,
  changesFromResource,
  emailOfResource,
  groupFromResource,
  groupResource,
  listResponse,
  pageOf,
  parseGroupFilter,
  parseUserFilter,
  resourceTypes,
  schemaResources,
  SCIM_CONTENT_TYPE,
  ScimError,
  serviceProviderConfig,
  userResource,
  wantsMembers,
  type GroupState,
  type ScimGroupRecord,
  type ScimUserRecord,
  type UserChanges,
} from "@/lib/scim";
import { domainsFromColumn, emailInDomains } from "@/lib/sso-config";
import { AccessError, isGuest, requireMembership } from "@/server/access";
import { notAgentUser } from "@/server/agents/users";
import { generateTokenSecret, hashToken } from "@/server/api/tokens";
import { recordAudit, runAsAuditOrigin } from "@/server/audit";
import { changeGroup, createGroup, deleteGroup, GroupError } from "@/server/groups";
import { joinAsMember, oldestOwner, removeMemberByProvider, WorkspaceError } from "@/server/workspaces";

/**
 * SCIM 2.0 provisioning (/scim/v2): a workspace's identity provider adds people to the workspace,
 * deactivates them (they leave it) and removes them, with a SCIM token an owner created in Settings
 * > Security. The token is the workspace's, not a person's: like API tokens it is outside the
 * workspaces' sign-in policies, and only its SHA-256 hash is stored.
 *
 * Users are the workspace's owners and members, plus the people its provider deactivated (kept
 * with `active: false` so it can turn them back on). The SCIM id is the account id. New accounts
 * are created only for addresses in the workspace's verified SSO domains; anyone else must already
 * have an account. Guests aren't listed; provisioning one makes them a member. Owners can't be
 * deactivated or removed over SCIM, so a provider can't take a workspace away from its owners.
 *
 * Groups are the workspace's member groups (Settings > Groups), all of them, whoever created them.
 * Their members are SCIM user ids of the workspace's owners and members; guests and anyone else are
 * refused (400 invalidValue). Changes go through server/groups.ts like the settings' do, so access,
 * open editors and stranded pages are handled the same way. The token has no person behind it, so
 * the workspace's oldest owner (who also inherits what a deprovisioned member leaves) acts for it:
 * pages only a group could manage pass to them when the provider takes people out or deletes it,
 * and groups the provider creates are recorded as created by them. `scim_group` keeps the
 * provider's externalId and marks the group as provisioned.
 */

export const SCIM_PREFIX = "/scim/v2";
export const SCIM_TOKEN_PREFIX = "scim_";
export const SCIM_TOKEN_PATTERN = /^scim_[A-Za-z0-9]{40}$/;
export const MAX_SCIM_TOKENS = 20;
export const MAX_SCIM_TOKEN_NAME = 100;
/** Requests per token per minute. */
export const SCIM_RATE_LIMIT = 600;
const TOUCH_INTERVAL_MS = 60_000;
const MAX_BODY_BYTES = 1024 * 1024;

export class ScimTokenError extends Error {
  constructor(
    message: string,
    readonly code: "name" | "limit",
  ) {
    super(message);
    this.name = "ScimTokenError";
  }
}

// ------------------------------------------------------------------------------------------ tokens

export type ScimTokenInfo = { id: string; name: string; prefix: string; createdAt: Date; lastUsedAt: Date | null };

/** Creates a SCIM token for the workspace and returns its secret, shown once. Owners only. */
export async function createScimToken(actorId: string, workspaceId: string, name: string) {
  await requireMembership(actorId, workspaceId, "owner");
  const clean = name.trim();
  if (!clean || clean.length > MAX_SCIM_TOKEN_NAME) {
    throw new ScimTokenError(`Give the token a name of at most ${MAX_SCIM_TOKEN_NAME} characters`, "name");
  }
  const [{ n }] = await db.select({ n: count() }).from(scimToken).where(eq(scimToken.workspaceId, workspaceId));
  if (n >= MAX_SCIM_TOKENS) throw new ScimTokenError(`A workspace can have at most ${MAX_SCIM_TOKENS} SCIM tokens`, "limit");
  const secret = SCIM_TOKEN_PREFIX + generateTokenSecret().slice(4);
  const [row] = await db
    .insert(scimToken)
    .values({ workspaceId, name: clean, prefix: secret.slice(0, SCIM_TOKEN_PREFIX.length + 4), tokenHash: hashToken(secret), createdBy: actorId })
    .returning({ id: scimToken.id, name: scimToken.name, prefix: scimToken.prefix, createdAt: scimToken.createdAt, lastUsedAt: scimToken.lastUsedAt });
  await recordAudit({ workspaceId, actorId, action: "scim.token_created", target: { type: "scim_token", id: row.id, label: row.name } });
  return { secret, token: row as ScimTokenInfo };
}

export async function listScimTokens(actorId: string, workspaceId: string): Promise<ScimTokenInfo[]> {
  await requireMembership(actorId, workspaceId, "owner");
  return db
    .select({ id: scimToken.id, name: scimToken.name, prefix: scimToken.prefix, createdAt: scimToken.createdAt, lastUsedAt: scimToken.lastUsedAt })
    .from(scimToken)
    .where(eq(scimToken.workspaceId, workspaceId))
    .orderBy(desc(scimToken.createdAt));
}

export async function revokeScimToken(actorId: string, workspaceId: string, tokenId: string) {
  await requireMembership(actorId, workspaceId, "owner");
  const deleted = await db
    .delete(scimToken)
    .where(and(eq(scimToken.id, tokenId), eq(scimToken.workspaceId, workspaceId)))
    .returning({ id: scimToken.id, name: scimToken.name });
  for (const token of deleted) {
    await recordAudit({ workspaceId, actorId, action: "scim.token_revoked", target: { type: "scim_token", id: token.id, label: token.name } });
  }
  return deleted.length > 0;
}

/** The workspace and token a presented secret belongs to, or null. Records its use (once a minute). */
export async function verifyScimToken(secret: string, now = new Date()) {
  if (!SCIM_TOKEN_PATTERN.test(secret)) return null;
  const [row] = await db.select().from(scimToken).where(eq(scimToken.tokenHash, hashToken(secret))).limit(1);
  if (!row) return null;
  if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() >= TOUCH_INTERVAL_MS) {
    await db.update(scimToken).set({ lastUsedAt: now }).where(eq(scimToken.id, row.id));
  }
  return { tokenId: row.id, workspaceId: row.workspaceId };
}

// ------------------------------------------------------------------------------------------- users

/** Verified SSO domains of the workspace: SCIM creates accounts and renames people only there. */
async function verifiedDomains(workspaceId: string) {
  const [row] = await db
    .select({ domain: ssoProvider.domain })
    .from(workspaceSso)
    .innerJoin(ssoProvider, eq(ssoProvider.providerId, workspaceSso.providerId))
    .where(and(eq(workspaceSso.workspaceId, workspaceId), eq(ssoProvider.domainVerified, true)))
    .limit(1);
  return domainsFromColumn(row?.domain);
}

const inScope = (workspaceId: string) =>
  and(
    notAgentUser(user.id),
    or(
      sql`exists (select 1 from ${workspaceMember} m where m.workspace_id = ${workspaceId} and m.user_id = ${user.id} and m.role in ('owner', 'member'))`,
      sql`exists (select 1 from ${scimIdentity} i where i.workspace_id = ${workspaceId} and i.user_id = ${user.id})`,
    ),
  );

/** Users of the workspace as SCIM sees them (see the note at the top), optionally only some ids. */
async function records(workspaceId: string, where?: ReturnType<typeof sql>, page?: { offset: number; limit: number }) {
  const query = db
    .select({
      id: user.id,
      email: user.email,
      name: user.name,
      userCreated: user.createdAt,
      userUpdated: user.updatedAt,
      role: sql<string | null>`(select m.role from ${workspaceMember} m where m.workspace_id = ${workspaceId} and m.user_id = ${user.id})`,
      externalId: sql<string | null>`(select i.external_id from ${scimIdentity} i where i.workspace_id = ${workspaceId} and i.user_id = ${user.id})`,
      identityUpdated: sql<Date | null>`(select i.updated_at from ${scimIdentity} i where i.workspace_id = ${workspaceId} and i.user_id = ${user.id})`,
    })
    .from(user)
    .where(and(inScope(workspaceId), where))
    .orderBy(user.createdAt, user.id);
  const rows = page ? await query.offset(page.offset).limit(page.limit) : await query;
  return rows.map(
    (r): ScimUserRecord & { role: string | null } => ({
      id: r.id,
      email: r.email,
      name: r.name,
      role: r.role,
      active: r.role === "owner" || r.role === "member",
      externalId: r.externalId,
      created: new Date(r.userCreated),
      lastModified: new Date(
        Math.max(new Date(r.userUpdated).getTime(), r.identityUpdated ? new Date(r.identityUpdated).getTime() : 0),
      ),
    }),
  );
}

function filterSql(filter: ReturnType<typeof parseUserFilter>) {
  if (!filter) return undefined;
  switch (filter.attribute) {
    case "userName":
    case "emails.value":
      return sql`lower(${user.email}) = ${filter.value.trim().toLowerCase()}`;
    case "id":
      return eq(user.id, filter.value);
    case "externalId":
      return sql`exists (select 1 from ${scimIdentity} i where i.user_id = ${user.id} and i.external_id = ${filter.value})`;
  }
}

async function listUsers(workspaceId: string, params: URLSearchParams, baseUrl: string) {
  const filter = parseUserFilter(params.get("filter"));
  const { startIndex, count: size } = pageOf(params);
  const where = filterSql(filter);
  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(user)
    .where(and(inScope(workspaceId), where));
  const rows = size > 0 ? await records(workspaceId, where, { offset: startIndex - 1, limit: size }) : [];
  return listResponse(
    rows.map((r) => userResource(r, baseUrl)),
    Number(total),
    startIndex,
  );
}

async function findRecord(workspaceId: string, id: string) {
  const [row] = await records(workspaceId, eq(user.id, id));
  if (!row) throw new ScimError(404, `User ${id} not found.`);
  return row;
}

async function setIdentity(workspaceId: string, userId: string, fields: { active: boolean; externalId?: string | null }) {
  await db
    .insert(scimIdentity)
    .values({ workspaceId, userId, active: fields.active, externalId: fields.externalId ?? null })
    .onConflictDoUpdate({
      target: [scimIdentity.workspaceId, scimIdentity.userId],
      set: { active: fields.active, updatedAt: new Date(), ...(fields.externalId !== undefined ? { externalId: fields.externalId } : {}) },
    });
}

/**
 * Applies what a request asks for: membership follows `active` (owners stay), the external id is
 * kept, and the name changes only for addresses in the workspace's verified domains.
 */
async function applyChanges(workspaceId: string, record: { id: string; email: string; role: string | null }, changes: UserChanges) {
  if (changes.active === false && record.role === "owner") {
    throw new ScimError(400, "Workspace owners can't be deactivated over SCIM; change their role in the app first.", "mutability");
  }
  if (changes.active === true && record.role !== "owner" && record.role !== "member") {
    if (record.role === "guest") await promoteGuest(workspaceId, record.id);
    else await joinAsMember(workspaceId, record.id, record.email, "scim");
  }
  if (changes.active === false && record.role === "member") await removeMemberByProvider(workspaceId, record.id);
  const active = changes.active ?? (record.role === "owner" || record.role === "member");
  await setIdentity(workspaceId, record.id, { active, externalId: changes.externalId });
  if (changes.name && emailInDomains(record.email, await verifiedDomains(workspaceId))) {
    const clean = cleanName(changes.name);
    if (clean.ok) await db.update(user).set({ name: clean.name }).where(eq(user.id, record.id));
  }
}

async function promoteGuest(workspaceId: string, userId: string) {
  const promoted = await db
    .update(workspaceMember)
    .set({ role: "member" })
    .where(and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, userId), eq(workspaceMember.role, "guest")))
    .returning({ userId: workspaceMember.userId });
  if (promoted.length) {
    await recordAudit({
      workspaceId,
      actorId: null,
      action: "member.role_changed",
      target: { type: "user", id: userId },
      details: { from: "guest", to: "member", via: "scim" },
    });
  }
}

async function createUser(workspaceId: string, resource: Record<string, unknown>) {
  const email = emailOfResource(resource);
  if (!email) throw new ScimError(400, "userName (or a primary email) must be an email address.", "invalidValue");
  // Agents' users are no people an identity provider manages.
  if (isAgentEmail(email)) throw new ScimError(400, `${email} belongs to an agent, not a person.`, "invalidValue");
  const changes = changesFromResource(resource);
  const [existing] = await db
    .select({ id: user.id })
    .from(user)
    .where(and(sql`lower(${user.email}) = ${email}`, notAgentUser(user.id)))
    .limit(1);
  let userId = existing?.id;
  if (userId) {
    const [known] = await records(workspaceId, eq(user.id, userId));
    if (known) throw new ScimError(409, `${email} is already provisioned in this workspace.`, "uniqueness");
  } else {
    if (!emailInDomains(email, await verifiedDomains(workspaceId))) {
      throw new ScimError(
        400,
        `No account uses ${email}. SCIM creates accounts only for the workspace's verified single sign-on domains.`,
        "invalidValue",
      );
    }
    const clean = cleanName(changes.name ?? email.split("@")[0]);
    userId = crypto.randomUUID();
    await db.insert(user).values({ id: userId, email, name: clean.ok ? clean.name : email.split("@")[0], emailVerified: true });
  }
  const [membership] = await db
    .select({ role: workspaceMember.role })
    .from(workspaceMember)
    .where(and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, userId)))
    .limit(1);
  await applyChanges(workspaceId, { id: userId, email, role: membership?.role ?? null }, { active: true, ...changes, name: existing ? undefined : changes.name });
  return findRecord(workspaceId, userId);
}

async function deleteUser(workspaceId: string, id: string) {
  const record = await findRecord(workspaceId, id);
  if (record.role === "owner") {
    throw new ScimError(400, "Workspace owners can't be removed over SCIM; change their role in the app first.", "mutability");
  }
  if (record.role === "member") await removeMemberByProvider(workspaceId, id);
  await db.delete(scimIdentity).where(and(eq(scimIdentity.workspaceId, workspaceId), eq(scimIdentity.userId, id)));
}

// ------------------------------------------------------------------------------------------ groups

/**
 * Who acts for the token on groups: the workspace's oldest owner (see the note at the top). A
 * workspace always has an owner; this only fails for one being deleted.
 */
async function groupActor(workspaceId: string) {
  const owner = await oldestOwner(db, workspaceId);
  if (!owner) throw new ScimError(409, "The workspace has no owner to act for the SCIM token.");
  return owner;
}

/** Groups of the workspace as SCIM sees them, optionally only some, a page at a time. */
async function groupRecords(
  workspaceId: string,
  where?: ReturnType<typeof sql>,
  page?: { offset: number; limit: number },
  withMembers = true,
): Promise<ScimGroupRecord[]> {
  const query = db
    .select({
      id: memberGroup.id,
      name: memberGroup.name,
      createdAt: memberGroup.createdAt,
      updatedAt: memberGroup.updatedAt,
      externalId: scimGroup.externalId,
      scimUpdated: scimGroup.updatedAt,
    })
    .from(memberGroup)
    .leftJoin(scimGroup, eq(scimGroup.groupId, memberGroup.id))
    .where(and(eq(memberGroup.workspaceId, workspaceId), where))
    .orderBy(asc(memberGroup.createdAt), asc(memberGroup.id));
  const groups = page ? await query.offset(page.offset).limit(page.limit) : await query;
  const people =
    withMembers && groups.length
      ? await db
          .select({ groupId: memberGroupMember.groupId, id: user.id, name: user.name })
          .from(memberGroupMember)
          .innerJoin(user, eq(user.id, memberGroupMember.userId))
          .where(inArray(memberGroupMember.groupId, groups.map((g) => g.id)))
          .orderBy(asc(user.name), asc(user.id))
      : [];
  return groups.map((g) => ({
    id: g.id,
    displayName: g.name,
    externalId: g.externalId,
    members: people.filter((p) => p.groupId === g.id).map(({ id, name }) => ({ id, name })),
    created: new Date(g.createdAt),
    lastModified: new Date(Math.max(new Date(g.updatedAt).getTime(), g.scimUpdated ? new Date(g.scimUpdated).getTime() : 0)),
  }));
}

function groupFilterSql(filter: ReturnType<typeof parseGroupFilter>) {
  if (!filter) return undefined;
  switch (filter.attribute) {
    case "displayName":
      // Names are unique ignoring case, and stored with whitespace collapsed.
      return sql`lower(${memberGroup.name}) = ${filter.value.replace(/\s+/g, " ").trim().toLowerCase()}`;
    case "id":
      return eq(memberGroup.id, filter.value);
    case "externalId":
      return sql`exists (select 1 from ${scimGroup} s where s.group_id = ${memberGroup.id} and s.external_id = ${filter.value})`;
  }
}

async function listGroupResources(workspaceId: string, params: URLSearchParams, baseUrl: string) {
  const where = groupFilterSql(parseGroupFilter(params.get("filter")));
  const { startIndex, count: size } = pageOf(params);
  const withMembers = wantsMembers(params);
  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(memberGroup)
    .where(and(eq(memberGroup.workspaceId, workspaceId), where));
  const rows = size > 0 ? await groupRecords(workspaceId, where, { offset: startIndex - 1, limit: size }, withMembers) : [];
  return listResponse(
    rows.map((r) => groupResource(r, baseUrl, withMembers)),
    Number(total),
    startIndex,
  );
}

/** The group, when it is this workspace's; 404 otherwise, whether it is missing or another's. */
async function findGroup(workspaceId: string, id: string) {
  const [row] = await groupRecords(workspaceId, eq(memberGroup.id, id));
  if (!row) throw new ScimError(404, `Group ${id} not found.`);
  return row;
}

/** 400 invalidValue unless every id is an owner or member of the workspace (guests can't be in groups). */
async function requireGroupableUsers(workspaceId: string, ids: string[]) {
  if (!ids.length) return;
  const rows = await db
    .select({ userId: workspaceMember.userId, role: workspaceMember.role })
    .from(workspaceMember)
    .where(and(eq(workspaceMember.workspaceId, workspaceId), inArray(workspaceMember.userId, ids)));
  const allowed = new Set(rows.filter((r) => !isGuest(r.role)).map((r) => r.userId));
  const refused = ids.filter((id) => !allowed.has(id));
  if (refused.length) {
    const shown = refused.slice(0, 5).join(", ") + (refused.length > 5 ? `, and ${refused.length - 5} more` : "");
    throw new ScimError(
      400,
      `Group members must be active owners or members of the workspace (guests can't be in groups). Not one: ${shown}.`,
      "invalidValue",
    );
  }
}

async function setGroupIdentity(workspaceId: string, groupId: string, externalId: string | null | undefined) {
  await db
    .insert(scimGroup)
    .values({ groupId, workspaceId, externalId: externalId ?? null })
    .onConflictDoUpdate({
      target: scimGroup.groupId,
      set: { updatedAt: new Date(), ...(externalId !== undefined ? { externalId } : {}) },
    });
}

async function createGroupResource(workspaceId: string, resource: Record<string, unknown>) {
  const wanted = groupFromResource(resource);
  if (!wanted.displayName) throw new ScimError(400, "A group needs a displayName.", "invalidValue");
  const members = wanted.members ?? [];
  await requireGroupableUsers(workspaceId, members);
  const created = await createGroup(await groupActor(workspaceId), workspaceId, wanted.displayName, members);
  await setGroupIdentity(workspaceId, created.id, wanted.externalId ?? null);
  return findGroup(workspaceId, created.id);
}

/**
 * Saves a group as `next` asks: the new name, the members added and taken out (in one
 * transaction, server/groups.ts changeGroup), and the provider's externalId.
 */
async function saveGroup(workspaceId: string, current: ScimGroupRecord, next: GroupState) {
  const before = new Set(current.members.map((m) => m.id));
  const after = new Set(next.members);
  const add = next.members.filter((id) => !before.has(id));
  const remove = [...before].filter((id) => !after.has(id));
  await requireGroupableUsers(workspaceId, add);
  await changeGroup(await groupActor(workspaceId), current.id, {
    name: next.displayName !== current.displayName ? next.displayName : undefined,
    add,
    remove,
  });
  await setGroupIdentity(workspaceId, current.id, next.externalId);
}

const stateOf = (record: ScimGroupRecord): GroupState => ({
  displayName: record.displayName,
  externalId: record.externalId,
  members: record.members.map((m) => m.id),
});

/**
 * PUT replaces the name, and the members and externalId when it sends them: RFC 7644 §3.5.1 lets a
 * server keep attributes a replace leaves out, and emptying a group because a client left
 * `members` out would take access away by accident. `members: []` empties it.
 */
async function replaceGroup(workspaceId: string, id: string, resource: Record<string, unknown>) {
  const current = await findGroup(workspaceId, id);
  const wanted = groupFromResource(resource);
  if (!wanted.displayName) throw new ScimError(400, "A group needs a displayName.", "invalidValue");
  await saveGroup(workspaceId, current, { ...stateOf(current), ...wanted });
}

async function patchGroup(workspaceId: string, id: string, body: Record<string, unknown>) {
  const current = await findGroup(workspaceId, id);
  await saveGroup(workspaceId, current, applyGroupPatch(stateOf(current), body));
}

async function deleteGroupResource(workspaceId: string, id: string) {
  const current = await findGroup(workspaceId, id);
  await deleteGroup(await groupActor(workspaceId), current.id);
}

// ------------------------------------------------------------------------------------------- HTTP

function scimJson(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": `${SCIM_CONTENT_TYPE}; charset=utf-8`, "Cache-Control": "no-store", ...headers },
  });
}

const errorResponse = (error: ScimError, headers: Record<string, string> = {}) => scimJson(error.status, error.body(), headers);

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw new ScimError(413, "The request body is too large.");
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {}
  throw new ScimError(400, "The request body must be a JSON object.", "invalidSyntax");
}

/** Every /scim/v2 request (route: src/app/scim/v2/[[...path]]/route.ts). */
export async function handleScimRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const baseUrl = `${env.appUrl}${SCIM_PREFIX}`;
  const path = (url.pathname.startsWith(SCIM_PREFIX) ? url.pathname.slice(SCIM_PREFIX.length) : url.pathname).replace(/\/+$/, "") || "/";
  const method = request.method.toUpperCase();

  const secret = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  const principal = secret ? await verifyScimToken(secret) : null;
  if (!principal) {
    return errorResponse(new ScimError(401, "Send a SCIM token from Settings > Security: Authorization: Bearer scim_…"), {
      "WWW-Authenticate": 'Bearer realm="leafdesk-scim"',
    });
  }
  const limiter = sharedLimiter("scim", SCIM_RATE_LIMIT, 60_000);
  const wait = limiter.retryAfter(principal.tokenId);
  if (wait > 0) return errorResponse(new ScimError(429, "Too many requests."), { "Retry-After": String(Math.ceil(wait / 1000)) });
  limiter.hit(principal.tokenId);
  // What the request changes is recorded as the identity provider's, through this token.
  const origin = {
    kind: "scim" as const,
    tokenId: principal.tokenId,
    ip: request.headers.get(CLIENT_IP_HEADER),
    userAgent: request.headers.get("user-agent"),
  };
  return runAsAuditOrigin(origin, () => serveScim(request, principal.workspaceId, { url, baseUrl, path, method }));
}

/** An authenticated SCIM request of the workspace's identity provider. */
async function serveScim(
  request: Request,
  workspaceId: string,
  { url, baseUrl, path, method }: { url: URL; baseUrl: string; path: string; method: string },
): Promise<Response> {
  try {
    const [, collection, id, ...rest] = path.split("/");
    if (rest.length) throw new ScimError(404, "There is no such endpoint.");
    const only = (...allowed: string[]) => {
      if (!allowed.includes(method)) throw new ScimError(405, `Use ${allowed.join(", ")}.`);
    };
    switch (collection) {
      case "ServiceProviderConfig":
        only("GET");
        return scimJson(200, serviceProviderConfig(baseUrl));
      case "ResourceTypes": {
        only("GET");
        const types = resourceTypes(baseUrl);
        if (id) {
          const type = types.find((t) => t.id === id);
          if (!type) throw new ScimError(404, `No resource type ${id}.`);
          return scimJson(200, type);
        }
        return scimJson(200, listResponse(types, types.length, 1));
      }
      case "Schemas": {
        only("GET");
        const schemas = schemaResources(baseUrl);
        if (!id) return scimJson(200, listResponse(schemas, schemas.length, 1));
        const schema = schemas.find((s) => s.id === id);
        if (!schema) throw new ScimError(404, `No schema ${id}.`);
        return scimJson(200, schema);
      }
      case "Users": {
        if (!id) {
          only("GET", "POST");
          if (method === "GET") return scimJson(200, await listUsers(workspaceId, url.searchParams, baseUrl));
          const created = await createUser(workspaceId, await readJson(request));
          const resource = userResource(created, baseUrl);
          return scimJson(201, resource, { Location: resource.meta.location });
        }
        only("GET", "PUT", "PATCH", "DELETE");
        if (method === "DELETE") {
          await deleteUser(workspaceId, id);
          return scimJson(204, null);
        }
        const record = await findRecord(workspaceId, id);
        if (method === "PUT") await applyChanges(workspaceId, record, changesFromResource(await readJson(request)));
        if (method === "PATCH") await applyChanges(workspaceId, record, changesFromPatch(await readJson(request)));
        return scimJson(200, userResource(await findRecord(workspaceId, id), baseUrl));
      }
      case "Groups": {
        if (!id) {
          only("GET", "POST");
          if (method === "GET") return scimJson(200, await listGroupResources(workspaceId, url.searchParams, baseUrl));
          const resource = groupResource(await createGroupResource(workspaceId, await readJson(request)), baseUrl);
          return scimJson(201, resource, { Location: resource.meta.location });
        }
        only("GET", "PUT", "PATCH", "DELETE");
        if (method === "DELETE") {
          await deleteGroupResource(workspaceId, id);
          return scimJson(204, null);
        }
        if (method === "PUT") await replaceGroup(workspaceId, id, await readJson(request));
        if (method === "PATCH") await patchGroup(workspaceId, id, await readJson(request));
        const withMembers = method !== "GET" || wantsMembers(url.searchParams);
        return scimJson(200, groupResource(await findGroup(workspaceId, id), baseUrl, withMembers));
      }
      default:
        throw new ScimError(404, "There is no such endpoint.");
    }
  } catch (error) {
    if (error instanceof ScimError) return errorResponse(error);
    if (error instanceof GroupError) {
      return errorResponse(
        error.code === "nameTaken" ? new ScimError(409, error.message, "uniqueness") : new ScimError(400, error.message, "invalidValue"),
      );
    }
    // A group deleted, or the workspace's owners changed, between the lookup and the change.
    if (error instanceof AccessError) return errorResponse(new ScimError(404, "Not found."));
    if (error instanceof WorkspaceError) return errorResponse(new ScimError(400, error.message, "mutability"));
    console.error("SCIM request failed", error);
    return errorResponse(new ScimError(500, "Something went wrong."));
  }
}

/** For the settings box: how many people SCIM manages in the workspace. */
export async function scimManagedCount(workspaceId: string) {
  const [row] = await db.select({ n: count() }).from(scimIdentity).where(eq(scimIdentity.workspaceId, workspaceId));
  return row?.n ?? 0;
}

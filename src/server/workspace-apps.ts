/**
 * The connected apps that can reach a workspace, for its owners (Settings > Security): MCP clients
 * the people in it authorized, and their REST API tokens for it, with when each one last reached
 * this workspace. An owner can disconnect one person's app; it goes from all their workspaces, as
 * an app or a token belongs to the person, not to one workspace. Owners also approve apps, for
 * workspaces that let in only those (`onlyApprovedApps`, see server/connected-app.ts).
 */
import { and, count, desc, eq, gt, inArray, isNull, not, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { apiToken, connectedAppUse, oauthClient, oauthConsent, user, workspace } from "@/db/schema";
import { AccessError, inWorkspace, requireMembership } from "@/server/access";
import { recordAudit } from "@/server/audit";
import { revokeApiToken } from "@/server/api/tokens";
import { clientDisplayName, revokeConnectedApp } from "@/server/mcp/grants";
import { scopesWrite } from "@/lib/api-scopes";
import { WRITE_SCOPE } from "@/server/mcp/principal";

/** The most apps and the most tokens the list shows, those used here most recently first. */
export const WORKSPACE_APPS_SHOWN = 100;
/** The most apps a workspace keeps approved. */
export const APPROVED_APPS_MAX = 500;

export type WorkspaceApp = {
  kind: "connected_app" | "api_token";
  /** The OAuth client id, or the token's id. */
  id: string;
  name: string;
  /** A token's start ("esi_…"), to tell tokens apart. */
  prefix: string | null;
  person: { id: string; name: string; email: string };
  /** It may change pages, not only read them (still held to the workspace's connected-apps setting). */
  writes: boolean;
  /** It reaches the person's other workspaces too: every app, and tokens not limited to this one. */
  allWorkspaces: boolean;
  connectedAt: Date;
  /** When it last reached this workspace; null when it hasn't (or not since this was recorded). */
  lastUsedHere: Date | null;
  /** Owners approved it (an app; null for a token, which approval doesn't concern). */
  approved: boolean | null;
};

const lastUseOf = (workspaceId: string, kind: "connected_app" | "api_token", userId: SQL | AnyColumn, appId: SQL | AnyColumn) =>
  and(
    eq(connectedAppUse.workspaceId, workspaceId),
    eq(connectedAppUse.appKind, kind),
    sql`${connectedAppUse.userId} = ${userId}`,
    sql`${connectedAppUse.appId} = ${appId}`,
  );

const person = { id: user.id, name: user.name, email: user.email };
const mostRecent = [sql`${connectedAppUse.lastUsedAt} desc nulls last`];

/** People's consents that reach the workspace (`only`: narrowed further), with their last use here. */
function appsReaching(workspaceId: string, only?: SQL) {
  const where = and(
    inWorkspace(oauthConsent.userId, workspaceId),
    // Clients that skip consent are the server's own, and disabled ones reach nothing.
    not(sql`coalesce(${oauthClient.skipConsent}, false)`),
    not(sql`coalesce(${oauthClient.disabled}, false)`),
    only,
  );
  const rows = db
    .select({
      id: oauthConsent.clientId,
      name: oauthClient.name,
      scopes: oauthConsent.scopes,
      connectedAt: oauthConsent.createdAt,
      lastUsedHere: connectedAppUse.lastUsedAt,
      person,
    })
    .from(oauthConsent)
    .innerJoin(oauthClient, eq(oauthClient.clientId, oauthConsent.clientId))
    .innerJoin(user, eq(user.id, oauthConsent.userId))
    .leftJoin(connectedAppUse, lastUseOf(workspaceId, "connected_app", oauthConsent.userId, oauthConsent.clientId))
    .where(where)
    .orderBy(...mostRecent, desc(oauthConsent.createdAt));
  const total = db
    .select({ n: count() })
    .from(oauthConsent)
    .innerJoin(oauthClient, eq(oauthClient.clientId, oauthConsent.clientId))
    .where(where);
  return { rows, total };
}

/** People's tokens that reach the workspace and haven't expired (`only`: narrowed further). */
function tokensReaching(workspaceId: string, now: Date, only?: SQL) {
  const where = and(
    inWorkspace(apiToken.userId, workspaceId),
    or(isNull(apiToken.workspaceId), eq(apiToken.workspaceId, workspaceId)),
    or(isNull(apiToken.expiresAt), gt(apiToken.expiresAt, now)),
    only,
  );
  const rows = db
    .select({
      id: apiToken.id,
      name: apiToken.name,
      prefix: apiToken.prefix,
      scopes: apiToken.scopes,
      workspaceId: apiToken.workspaceId,
      connectedAt: apiToken.createdAt,
      lastUsedHere: connectedAppUse.lastUsedAt,
      person,
    })
    .from(apiToken)
    .innerJoin(user, eq(user.id, apiToken.userId))
    .leftJoin(connectedAppUse, lastUseOf(workspaceId, "api_token", apiToken.userId, apiToken.id))
    .where(where)
    .orderBy(...mostRecent, desc(apiToken.createdAt));
  const total = db.select({ n: count() }).from(apiToken).where(where);
  return { rows, total };
}

/**
 * The apps and tokens that can reach the workspace, those used here most recently first: up to
 * WORKSPACE_APPS_SHOWN of each, and how many there are in all. Owners only.
 */
export async function listWorkspaceApps(actorId: string, workspaceId: string, now = new Date()): Promise<{ apps: WorkspaceApp[]; total: number }> {
  await requireMembership(actorId, workspaceId, "owner");
  const apps = appsReaching(workspaceId);
  const tokens = tokensReaching(workspaceId, now);
  const [appRows, tokenRows, [appCount], [tokenCount], approved] = await Promise.all([
    apps.rows.limit(WORKSPACE_APPS_SHOWN),
    tokens.rows.limit(WORKSPACE_APPS_SHOWN),
    apps.total,
    tokens.total,
    approvedApps(workspaceId),
  ]);
  const all: WorkspaceApp[] = [
    ...appRows.map((a) => ({
      kind: "connected_app" as const,
      id: a.id,
      name: clientDisplayName(a.name, a.id),
      prefix: null,
      person: a.person,
      writes: a.scopes.includes(WRITE_SCOPE),
      allWorkspaces: true,
      connectedAt: a.connectedAt,
      lastUsedHere: a.lastUsedHere,
      approved: approved.has(a.id),
    })),
    ...tokenRows.map((t) => ({
      kind: "api_token" as const,
      id: t.id,
      name: t.name,
      prefix: t.prefix,
      person: t.person,
      // Any write scope (rows:write, say), or a legacy token's pages:write.
      writes: scopesWrite(t.scopes),
      allWorkspaces: t.workspaceId === null,
      connectedAt: t.connectedAt,
      lastUsedHere: t.lastUsedHere,
      approved: null,
    })),
  ];
  const time = (d: Date | null) => d?.getTime() ?? -Infinity;
  all.sort((a, b) => time(b.lastUsedHere) - time(a.lastUsedHere) || b.connectedAt.getTime() - a.connectedAt.getTime());
  return { apps: all, total: Number(appCount?.n ?? 0) + Number(tokenCount?.n ?? 0) };
}

/** The OAuth clients the workspace's owners approved. */
async function approvedApps(workspaceId: string): Promise<Set<string>> {
  const [row] = await db.select({ settings: workspace.settings }).from(workspace).where(eq(workspace.id, workspaceId)).limit(1);
  const list = row?.settings.approvedApps;
  return new Set(Array.isArray(list) ? list.filter((id): id is string => typeof id === "string") : []);
}

/** Approving more apps than APPROVED_APPS_MAX. */
export class ApprovedAppsFullError extends Error {
  constructor() {
    super(`A workspace keeps at most ${APPROVED_APPS_MAX} approved apps`);
    this.name = "ApprovedAppsFullError";
  }
}

/**
 * Approves an app for the workspace, or withdraws the approval (`approve` false), for an owner.
 * Approving takes an app someone here connected (one the list shows); withdrawing works on any.
 * The approval is the app's (its OAuth client), whoever connected it. Recorded in the audit log.
 */
export async function setWorkspaceAppApproved(actorId: string, workspaceId: string, clientId: string, approve: boolean) {
  await requireMembership(actorId, workspaceId, "owner");
  const [found] = await db.select({ name: oauthClient.name }).from(oauthClient).where(eq(oauthClient.clientId, clientId)).limit(1);
  if (approve && !(await appsReaching(workspaceId, eq(oauthConsent.clientId, clientId)).rows.limit(1)).length) throw new AccessError();
  const changed = await db.transaction(async (tx) => {
    const [row] = await tx.select({ settings: workspace.settings }).from(workspace).where(eq(workspace.id, workspaceId)).for("update");
    const list = Array.isArray(row?.settings.approvedApps) ? row.settings.approvedApps : [];
    if (list.includes(clientId) === approve) return false;
    if (approve && list.length >= APPROVED_APPS_MAX) throw new ApprovedAppsFullError();
    const next = approve ? [...list, clientId] : list.filter((id) => id !== clientId);
    await tx
      .update(workspace)
      .set({ settings: sql`${workspace.settings} || ${JSON.stringify({ approvedApps: next })}::jsonb` })
      .where(eq(workspace.id, workspaceId));
    await recordAudit(
      {
        workspaceId,
        actorId,
        action: approve ? "connected_app.approved" : "connected_app.unapproved",
        target: { type: "connected_app", id: clientId, label: clientDisplayName(found?.name, clientId) },
      },
      tx,
    );
    return true;
  });
  return { changed };
}

/**
 * Disconnects one person's app or revokes their token, for an owner of a workspace it reaches: the
 * person must be in the workspace, and a token must reach it. Recorded in this workspace's audit log.
 */
export async function disconnectWorkspaceApp(
  actorId: string,
  workspaceId: string,
  target: { kind: "connected_app" | "api_token"; userId: string; id: string },
) {
  await requireMembership(actorId, workspaceId, "owner");
  const [found] =
    target.kind === "connected_app"
      ? await appsReaching(workspaceId, and(eq(oauthConsent.userId, target.userId), eq(oauthConsent.clientId, target.id))).rows.limit(1)
      : await tokensReaching(workspaceId, new Date(), and(eq(apiToken.userId, target.userId), eq(apiToken.id, target.id))).rows.limit(1);
  if (!found) throw new AccessError();
  const by = { actorId, workspaceId };
  if (target.kind === "connected_app") await revokeConnectedApp(target.userId, target.id, by);
  else await revokeApiToken(target.userId, target.id, by);
}

/**
 * Forgets uses no one can be shown any more: of apps disconnected or tokens revoked or expired
 * without passing through the revoke paths, and of people no longer in the workspace. For the
 * daily retention run; `workspaceIds` narrows it as there.
 */
export async function pruneConnectedAppUse(workspaceIds?: string[], now = new Date()): Promise<number> {
  const deleted = await db
    .delete(connectedAppUse)
    .where(
      and(
        workspaceIds ? inArray(connectedAppUse.workspaceId, workspaceIds) : undefined,
        or(
          not(inWorkspace(connectedAppUse.userId, connectedAppUse.workspaceId)),
          and(
            eq(connectedAppUse.appKind, "connected_app"),
            sql`not exists (select 1 from ${oauthConsent} where ${oauthConsent.userId} = ${connectedAppUse.userId} and ${oauthConsent.clientId} = ${connectedAppUse.appId})`,
          ),
          and(
            eq(connectedAppUse.appKind, "api_token"),
            sql`not exists (select 1 from ${apiToken} where ${apiToken.id} = ${connectedAppUse.appId} and (${apiToken.expiresAt} is null or ${apiToken.expiresAt} > ${now.toISOString()}::timestamptz))`,
          ),
        ),
      ),
    )
    .returning({ appId: connectedAppUse.appId });
  return deleted.length;
}

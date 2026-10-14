/**
 * The connected apps that can reach a workspace, for its owners (Settings > Security): MCP clients
 * the people in it authorized, and their REST API tokens for it, with when each one last reached
 * this workspace. An owner can disconnect one person's app; it goes from all their workspaces, as
 * an app or a token belongs to the person, not to one workspace.
 */
import { and, eq, gt, isNull, not, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { apiToken, connectedAppUse, oauthClient, oauthConsent, user } from "@/db/schema";
import { AccessError, inWorkspace, requireMembership } from "@/server/access";
import { revokeApiToken } from "@/server/api/tokens";
import { clientDisplayName, revokeConnectedApp } from "@/server/mcp/grants";
import { WRITE_SCOPE } from "@/server/mcp/principal";

export type WorkspaceApp = {
  kind: "connected_app" | "api_token";
  /** The OAuth client id, or the token's id. */
  id: string;
  name: string;
  /** The client's icon and site as it registered them; none for tokens. */
  icon: string | null;
  uri: string | null;
  /** A token's start ("esi_…"), to tell tokens apart. */
  prefix: string | null;
  person: { id: string; name: string; email: string; image: string | null };
  /** It may change pages, not only read them (still held to the workspace's connected-apps setting). */
  writes: boolean;
  /** It reaches the person's other workspaces too: every app, and tokens not limited to this one. */
  allWorkspaces: boolean;
  connectedAt: Date;
  /** When it last reached this workspace; null when it hasn't (or not since this was recorded). */
  lastUsedHere: Date | null;
};

const lastUseOf = (workspaceId: string, kind: "connected_app" | "api_token", userId: unknown, appId: unknown) =>
  and(
    eq(connectedAppUse.workspaceId, workspaceId),
    eq(connectedAppUse.appKind, kind),
    sql`${connectedAppUse.userId} = ${userId}`,
    sql`${connectedAppUse.appId} = ${appId}`,
  );

/** The apps that can reach the workspace, those used here most recently first. Owners only. */
export async function listWorkspaceApps(actorId: string, workspaceId: string, now = new Date()): Promise<WorkspaceApp[]> {
  await requireMembership(actorId, workspaceId, "owner");
  const person = { id: user.id, name: user.name, email: user.email, image: user.image };
  const [apps, tokens] = await Promise.all([
    db
      .select({
        id: oauthConsent.clientId,
        name: oauthClient.name,
        icon: oauthClient.icon,
        uri: oauthClient.uri,
        scopes: oauthConsent.scopes,
        connectedAt: oauthConsent.createdAt,
        lastUsedHere: connectedAppUse.lastUsedAt,
        person,
      })
      .from(oauthConsent)
      .innerJoin(oauthClient, eq(oauthClient.clientId, oauthConsent.clientId))
      .innerJoin(user, eq(user.id, oauthConsent.userId))
      .leftJoin(connectedAppUse, lastUseOf(workspaceId, "connected_app", oauthConsent.userId, oauthConsent.clientId))
      // Clients that skip consent are the server's own, and disabled ones reach nothing.
      .where(
        and(
          inWorkspace(oauthConsent.userId, workspaceId),
          not(sql`coalesce(${oauthClient.skipConsent}, false)`),
          not(sql`coalesce(${oauthClient.disabled}, false)`),
        ),
      ),
    db
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
      .where(
        and(
          inWorkspace(apiToken.userId, workspaceId),
          or(isNull(apiToken.workspaceId), eq(apiToken.workspaceId, workspaceId)),
          or(isNull(apiToken.expiresAt), gt(apiToken.expiresAt, now)),
        ),
      ),
  ]);
  const all: WorkspaceApp[] = [
    ...apps.map((a) => ({
      kind: "connected_app" as const,
      id: a.id,
      name: clientDisplayName(a.name, a.id),
      icon: a.icon,
      uri: a.uri,
      prefix: null,
      person: a.person,
      writes: a.scopes.includes(WRITE_SCOPE),
      allWorkspaces: true,
      connectedAt: a.connectedAt,
      lastUsedHere: a.lastUsedHere,
    })),
    ...tokens.map((t) => ({
      kind: "api_token" as const,
      id: t.id,
      name: t.name,
      icon: null,
      uri: null,
      prefix: t.prefix,
      person: t.person,
      writes: t.scopes.includes(WRITE_SCOPE),
      allWorkspaces: t.workspaceId === null,
      connectedAt: t.connectedAt,
      lastUsedHere: t.lastUsedHere,
    })),
  ];
  const time = (d: Date | null) => d?.getTime() ?? -Infinity;
  return all.sort((a, b) => time(b.lastUsedHere) - time(a.lastUsedHere) || b.connectedAt.getTime() - a.connectedAt.getTime());
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
  const reaches = (await listWorkspaceApps(actorId, workspaceId)).some(
    (a) => a.kind === target.kind && a.id === target.id && a.person.id === target.userId,
  );
  if (!reaches) throw new AccessError();
  const by = { actorId, workspaceId };
  if (target.kind === "connected_app") await revokeConnectedApp(target.userId, target.id, by);
  else await revokeApiToken(target.userId, target.id, by);
}

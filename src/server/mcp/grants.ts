import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx, isAPIError } from "better-auth/api";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { oauthAccessToken, oauthClient, oauthConsent, oauthRefreshToken } from "@/db/schema";
import { isStrongSession } from "@/lib/auth-security";
import { firstPolicyHold, memberWorkspaceIds } from "@/server/access";
import { recordAudit } from "@/server/audit";

/**
 * JWT access tokens are verified statelessly, so revoking an app in settings would not stop
 * them until they expire. The MCP endpoint therefore also requires a live consent that
 * predates the token: revoking deletes the consent, and re-connecting creates a newer one,
 * so tokens issued before a revoke stay dead.
 */
export async function hasActiveGrant(userId: string, clientId: string, issuedAt?: number): Promise<boolean> {
  const [client] = await db
    .select({ disabled: oauthClient.disabled, skipConsent: oauthClient.skipConsent })
    .from(oauthClient)
    .where(eq(oauthClient.clientId, clientId))
    .limit(1);
  if (!client || client.disabled) return false;
  if (client.skipConsent) return true;
  const [consent] = await db
    .select({ createdAt: oauthConsent.createdAt })
    .from(oauthConsent)
    .where(and(eq(oauthConsent.userId, userId), eq(oauthConsent.clientId, clientId)))
    .limit(1);
  if (!consent) return false;
  // Consent timestamps are stored with second precision.
  if (issuedAt !== undefined && issuedAt * 1000 < consent.createdAt.getTime() - 1000) return false;
  return true;
}

export type ConnectedApp = {
  clientId: string;
  name: string;
  icon: string | null;
  uri: string | null;
  scopes: string[];
  connectedAt: Date;
  updatedAt: Date;
};

export async function listConnectedApps(userId: string): Promise<ConnectedApp[]> {
  const rows = await db
    .select({
      clientId: oauthConsent.clientId,
      scopes: oauthConsent.scopes,
      createdAt: oauthConsent.createdAt,
      updatedAt: oauthConsent.updatedAt,
      name: oauthClient.name,
      icon: oauthClient.icon,
      uri: oauthClient.uri,
    })
    .from(oauthConsent)
    .innerJoin(oauthClient, eq(oauthClient.clientId, oauthConsent.clientId))
    .where(eq(oauthConsent.userId, userId))
    .orderBy(desc(oauthConsent.updatedAt));
  return rows.map((r) => ({
    clientId: r.clientId,
    name: clientDisplayName(r.name, r.clientId),
    icon: r.icon,
    uri: r.uri,
    scopes: r.scopes,
    connectedAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

/**
 * Records in the audit log that the user connected or disconnected an app. An app reaches every
 * workspace the user is in (each one's connected-apps setting decides what it may do there), so
 * each of them records it.
 */
async function recordConnectedApp(userId: string, clientId: string, action: "connected_app.connected" | "connected_app.revoked", scopes: string[]) {
  const [client] = await db.select({ name: oauthClient.name }).from(oauthClient).where(eq(oauthClient.clientId, clientId)).limit(1);
  const label = clientDisplayName(client?.name, clientId);
  const workspaceIds = await memberWorkspaceIds(userId);
  await recordAudit(
    workspaceIds.map((workspaceId) => ({
      workspaceId,
      actorId: userId,
      action,
      target: { type: "connected_app" as const, id: clientId, label },
      details: { scopes },
    })),
  );
}

/** What the workspaces' sign-in policies look at in a session (see SessionFacts in access.ts). */
type PolicySession = { user: { id: string; twoFactorEnabled?: boolean | null }; session: { authMethod?: string | null; ssoProviderId?: string | null } };

/**
 * Where a session that one of the user's workspaces holds back goes before it may connect an app,
 * or null. A connected app reaches every workspace the user is in, outside their sign-in policies.
 */
export async function connectingHeldBack(session: PolicySession) {
  return firstPolicyHold(session.user.id, { strong: isStrongSession(session), ssoProviderId: session.session.ssoProviderId ?? null });
}

/**
 * Better Auth plugin: refuses allowing an app (or giving it more scopes) to a session one of the
 * user's workspaces holds back (the consent page sends it to meet the policy first), and records
 * an app connecting once the user allows it on the consent page (the consent is stored by then).
 * Clients that skip consent are the server's own and aren't recorded.
 */
export function connectedAppAuditPlugin() {
  return {
    id: "leafdesk-connected-app-audit",
    hooks: {
      before: [
        {
          matcher: (ctx) =>
            (ctx.path === "/oauth2/consent" && (ctx.body as { accept?: unknown } | undefined)?.accept === true) ||
            ctx.path === "/oauth2/update-consent",
          handler: createAuthMiddleware(async (ctx) => {
            const session = await getSessionFromCtx(ctx);
            if (session && (await connectingHeldBack(session as PolicySession))) {
              throw APIError.from("FORBIDDEN", { message: "A workspace's sign-in policy holds this session back", code: "workspace_policy" });
            }
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) => ctx.path === "/oauth2/consent",
          handler: createAuthMiddleware(async (ctx) => {
            const body = (ctx.body ?? {}) as { accept?: unknown; oauth_query?: unknown };
            const userId = ctx.context.session?.user.id;
            if (body.accept !== true || !userId || isAPIError(ctx.context.returned)) return;
            const clientId = new URLSearchParams(typeof body.oauth_query === "string" ? body.oauth_query : "").get("client_id");
            if (!clientId) return;
            const [consent] = await db
              .select({ scopes: oauthConsent.scopes })
              .from(oauthConsent)
              .where(and(eq(oauthConsent.userId, userId), eq(oauthConsent.clientId, clientId)))
              .limit(1);
            if (consent) await recordConnectedApp(userId, clientId, "connected_app.connected", consent.scopes);
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}

/** Removes the user's consent for a client and revokes every token it holds for the user. */
export async function revokeConnectedApp(userId: string, clientId: string) {
  const now = new Date();
  const revoked = await db.transaction(async (tx) => {
    const consents = await tx
      .delete(oauthConsent)
      .where(and(eq(oauthConsent.userId, userId), eq(oauthConsent.clientId, clientId)))
      .returning({ scopes: oauthConsent.scopes });
    await tx
      .update(oauthRefreshToken)
      .set({ revoked: now })
      .where(
        and(eq(oauthRefreshToken.userId, userId), eq(oauthRefreshToken.clientId, clientId), isNull(oauthRefreshToken.revoked)),
      );
    await tx
      .update(oauthAccessToken)
      .set({ revoked: now })
      .where(
        and(eq(oauthAccessToken.userId, userId), eq(oauthAccessToken.clientId, clientId), isNull(oauthAccessToken.revoked)),
      );
    return consents;
  });
  // After the commit: one event per workspace of the user, recorded on their own.
  if (revoked.length) await recordConnectedApp(userId, clientId, "connected_app.revoked", revoked[0].scopes);
}

/** Like revokeConnectedApp for every app the user has connected, including tokens without consent. */
export async function revokeAllConnectedApps(userId: string) {
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.delete(oauthConsent).where(eq(oauthConsent.userId, userId));
    await tx
      .update(oauthRefreshToken)
      .set({ revoked: now })
      .where(and(eq(oauthRefreshToken.userId, userId), isNull(oauthRefreshToken.revoked)));
    await tx
      .update(oauthAccessToken)
      .set({ revoked: now })
      .where(and(eq(oauthAccessToken.userId, userId), isNull(oauthAccessToken.revoked)));
  });
}

/** A readable name for a client: its registered name, else the host of a URL client id (CIMD). */
export function clientDisplayName(name: string | null | undefined, clientId: string) {
  if (name?.trim()) return name.trim();
  try {
    return new URL(clientId).host;
  } catch {
    return "Unnamed app";
  }
}

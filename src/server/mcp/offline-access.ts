import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { oauthClient } from "@/db/schema";

export const OFFLINE_ACCESS = "offline_access";

/**
 * MCP clients ask for the scopes the protected-resource metadata lists, and that list leaves out
 * offline_access, an authorization server's scope. Such an app got no refresh token: it fell out
 * when its access token ran out an hour later, and signing in again went through without a screen.
 * Every app with the authorization-code grant may refresh, so a registration and an authorization
 * ask for offline_access on its behalf; the consent screen shows it ("Stay connected").
 */
export function withOfflineAccess(scope: string): string {
  const scopes = scope.split(" ").filter(Boolean);
  return scopes.includes(OFFLINE_ACCESS) ? scopes.join(" ") : [...scopes, OFFLINE_ACCESS].join(" ");
}

function lacksOfflineAccess(scope: unknown): scope is string {
  return typeof scope === "string" && scope.trim() !== "" && !scope.split(" ").includes(OFFLINE_ACCESS);
}

/**
 * Whether an authorization of this client may ask for offline_access. Clients registered before
 * this was added kept only what they asked for; a migration widened them (0211), and a client
 * whose list still lacks it (one read from its metadata document) is left as it asked, since the
 * provider refuses a scope outside a client's list.
 */
export async function clientTakesOfflineAccess(clientId: string): Promise<boolean> {
  const [client] = await db
    .select({ scopes: oauthClient.scopes, grantTypes: oauthClient.grantTypes })
    .from(oauthClient)
    .where(eq(oauthClient.clientId, clientId))
    .limit(1);
  if (!client) return false;
  const grants = client.grantTypes?.length ? client.grantTypes : ["authorization_code"];
  if (!grants.includes("authorization_code") && !grants.includes("refresh_token")) return false;
  return !client.scopes || client.scopes.includes(OFFLINE_ACCESS);
}

export function offlineAccessPlugin() {
  return {
    id: "leafdesk-offline-access",
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === "/oauth2/register",
          handler: createAuthMiddleware(async (ctx) => {
            const body = ctx.body as Record<string, unknown> | undefined;
            if (!body || typeof body !== "object" || !lacksOfflineAccess(body.scope)) return;
            const grants = Array.isArray(body.grant_types) ? body.grant_types : ["authorization_code"];
            if (!grants.includes("authorization_code") && !grants.includes("refresh_token")) return;
            body.scope = withOfflineAccess(body.scope);
            return { context: { body } };
          }),
        },
        {
          matcher: (ctx) => ctx.path === "/oauth2/authorize",
          handler: createAuthMiddleware(async (ctx) => {
            // A POST authorization carries its parameters in the body, as the provider reads them.
            const key = ctx.method === "POST" ? "body" : "query";
            const params = ctx[key] as Record<string, unknown> | undefined;
            if (!params || typeof params !== "object" || !lacksOfflineAccess(params.scope)) return;
            if (typeof params.client_id !== "string" || params.request_uri !== undefined) return;
            if (!(await clientTakesOfflineAccess(params.client_id))) return;
            params.scope = withOfflineAccess(params.scope);
            return { context: { [key]: params } };
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}

import { requireMcpAuth } from "@better-auth/mcp";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { auth } from "@/lib/auth";
import { CLIENT_IP_HEADER } from "@/lib/client-ip";
import { internalUrl, mcpResource } from "@/lib/env";
import { runAsConnectedApp } from "@/server/connected-app";
import { hasActiveGrant } from "@/server/mcp/grants";
import {
  authInfoFromClaims,
  bearerToken,
  CONNECT_SCOPES,
  principalFromAuthInfo,
  protectedResourceMetadataUrl,
  READ_SCOPE,
} from "@/server/mcp/principal";
import { rateLimitedResponse, takeMcpRequest } from "@/server/mcp/rate-limit";
import { createMcpServer } from "@/server/mcp/tools";

/**
 * Remote MCP endpoint. Serves the 2026-07-28 protocol and, for 2025-era clients, the
 * stateless fallback. Every request needs an audience-bound access token with pages:read;
 * write tools additionally challenge for pages:write. Each user has MCP_RATE_LIMIT requests a
 * minute across all their apps (server/mcp/rate-limit.ts).
 */
const mcp = createMcpHandler((ctx) => createMcpServer(principalFromAuthInfo(ctx.authInfo)), {
  onerror: (error) => console.error("[mcp]", error),
});

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, Accept, DPoP, Mcp-Protocol-Version, Mcp-Session-Id, Mcp-Method, Mcp-Name, Last-Event-ID",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Retry-After, Mcp-Protocol-Version, Mcp-Session-Id",
};

function withCors(response: Response) {
  // Bearer tokens only (no cookies), so any origin may call the endpoint.
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function revokedResponse() {
  const description = "The user revoked this app's access";
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: description }, id: null }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": `Bearer error="invalid_token", error_description="${description}", resource_metadata="${protectedResourceMetadataUrl(mcpResource())}"`,
    },
  });
}

const protectedHandler = requireMcpAuth(
  auth,
  async (request, claims) => {
    const authInfo = authInfoFromClaims(claims, bearerToken(request), mcpResource());
    if (!authInfo) return revokedResponse();
    const { userId, clientId } = principalFromAuthInfo(authInfo);
    // Counted before the grant's database lookups, so requests over the limit cost next to nothing.
    // A revoked app over the limit hears 429 first, then 401 once it may try again.
    const wait = takeMcpRequest(userId);
    if (wait > 0) return rateLimitedResponse(wait);
    if (!(await hasActiveGrant(userId, clientId, claims.iat))) return revokedResponse();
    // Held to each workspace's connected-apps setting; write tools mark themselves (tools.ts). The
    // client is named in the audit log for what the tools change (server/audit.ts).
    const app = {
      kind: "connected_app" as const,
      id: clientId,
      ip: request.headers.get(CLIENT_IP_HEADER),
      userAgent: request.headers.get("user-agent"),
    };
    return runAsConnectedApp({ userId, app }, () => mcp.fetch(request, { authInfo }));
  },
  // Signing keys are fetched over HTTP; use loopback so it works behind proxies and port mappings.
  {
    resource: mcpResource(),
    requiredScopes: [READ_SCOPE],
    challengeScopes: CONNECT_SCOPES,
    jwksUrl: `${internalUrl()}/api/auth/jwks`,
  },
);

async function handle(request: Request) {
  return withCors(await protectedHandler(request));
}

export { handle as GET, handle as POST, handle as DELETE };

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

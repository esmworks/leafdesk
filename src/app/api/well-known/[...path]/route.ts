import { auth } from "@/lib/auth";
import { env } from "@/lib/env";

/**
 * Maps a /.well-known/* request to the path Better Auth answers. The issuer is
 * `${APP_URL}/api/auth`, so its RFC 8414 document lives at the path-inserted URL and the
 * OIDC document at the path-appended one. Some MCP clients skip issuer paths and probe the
 * bare root documents; alias those to the issuer's metadata.
 */
function resolvePath(path: string[]): string {
  const joined = path.join("/");
  if (joined === "oauth-authorization-server") return "/.well-known/oauth-authorization-server/api/auth";
  if (joined === "openid-configuration" || joined === "openid-configuration/api/auth") {
    return "/api/auth/.well-known/openid-configuration";
  }
  return `/.well-known/${joined}`;
}

/**
 * Serves /.well-known/* (next.config rewrites it to this route) through Better Auth: authorization
 * server metadata, OpenID configuration and the MCP protected-resource metadata. The plugins
 * match on the original root path, so the request is rebuilt with it.
 */
async function handle(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const url = new URL(resolvePath(path), env.appUrl);
  const response = await auth.handler(new Request(url, { method: request.method, headers: request.headers }));
  if (response.status === 404) return new Response("Not found", { status: 404 });
  response.headers.set("Access-Control-Allow-Origin", "*");
  return response;
}

export { handle as GET, handle as HEAD };

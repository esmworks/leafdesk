import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { env } from "@/lib/env";
import { completeConnectionOAuth, ConnectionError } from "@/server/connections/manage";

/**
 * Where a connection's service sends the browser back after signing in: finishes the sign-in
 * begun by the same owner, then returns them to Settings > Connections, saying how it went.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return Response.redirect(`${env.appUrl}/login`, 302);
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  const denied = url.searchParams.get("error");
  if (!state || (!code && !denied)) return Response.redirect(`${env.appUrl}/`, 302);
  try {
    if (denied) throw new ConnectionError("oauthFailed", denied);
    const { connection, workspaceId } = await completeConnectionOAuth(session.user.id, { state, code, iss: url.searchParams.get("iss") ?? undefined });
    return Response.redirect(`${env.appUrl}/w/${workspaceId}/settings?tab=connections&connection=${connection.id}&signedIn=1`, 302);
  } catch (error) {
    if (!(error instanceof ConnectionError)) console.error("[connections] OAuth sign-in failed", error);
    return Response.redirect(`${env.appUrl}/?connectionError=oauthFailed`, 302);
  }
}

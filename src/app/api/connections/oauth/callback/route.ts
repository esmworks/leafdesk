import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { env } from "@/lib/env";
import { completeConnectionOAuth, ConnectionError, oauthReturnOf } from "@/server/connections/manage";

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
  // Read before finishing: finishing uses the sign-in up, whether or not it works.
  const back = await oauthReturnOf(state);
  const settings = (connectionId: string, workspaceId: string, outcome: string) =>
    `${env.appUrl}/w/${workspaceId}/settings?tab=connections&connection=${encodeURIComponent(connectionId)}&${outcome}`;
  try {
    if (denied) throw new ConnectionError("oauthFailed", denied);
    const { connection, workspaceId } = await completeConnectionOAuth(session.user.id, { state, code, iss: url.searchParams.get("iss") ?? undefined });
    return Response.redirect(settings(connection.id, workspaceId, "signedIn=1"), 302);
  } catch (error) {
    if (!(error instanceof ConnectionError)) console.error("[connections] OAuth sign-in failed", error);
    return Response.redirect(back ? settings(back.connectionId, back.workspaceId, "connectionError=oauthFailed") : `${env.appUrl}/`, 302);
  }
}

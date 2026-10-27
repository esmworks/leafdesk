import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { env } from "@/lib/env";
import { redactError } from "@/lib/redact";
import { completeGoogleMailbox, googleMailReturnOf, RowMailError } from "@/server/row-mail/settings";

/**
 * Where Google sends the browser back after someone signed in there to connect their mailbox in a
 * workspace: finishes the sign-in, tries the mailbox and keeps it, then returns them to that
 * workspace's Settings > Email and calendar, saying how it went. A browser without a Leafdesk
 * session (the system's browser the desktop app sent the sign-in to) passes the answer on to the
 * app, which brings it back here with its session.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const session = await auth.api.getSession({ headers: await headers() });
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  const denied = url.searchParams.get("error");
  if (!state || (!code && !denied)) return Response.redirect(`${env.appUrl}/${session ? "" : "sign-in"}`, 302);
  if (!session) {
    if (!(await googleMailReturnOf(state))) return Response.redirect(`${env.appUrl}/sign-in`, 302);
    const query = new URLSearchParams(url.search);
    query.set("flow", "mail");
    return Response.redirect(`${env.appUrl}/back-to-app?${query}`, 302);
  }
  // Read before finishing: finishing uses the sign-in up, whether or not it works.
  const back = await googleMailReturnOf(state, session.user.id);
  const settings = (workspaceId: string, outcome: string) => `${env.appUrl}/w/${workspaceId}/settings?tab=mail&${outcome}`;
  try {
    if (denied) throw new RowMailError("googleFailed");
    const { workspaceId } = await completeGoogleMailbox(session.user.id, { state, code });
    return Response.redirect(settings(workspaceId, "mailConnected=1"), 302);
  } catch (error) {
    const reason = error instanceof RowMailError ? error.code : "googleFailed";
    if (!(error instanceof RowMailError)) console.error("[row-mail] Google sign-in failed", redactError(error));
    return Response.redirect(back ? settings(back.workspaceId, `mailError=${encodeURIComponent(reason)}`) : `${env.appUrl}/`, 302);
  }
}

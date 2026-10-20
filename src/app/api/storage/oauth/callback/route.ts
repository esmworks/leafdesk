import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { env } from "@/lib/env";
import { redactError } from "@/lib/redact";
import { completeStorageOAuth, storageOAuthReturnOf } from "@/server/storage/accounts";
import { StorageSettingsError } from "@/server/storage/errors";

/**
 * Where Google Drive and Dropbox send the browser back after someone signed in there to connect it
 * to their account: finishes the sign-in, tries the storage and connects it (and to the workspace
 * it was begun from, if any), then returns them to that workspace's Settings > Storage or to their
 * connected storage, saying how it went. A browser without a Leafdesk session (the system's browser
 * the desktop app sent the sign-in to) passes the answer on to the app, which brings it back here
 * with its session.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const session = await auth.api.getSession({ headers: await headers() });
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  const denied = url.searchParams.get("error");
  if (!state || (!code && !denied)) return Response.redirect(`${env.appUrl}/${session ? "" : "sign-in"}`, 302);
  if (!session) {
    if (!(await storageOAuthReturnOf(state))) return Response.redirect(`${env.appUrl}/sign-in`, 302);
    const query = new URLSearchParams(url.search);
    query.set("flow", "storage");
    return Response.redirect(`${env.appUrl}/back-to-app?${query}`, 302);
  }
  // Read before finishing: finishing uses the sign-in up, whether or not it works.
  const back = await storageOAuthReturnOf(state, session.user.id);
  const settings = (workspaceId: string | null, outcome: string) =>
    workspaceId ? `${env.appUrl}/w/${workspaceId}/settings?tab=storage&${outcome}` : `${env.appUrl}/account?tab=apps&${outcome}`;
  try {
    if (denied) throw new StorageSettingsError("oauthFailed", denied);
    const { workspaceId } = await completeStorageOAuth(session.user.id, { state, code });
    return Response.redirect(settings(workspaceId, "storageConnected=1"), 302);
  } catch (error) {
    const code = error instanceof StorageSettingsError ? error.code : "oauthFailed";
    if (error instanceof StorageSettingsError) console.warn("[storage] sign-in didn't connect", error.message);
    else console.error("[storage] sign-in failed", redactError(error));
    return Response.redirect(back ? settings(back.workspaceId, `storageError=${encodeURIComponent(code)}`) : `${env.appUrl}/`, 302);
  }
}

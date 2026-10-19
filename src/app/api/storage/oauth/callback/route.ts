import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { env } from "@/lib/env";
import { redactError } from "@/lib/redact";
import { completeStorageOAuth, StorageSettingsError, storageOAuthReturnOf } from "@/server/storage/settings";

/**
 * Where Google Drive and Dropbox send the browser back after an owner signed in there to keep the
 * workspace's uploads: finishes the sign-in, tries the storage and connects it, then returns them
 * to Settings > Storage, saying how it went.
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
  const back = await storageOAuthReturnOf(state);
  const settings = (workspaceId: string, outcome: string) => `${env.appUrl}/w/${workspaceId}/settings?tab=storage&${outcome}`;
  try {
    if (denied) throw new StorageSettingsError("oauthFailed", denied);
    const { workspaceId } = await completeStorageOAuth(session.user.id, { state, code });
    return Response.redirect(settings(workspaceId, "storageConnected=1"), 302);
  } catch (error) {
    const code = error instanceof StorageSettingsError ? error.code : "oauthFailed";
    if (error instanceof StorageSettingsError) console.warn("[storage] sign-in didn't connect", error.message);
    else console.error("[storage] sign-in failed", redactError(error));
    return Response.redirect(back ? settings(back, `storageError=${encodeURIComponent(code)}`) : `${env.appUrl}/`, 302);
  }
}

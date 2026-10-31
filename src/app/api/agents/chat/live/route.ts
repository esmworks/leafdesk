import { auth } from "@/lib/auth";
import { mayFollowChatTurn } from "@/server/agents/chat";
import { followLiveText } from "@/server/agents/live-text";
import { isCrossSite } from "@/server/cross-site";
import { ndjsonResponse } from "@/server/ndjson-response";

export const dynamic = "force-dynamic";

/**
 * What an agent's chat run is writing, as it writes it (server/agents/live-text.ts):
 * newline-delimited JSON edits `{ at, add }` (keep the first `at` letters, then add `add`), the
 * first one all of it. `?workspace=&run=` name the person's own chat run (anyone else's is a 404,
 * as one that doesn't exist). It ends when the run stops in this process; the chat opens it again
 * if the run goes on (after an approval). The answer itself comes with the run (chat.ts chatTurn).
 */
export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers }).catch(() => null);
  if (!session) return fail("noAccess", "Sign in to chat with agents", 401);
  if (isCrossSite(request, "x-leafdesk-chat")) return fail("noAccess", "Cross-site requests aren't allowed", 403);
  const params = new URL(request.url).searchParams;
  const workspaceId = params.get("workspace") ?? "";
  const runId = params.get("run") ?? "";
  if (!workspaceId || !runId || workspaceId.length > 100 || runId.length > 100) return fail("noAccess", "Not found", 404);
  if (!(await mayFollowChatTurn(session.user.id, workspaceId, runId))) return fail("noAccess", "Not found", 404);
  return ndjsonResponse(request, (signal) => followLiveText(runId, signal), "agents");
}

function fail(code: string, message: string, status: number) {
  return Response.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } });
}

import { auth } from "@/lib/auth";
import { mayFollowChatTurn } from "@/server/agents/chat";
import { followLiveText } from "@/server/agents/live-text";
import { isCrossSite } from "@/server/cross-site";
import { ndjsonResponse } from "@/server/ndjson-response";

export const dynamic = "force-dynamic";

/**
 * What an agent's chat run is writing, as it writes it (server/agents/live-text.ts):
 * newline-delimited JSON events as the AI chat's answers send them (lib/ai-chat.ts ChatEvent), here
 * only `text` (added to what was written), `reset` (the turn starts over) and `ping`, from the start
 * of the turn under way. `?workspace=&run=` name the person's own chat run (anyone else's is a 404,
 * as one that doesn't exist). It ends at once when the run isn't answering in this process (not
 * started yet, waiting for an approval) and when it stops; the chat opens it again if the run goes
 * on. The answer itself comes with the run (chat.ts chatTurn).
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
  return ndjsonResponse(request, (signal) => followLiveText(session.user.id, runId, signal), "agents");
}

function fail(code: string, message: string, status: number) {
  return Response.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } });
}

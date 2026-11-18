import { redactError } from "@/lib/redact";
import { authenticate, checkActivity, TeamsAuthError } from "./auth";
import { teamsOn } from "./config";
import { handleActivity, type Activity } from "./events";

/**
 * POST /api/teams/messages (the route is a line over this): Teams' calls to the bot. The bearer
 * token is verified before the body is read as anything (auth.ts), the body must be an activity
 * whose service address and channel the token covers, and then the call is answered at once with
 * 200 and handled on its own: an AI answer takes longer than the Connector waits, and it sends
 * the same activity again when it doesn't hear back, so an activity id handled lately is not
 * handled twice. A refusal says only that it is one.
 */

const MAX_BODY = 256 * 1024;
const MAX_SEEN = 2_000;
const seen = new Set<string>();
/** Activities being handled: flushTeams waits for them. */
const working = new Set<Promise<void>>();

/** Scripts and tests: waits for the activities being handled. */
export async function flushTeams() {
  while (working.size) await Promise.allSettled([...working]);
}

export async function handleTeamsRequest(request: Request): Promise<Response> {
  if (!teamsOn()) return new Response(null, { status: 404 });
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BODY) return new Response(null, { status: 413 });
  let verified;
  try {
    verified = await authenticate(request.headers.get("authorization"));
  } catch (error) {
    if (error instanceof TeamsAuthError) console.warn(`[teams] a call was refused: ${error.message}`);
    else console.error("[teams] couldn't check a call", redactError(error));
    return new Response(null, { status: error instanceof TeamsAuthError ? error.status : 500 });
  }
  const raw = await request.text().catch(() => "");
  if (!raw || raw.length > MAX_BODY) return new Response(null, { status: 400 });
  let activity: Activity;
  try {
    activity = JSON.parse(raw) as Activity;
  } catch {
    return new Response(null, { status: 400 });
  }
  if (!activity || typeof activity !== "object" || Array.isArray(activity)) return new Response(null, { status: 400 });
  try {
    checkActivity(verified, activity);
  } catch (error) {
    console.warn(`[teams] a call was refused: ${error instanceof Error ? error.message : "error"}`);
    return new Response(null, { status: 403 });
  }
  const id = typeof activity.id === "string" ? activity.id : null;
  if (id) {
    if (seen.has(id)) return new Response(null, { status: 200 });
    seen.add(id);
    if (seen.size > MAX_SEEN) seen.delete(seen.values().next().value!);
  }
  const work = handleActivity(activity);
  working.add(work);
  void work.finally(() => working.delete(work));
  return new Response(null, { status: 200 });
}

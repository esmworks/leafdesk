import { auth } from "@/lib/auth";
import { aiErrorStatus, isAiError, sttLimits } from "@/server/ai";
import { audioError as fail, readAudioForm } from "@/server/audio-upload";
import { isCrossSite } from "@/server/cross-site";
import { transcribeDictation } from "@/server/voice-notes";

/**
 * Dictation in the AI chat's box (see server/voice-notes.ts): `POST /api/ai/transcribe` with
 * multipart form data: `audio` (the recording) and `workspaceId`. Answers `{"text":"…"}`, what was
 * said, which the box takes in for the person to check before sending; or a status and
 * `{"error":{"code","message"}}` (codes of lib/ai AI_ERROR_CODES). Closing the request cancels it.
 *
 * Signed-in browsers only (the session cookie); the cross-site check keeps other sites' pages from
 * posting here, as on the voice note route.
 */
export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers }).catch(() => null);
  if (!session) return fail("noAccess", "Sign in to dictate", 401);
  if (isCrossSite(request)) return fail("noAccess", "Cross-site requests aren't allowed", 403);
  const limits = sttLimits();
  if (!limits) return fail("disabled", "Speech to text is not configured on this server", 403);
  const read = await readAudioForm(request, limits.maxBytes);
  if (read instanceof Response) return read;
  const workspaceId = read.form.get("workspaceId");
  if (typeof workspaceId !== "string" || !workspaceId.trim()) return fail("invalid", "Say which workspace: workspaceId", 400);

  try {
    const text = await transcribeDictation(session.user.id, workspaceId.trim().slice(0, 100), read.audio, { signal: request.signal });
    return Response.json({ text }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (!isAiError(error)) console.error("[dictation]", error);
    // A provider's own answer stays in the server's log, as on the other AI routes.
    if (!isAiError(error) || error.code === "provider") return fail("provider", "The recording couldn't be written down", 502);
    return fail(error.code, error.message, aiErrorStatus(error.code));
  }
}

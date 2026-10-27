import { auth } from "@/lib/auth";
import { aiErrorStatus, isAiError, sttLimits } from "@/server/ai";
import { audioError as fail, readAudioForm } from "@/server/audio-upload";
import { isCrossSite } from "@/server/cross-site";
import { statedLocale } from "@/server/mail/locale";
import { addMeetingChunk, isMeetingError } from "@/server/meetings";

const MEETING_STATUS: Record<string, number> = { noAccess: 403, notFound: 404, disabled: 403, busy: 409, tooLong: 413, notRecording: 409, invalid: 400 };

/**
 * A piece of a meeting's recording (see server/meetings.ts): `POST /api/meetings/chunk` with
 * multipart form data: `audio` (about 30 seconds), `pageId`, `meetingId`, `chunk` (its number),
 * `offset` and `duration` (seconds into the meeting, pauses left out). Answers `{"text":"…"}`, what
 * was heard, once it is in the block's transcript; or a status and `{"error":{"code","message"}}`
 * (lib/ai AI_ERROR_CODES, or server/meetings MEETING_ERRORS). Closing the request cancels it.
 *
 * Signed-in browsers only (the session cookie); the cross-site check keeps other sites' pages from
 * posting here, as on the voice note route.
 */
export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers }).catch(() => null);
  if (!session) return fail("noAccess", "Sign in to record meetings", 401);
  if (isCrossSite(request)) return fail("noAccess", "Cross-site requests aren't allowed", 403);
  const limits = sttLimits();
  if (!limits) return fail("disabled", "Speech to text is not configured on this server", 403);
  const read = await readAudioForm(request, limits.maxBytes);
  if (read instanceof Response) return read;
  const field = (name: string) => {
    const value = read.form.get(name);
    return typeof value === "string" ? value.trim().slice(0, 100) : "";
  };
  const place = {
    pageId: field("pageId"),
    meetingId: field("meetingId"),
    chunk: Number(field("chunk")),
    offset: Number(field("offset")),
    duration: Number(field("duration")),
  };
  if (!place.pageId || !place.meetingId) return fail("invalid", "Say which meeting: pageId and meetingId", 400);

  try {
    const { text } = await addMeetingChunk(session.user.id, place, read.audio, { signal: request.signal, language: statedLocale(request.headers) });
    return Response.json({ text }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (isMeetingError(error)) return fail(error.code, error.message, MEETING_STATUS[error.code] ?? 400);
    if (!isAiError(error)) console.error("[meetings]", error);
    // A provider's own answer stays in the server's log, as on the other AI routes.
    if (!isAiError(error) || error.code === "provider") return fail("provider", "The recording couldn't be written down", 502);
    return fail(error.code, error.message, aiErrorStatus(error.code));
  }
}

import { auth } from "@/lib/auth";
import { AccessError } from "@/server/access";
import { aiErrorStatus, isAiError, sttLimits } from "@/server/ai";
import { audioError as fail, readAudioForm } from "@/server/audio-upload";
import { isCrossSite } from "@/server/cross-site";
import { draftVoiceNote, prepareVoiceNote, type VoiceNoteTarget } from "@/server/voice-notes";

/**
 * Voice notes (see server/voice-notes.ts): `POST /api/ai/voice-note` with multipart form data:
 * `audio` (the recording), and where the note goes: `workspaceId` (and optionally `databaseId`) for
 * the quick note, or `pageId` for the editor. Nothing is saved here: the answer is the note as the
 * AI wrote it up, which the quick note saves and the editor inserts.
 *
 * Answers with newline-delimited JSON while it works: `{"type":"stage","stage":"writing"}` once
 * the transcript is done, then `{"type":"done","draft":{…}}` or `{"type":"error","code":"…"}`
 * (codes of lib/ai AI_ERROR_CODES). Checks that fail before anything is sent answer with a status
 * and `{"error":{"code","message"}}`. Closing the request cancels the work.
 *
 * Signed-in browsers only (the session cookie). A form post needs no CORS preflight, so the
 * cross-site check is what keeps other sites' pages from posting here.
 */
export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers }).catch(() => null);
  if (!session) return fail("noAccess", "Sign in to record voice notes", 401);
  if (isCrossSite(request)) return fail("noAccess", "Cross-site requests aren't allowed", 403);
  const limits = sttLimits();
  if (!limits) return fail("disabled", "Speech to text is not configured on this server", 403);
  const read = await readAudioForm(request, limits.maxBytes);
  if (read instanceof Response) return read;
  const { form, audio } = read;
  const field = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" && value.trim() ? value.trim().slice(0, 100) : null;
  };
  const pageId = field("pageId");
  const workspaceId = field("workspaceId");
  let target: VoiceNoteTarget;
  if (pageId) target = { pageId };
  else if (workspaceId) target = { workspaceId, databaseId: field("databaseId") };
  else return fail("invalid", "Say where the note goes: workspaceId or pageId", 400);

  let prepared;
  try {
    prepared = await prepareVoiceNote(session.user.id, target);
  } catch (error) {
    if (isAiError(error)) return fail(error.code, error.message, aiErrorStatus(error.code));
    if (error instanceof AccessError) return fail("noAccess", "Not found", 404);
    throw error;
  }

  const cancel = new AbortController();
  const signal = AbortSignal.any([request.signal, cancel.signal]);
  const encoder = new TextEncoder();
  const line = (value: unknown) => encoder.encode(`${JSON.stringify(value)}\n`);
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const draft = await draftVoiceNote(session.user.id, prepared, audio, {
          signal,
          onStage: (stage) => controller.enqueue(line({ type: "stage", stage })),
        });
        controller.enqueue(line({ type: "done", draft }));
      } catch (error) {
        if (!isAiError(error)) console.error("[voice note]", error);
        controller.enqueue(line({ type: "error", code: isAiError(error) ? error.code : "provider" }));
      } finally {
        try {
          controller.close();
        } catch {}
      }
    },
    cancel() {
      cancel.abort();
    },
  });
  return new Response(body, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
  });
}

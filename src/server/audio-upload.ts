/**
 * A recording sent from the browser as multipart form data (`audio`, plus the route's own fields),
 * as the voice note and dictation routes take it: read up to the server's size limit for speech to
 * text, and refused with the route's error answer when it isn't usable audio.
 */
import { voiceAudioType } from "@/lib/voice-notes";
import { BodyTooLargeError, readFormLimited } from "@/server/request-body";

export type AudioForm = { form: FormData; audio: { bytes: Blob; type: string } };

/** The form and its audio, or the answer to give: `{"error":{"code","message"}}` with a status. */
export async function readAudioForm(request: Request, maxBytes: number): Promise<AudioForm | Response> {
  if (!(request.headers.get("content-type") ?? "").includes("multipart/form-data")) return audioError("invalid", "Send multipart form data", 415);
  // Room for the form's other fields on top of the audio; a larger body isn't read to its end.
  let form: FormData | null;
  try {
    form = await readFormLimited(request, maxBytes + 64 * 1024);
  } catch (error) {
    if (error instanceof BodyTooLargeError) return tooLarge(maxBytes);
    form = null;
  }
  const audio = form?.get("audio");
  if (!form || !(audio instanceof Blob)) return audioError("invalid", "Send the recording as `audio`", 400);
  const type = voiceAudioType(audio.type, audio instanceof File ? audio.name : null);
  if (!type) return audioError("invalid", "This kind of audio file isn't supported", 415);
  if (!audio.size) return audioError("invalid", "The recording is empty", 400);
  if (audio.size > maxBytes) return tooLarge(maxBytes);
  return { form, audio: { bytes: audio, type } };
}

function tooLarge(maxBytes: number) {
  return audioError("tooLarge", `Recordings can be at most ${Math.round(maxBytes / 1024 / 1024)} MB`, 413);
}

/** An error answer as the AI routes give them. */
export function audioError(code: string, message: string, status: number) {
  return Response.json({ error: { code, message } }, { status });
}

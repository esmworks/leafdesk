/** Recordings posted from the browser, as the voice note and dictation routes read them. */
import { describe, expect, it } from "vitest";
import { readAudioForm } from "./audio-upload";

const post = (form: FormData) => new Request("http://localhost/api/ai/transcribe", { method: "POST", body: form });
const recording = (size: number, type = "audio/webm", name = "voice-note.webm") => new File([new Uint8Array(size)], name, { type });

async function errorOf(result: Awaited<ReturnType<typeof readAudioForm>>) {
  expect(result).toBeInstanceOf(Response);
  const res = result as Response;
  return { status: res.status, code: ((await res.json()) as { error: { code: string } }).error.code };
}

describe("readAudioForm", () => {
  it("gives the audio with its type, and the form's other fields", async () => {
    const form = new FormData();
    form.append("audio", recording(100, "audio/webm;codecs=opus"));
    form.append("workspaceId", "w1");
    const result = await readAudioForm(post(form), 1024);
    expect(result).not.toBeInstanceOf(Response);
    const { form: read, audio } = result as Exclude<typeof result, Response>;
    expect(audio.type).toBe("audio/webm");
    expect(audio.bytes.size).toBe(100);
    expect(read.get("workspaceId")).toBe("w1");
  });

  it("guesses the type from the name when the browser didn't say", async () => {
    const form = new FormData();
    form.append("audio", recording(10, "application/octet-stream", "memo.m4a"));
    const result = await readAudioForm(post(form), 1024);
    expect((result as Exclude<typeof result, Response>).audio.type).toBe("audio/mp4");
  });

  it("refuses what isn't a usable recording", async () => {
    expect(await errorOf(await readAudioForm(new Request("http://localhost/x", { method: "POST", body: "{}" }), 1024))).toEqual({ status: 415, code: "invalid" });
    const none = new FormData();
    none.append("workspaceId", "w1");
    expect(await errorOf(await readAudioForm(post(none), 1024))).toEqual({ status: 400, code: "invalid" });
    const text = new FormData();
    text.append("audio", recording(10, "text/plain", "notes.txt"));
    expect(await errorOf(await readAudioForm(post(text), 1024))).toEqual({ status: 415, code: "invalid" });
    const empty = new FormData();
    empty.append("audio", recording(0));
    expect(await errorOf(await readAudioForm(post(empty), 1024))).toEqual({ status: 400, code: "invalid" });
  });

  it("refuses a recording over the size limit", async () => {
    const small = new FormData();
    small.append("audio", recording(2048));
    expect(await errorOf(await readAudioForm(post(small), 1024))).toEqual({ status: 413, code: "tooLarge" });
    // A body declared larger than the limit (and its fields' room) isn't read at all.
    const huge = new FormData();
    huge.append("audio", recording(200 * 1024));
    const encoded = new Response(huge);
    const body = await encoded.arrayBuffer();
    const headers = { "content-type": encoded.headers.get("content-type")!, "content-length": String(body.byteLength) };
    const request = new Request("http://localhost/api/ai/transcribe", { method: "POST", headers, body });
    expect(await errorOf(await readAudioForm(request, 1024))).toEqual({ status: 413, code: "tooLarge" });
  });
});

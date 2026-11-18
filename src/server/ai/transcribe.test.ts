/** The transcription request and what it reads back, speakers included (diarized models only). */
import { describe, expect, it } from "vitest";
import type { AiSttConfig } from "./config";
import { diarizes, fetchTranscription, parseSegments } from "./transcribe";

const config = (model: string, answer: unknown, seen: { form?: FormData } = {}): AiSttConfig => ({
  provider: "openai-compatible",
  model,
  baseUrl: "http://stt.invalid/v1",
  apiKey: null,
  maxSeconds: 600,
  maxBytes: 1024,
  timeoutMs: 1000,
  fetch: async (_url, init) => {
    seen.form = (await new Response(init?.body as BodyInit, { headers: init?.headers as HeadersInit }).formData().catch(() => undefined)) as FormData | undefined;
    return new Response(JSON.stringify(answer), { status: 200 });
  },
});

const audio = { bytes: new Blob(["x"]), type: "audio/webm" };
const diarized = {
  text: "Hello. Yes.",
  segments: [
    { type: "transcript.text.segment", speaker: "A", start: 0, end: 1.5, text: " Hello. " },
    { speaker: "B", start: 2, end: 3, text: "Yes." },
    { speaker: "B", start: 3, end: 3, text: "  " },
  ],
};

describe("diarized transcription", () => {
  it("is asked of models that name themselves diarizing, and only when the caller wants speakers", async () => {
    expect(diarizes({ model: "gpt-4o-transcribe-diarize" })).toBe(true);
    expect(diarizes({ model: "whisper-1" })).toBe(false);
    const seen: { form?: FormData } = {};
    const got = await fetchTranscription(config("gpt-4o-transcribe-diarize", diarized, seen), audio, new AbortController().signal, null, { speakers: true });
    expect(seen.form?.get("response_format")).toBe("diarized_json");
    expect(seen.form?.get("chunking_strategy")).toBe("auto");
    expect(got.segments).toEqual([
      { speaker: "A", start: 0, end: 1.5, text: "Hello." },
      { speaker: "B", start: 2, end: 3, text: "Yes." },
    ]);
    expect(got.text).toBe("Hello. Yes.");
    const plain: { form?: FormData } = {};
    const without = await fetchTranscription(config("gpt-4o-transcribe-diarize", { text: "Hello. Yes." }, plain), audio, new AbortController().signal);
    expect(plain.form?.get("response_format")).toBe("json");
    expect(without.segments).toBeNull();
  });

  it("asks nothing special of other models and ignores segments they send", async () => {
    const seen: { form?: FormData } = {};
    const got = await fetchTranscription(config("whisper-1", diarized, seen), audio, new AbortController().signal, null, { speakers: true });
    expect(seen.form?.get("response_format")).toBe("json");
    expect(seen.form?.get("chunking_strategy")).toBeNull();
    expect(got).toMatchObject({ text: "Hello. Yes.", segments: null });
  });

  it("reads segments leniently", () => {
    expect(parseSegments(undefined)).toBeNull();
    expect(parseSegments([{ text: "" }, null, 4])).toBeNull();
    expect(parseSegments([{ speaker: 2, start: -1, end: "x", text: "a b" }])).toEqual([{ speaker: "2", start: 0, end: 0, text: "a b" }]);
    expect(parseSegments([{ speaker: "Ann Lee!", start: 1, end: 2, text: "x" }])?.[0].speaker).toBe("Ann_Lee_");
  });
});

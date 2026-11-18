/**
 * Speech to text over the OpenAI-compatible `POST <base>/audio/transcriptions` API (OpenAI, local
 * Whisper servers and hosted compatible ones). pi-ai has no transcription API, so this is plain
 * fetch, like embeddings.
 */
import { voiceFileName } from "@/lib/voice-notes";
import type { AiSttConfig } from "./config";
import { AiError } from "./errors";

type TranscriptionResponse = { text?: unknown; duration?: unknown; segments?: unknown };

/** A stretch of speech one speaker said, as a diarizing model reports it (seconds into the audio). */
export type SpokenSegment = { speaker: string; start: number; end: number; text: string };

/**
 * Whether the configured model tells speakers apart. Only OpenAI's `-diarize` models do (the
 * `diarized_json` response: segments with a speaker label, start, end and text); Whisper-style
 * servers ignore the format, so nothing is asked of a model that doesn't say so in its name.
 */
export const diarizes = (config: Pick<AiSttConfig, "model">) => /diarize/i.test(config.model);

/**
 * The segments of a `diarized_json` response, in order, or null when it holds none. A label is kept
 * as the provider wrote it ("A", "B", or the name of a known speaker); segments without text drop.
 */
export function parseSegments(value: unknown): SpokenSegment[] | null {
  if (!Array.isArray(value)) return null;
  const out: SpokenSegment[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const { speaker, start, end, text } = item as Record<string, unknown>;
    if (typeof text !== "string" || !text.trim()) continue;
    const label = typeof speaker === "string" || typeof speaker === "number" ? String(speaker).trim().replace(/[^\w.-]/g, "_").slice(0, 24) : "";
    const from = typeof start === "number" && Number.isFinite(start) && start >= 0 ? start : 0;
    const to = typeof end === "number" && Number.isFinite(end) && end >= from ? end : from;
    out.push({ speaker: label || "0", start: from, end: to, text: text.trim() });
  }
  return out.length ? out : null;
}

/**
 * The ISO 639-1 code a transcription request names for an interface language: Whisper calls
 * Norwegian "no", not "nb". Null for anything that isn't a plain two-letter code.
 */
export function speechLanguage(locale: string | null | undefined): string | null {
  if (!locale || !/^[a-z]{2}$/.test(locale)) return null;
  return locale === "nb" ? "no" : locale;
}

/**
 * The audio's text. `language`, the interface language of whoever recorded it, tells the server
 * what is spoken: guessed from a few seconds of speech, the language often comes out wrong.
 * Throws AiError ("provider"), or the fetch's own error when `signal` aborted it.
 */
export async function fetchTranscription(
  config: AiSttConfig,
  audio: { bytes: Blob; type: string },
  signal: AbortSignal,
  language?: string | null,
  { speakers = false }: { speakers?: boolean } = {},
): Promise<{ text: string; seconds: number | null; segments: SpokenSegment[] | null }> {
  const form = new FormData();
  // Servers decide the format from the file name, so it carries the right extension.
  form.append("file", new File([audio.bytes], voiceFileName(audio.type), { type: audio.type }));
  form.append("model", config.model);
  // Speakers only where the model tells them apart (and the caller wants them); the long-audio
  // chunking those models require above 30 seconds is the provider's own ("auto").
  const diarized = speakers && diarizes(config);
  form.append("response_format", diarized ? "diarized_json" : "json");
  if (diarized) form.append("chunking_strategy", "auto");
  const spoken = speechLanguage(language);
  if (spoken) form.append("language", spoken);
  // Encoded up front: fetch streaming a FormData body can fail outside the request's promise when
  // the request is cancelled, which would surface as an unhandled rejection.
  const encoded = new Response(form);
  const payload = await encoded.arrayBuffer();
  signal.throwIfAborted();
  let res: Response;
  try {
    res = await (config.fetch ?? fetch)(`${config.baseUrl}/audio/transcriptions`, {
      method: "POST",
      signal,
      headers: {
        "Content-Type": encoded.headers.get("content-type")!,
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: payload,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new AiError("provider", `Transcription request failed: ${(error as Error).message}`);
  }
  if (!res.ok) {
    // The body is the provider's error; keep it short and out of the UI.
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    throw new AiError("provider", `Transcription endpoint answered ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  // Most servers answer JSON as asked; some answer the text itself.
  const raw = await res.text();
  let body: TranscriptionResponse | null = null;
  try {
    body = JSON.parse(raw) as TranscriptionResponse;
  } catch {
    return { text: raw.trim(), seconds: null, segments: null };
  }
  const segments = diarized ? parseSegments(body?.segments) : null;
  const text = typeof body?.text === "string" ? body.text.trim() : segments ? segments.map((s) => s.text).join(" ") : null;
  if (text === null) throw new AiError("provider", "Transcription endpoint gave no text");
  return { text, seconds: typeof body.duration === "number" ? body.duration : null, segments };
}

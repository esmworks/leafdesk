/**
 * Speech to text over the OpenAI-compatible `POST <base>/audio/transcriptions` API (OpenAI, local
 * Whisper servers and hosted compatible ones). pi-ai has no transcription API, so this is plain
 * fetch, like embeddings.
 */
import { voiceFileName } from "@/lib/voice-notes";
import type { AiSttConfig } from "./config";
import { AiError } from "./errors";

type TranscriptionResponse = { text?: unknown; duration?: unknown };

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
): Promise<{ text: string; seconds: number | null }> {
  const form = new FormData();
  // Servers decide the format from the file name, so it carries the right extension.
  form.append("file", new File([audio.bytes], voiceFileName(audio.type), { type: audio.type }));
  form.append("model", config.model);
  form.append("response_format", "json");
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
    return { text: raw.trim(), seconds: null };
  }
  if (typeof body?.text !== "string") throw new AiError("provider", "Transcription endpoint gave no text");
  return { text: body.text.trim(), seconds: typeof body.duration === "number" ? body.duration : null };
}

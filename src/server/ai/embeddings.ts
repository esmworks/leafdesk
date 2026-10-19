/**
 * Embeddings over the OpenAI-compatible `POST <base>/embeddings` API (OpenAI, Google's compatible
 * endpoint, Ollama, LM Studio, vLLM, LiteLLM…). pi-ai has no embeddings API, so this is plain fetch.
 */
import type { AiEmbeddingsConfig } from "./config";
import { AiError } from "./errors";

/** Inputs per request; larger calls are split. */
const BATCH = 64;

type EmbeddingsResponse = { data?: { index?: number; embedding?: unknown }[]; usage?: { prompt_tokens?: number } };

export async function fetchEmbeddings(
  config: AiEmbeddingsConfig,
  texts: string[],
  signal: AbortSignal,
): Promise<{ vectors: number[][]; tokens: number }> {
  const vectors: number[][] = [];
  let tokens = 0;
  for (let i = 0; i < texts.length; i += BATCH) {
    const input = texts.slice(i, i + BATCH);
    let res: Response;
    try {
      res = await (config.fetch ?? fetch)(`${config.baseUrl}/embeddings`, {
        method: "POST",
        signal,
        headers: {
          "Content-Type": "application/json",
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: config.model, input, ...(config.dimensions ? { dimensions: config.dimensions } : {}) }),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new AiError("provider", `Embeddings request failed: ${(error as Error).message}`);
    }
    if (!res.ok) {
      // The body is the provider's error; keep it short and out of the UI.
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      throw new AiError("provider", `Embeddings endpoint answered ${res.status}${detail ? `: ${detail}` : ""}`);
    }
    const body = (await res.json().catch(() => null)) as EmbeddingsResponse | null;
    const data = body?.data;
    if (!Array.isArray(data) || data.length !== input.length) throw new AiError("provider", "Embeddings endpoint gave no vectors");
    const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    for (const item of ordered) {
      if (!Array.isArray(item.embedding) || !item.embedding.every((n) => typeof n === "number")) {
        throw new AiError("provider", "Embeddings endpoint gave a malformed vector");
      }
      vectors.push(item.embedding as number[]);
    }
    tokens += body?.usage?.prompt_tokens ?? 0;
  }
  return { vectors, tokens };
}

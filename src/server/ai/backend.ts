/**
 * The pi-ai side of the AI layer: builds one provider for the configured AI_PROVIDER (only the API
 * implementation it needs; SDKs load lazily on the first request) and a Models collection holding
 * it. Nothing outside src/server/ai imports pi-ai, so the library can be swapped here.
 */
import { createModels, createProvider, type Api, type Model, type Models, type ProviderStreams } from "@earendil-works/pi-ai";
import type { AiChatConfig, AiConfig } from "./config";

/** What the service sends requests through: a Models collection and the model to use. */
export type AiBackend = {
  models: Models;
  model: Model<Api>;
  /** Embeddings without HTTP (tests); the service uses the OpenAI-compatible endpoint otherwise. */
  embed?: (texts: string[]) => Promise<number[][]>;
  /** Speech to text without HTTP (tests); the service uses the OpenAI-compatible endpoint otherwise. */
  transcribe?: (audio: { bytes: Blob; type: string }) => Promise<string>;
  /** The provider wants a session id per conversation (OpenCode's `x-opencode-session`). */
  sessions?: boolean;
  /** Requests go through this fetch (a person's own server, see fetch.ts). */
  fetch?: typeof fetch;
};

/** One implementation for all the provider's models, or one per wire API for mixed providers. */
type ApiLoader = () => Promise<ProviderStreams | Partial<Record<Api, ProviderStreams>>>;

/**
 * Per provider kind: its wire API (for models the catalog doesn't know), default endpoint, catalog
 * (for known models' API, endpoint and limits), whether requests carry a session id, and headers
 * every request sends.
 */
const KINDS: Record<
  AiChatConfig["provider"],
  { api: Api; baseUrl: string; streams: ApiLoader; catalog?: () => Promise<readonly Model<Api>[]>; sessions?: boolean; headers?: Record<string, string> }
> = {
  anthropic: {
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    streams: async () => (await import("@earendil-works/pi-ai/api/anthropic-messages.lazy")).anthropicMessagesApi(),
    catalog: async () => (await import("@earendil-works/pi-ai/providers/anthropic")).anthropicProvider().getModels(),
  },
  openai: {
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    streams: async () => (await import("@earendil-works/pi-ai/api/openai-responses.lazy")).openAIResponsesApi(),
    catalog: async () => (await import("@earendil-works/pi-ai/providers/openai")).openaiProvider().getModels(),
  },
  google: {
    api: "google-generative-ai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    streams: async () => (await import("@earendil-works/pi-ai/api/google-generative-ai.lazy")).googleGenerativeAIApi(),
    catalog: async () => (await import("@earendil-works/pi-ai/providers/google")).googleProvider().getModels(),
  },
  // OpenCode Go serves each model over its own API (chat completions, Responses or Anthropic's
  // Messages) and asks clients to name themselves and send a stable id per conversation.
  "opencode-go": {
    api: "openai-completions",
    baseUrl: "https://opencode.ai/zen/go/v1",
    streams: async () => {
      const [{ withOpenCodeSessionHeader }, completions, responses, messages] = await Promise.all([
        import("@earendil-works/pi-ai/providers/opencode-headers"),
        openAICompletions(),
        import("@earendil-works/pi-ai/api/openai-responses.lazy").then((m) => m.openAIResponsesApi()),
        import("@earendil-works/pi-ai/api/anthropic-messages.lazy").then((m) => m.anthropicMessagesApi()),
      ]);
      return {
        "openai-completions": withOpenCodeSessionHeader(completions),
        "openai-responses": withOpenCodeSessionHeader(responses),
        "anthropic-messages": withOpenCodeSessionHeader(messages),
      };
    },
    catalog: async () => (await import("@earendil-works/pi-ai/providers/opencode-go")).opencodeGoProvider().getModels(),
    sessions: true,
    headers: { "User-Agent": "Leafdesk" },
  },
  "openai-compatible": { api: "openai-completions", baseUrl: "", streams: openAICompletions },
  ollama: { api: "openai-completions", baseUrl: "http://localhost:11434/v1", streams: openAICompletions },
  lmstudio: { api: "openai-completions", baseUrl: "http://localhost:1234/v1", streams: openAICompletions },
};

async function openAICompletions() {
  return (await import("@earendil-works/pi-ai/api/openai-completions.lazy")).openAICompletionsApi();
}

/**
 * The model to call: the catalog's entry when pi-ai knows it (limits, costs, compatibility flags),
 * otherwise one described from the settings, so new model ids work without a library update.
 */
async function resolveModel(chat: AiChatConfig, config: AiConfig): Promise<Model<Api>> {
  const kind = KINDS[chat.provider];
  const baseUrl = chat.baseUrl ?? kind.baseUrl;
  const headers = kind.headers ? { headers: kind.headers } : {};
  const known = (await kind.catalog?.())?.find((m) => m.id === chat.model);
  if (known) return { ...known, provider: chat.provider, baseUrl: knownBaseUrl(known, kind.api, chat.baseUrl), ...headers };
  const local = kind.api === "openai-completions";
  return {
    id: chat.model,
    name: chat.model,
    api: kind.api,
    provider: chat.provider,
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: local ? config.limits.contextWindow : 128_000,
    maxTokens: config.limits.maxOutputTokens,
    // Ollama, LM Studio, vLLM and similar servers speak an older dialect of the chat API.
    ...(local
      ? { compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, supportsStore: false, maxTokensField: "max_tokens" } }
      : {}),
    ...headers,
  } as Model<Api>;
}

/**
 * A catalog model's endpoint: the catalog's own, or AI_BASE_URL when set. AI_BASE_URL is the `/v1`
 * root, which Anthropic's client adds itself, so it is dropped for a mixed provider's Messages models.
 */
function knownBaseUrl(known: Model<Api>, kindApi: Api, override: string | null) {
  if (!override) return known.baseUrl;
  return known.api === "anthropic-messages" && kindApi !== "anthropic-messages" ? override.replace(/\/v1$/, "") : override;
}

/** A Models collection with one provider: the configured one, authenticated with our key only. */
export async function createBackend(config: AiConfig): Promise<AiBackend | null> {
  const chat = config.chat;
  if (!chat) return null;
  const kind = KINDS[chat.provider];
  const model = await resolveModel(chat, config);
  const streams = await kind.streams();
  const provider = createProvider({
    id: chat.provider,
    name: chat.provider,
    baseUrl: model.baseUrl,
    // The key comes from our settings, never from the provider's own environment variables or a
    // credential store: what the README documents is what gets used.
    auth: {
      apiKey: {
        name: "AI_API_KEY",
        // Keyless local servers (Ollama, LM Studio) ignore the header, but the client needs a value.
        resolve: async () => ({ auth: { apiKey: chat.apiKey ?? (kind.api === "openai-completions" ? "none" : "") }, source: "AI_API_KEY" }),
      },
    },
    models: [model],
    api: streams,
  });
  const models = createModels();
  models.setProvider(provider);
  return { models, model, sessions: kind.sessions, ...(chat.fetch ? { fetch: chat.fetch } : {}) };
}

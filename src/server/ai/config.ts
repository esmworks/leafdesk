/**
 * AI settings from the environment. AI is off unless AI_PROVIDER and AI_MODEL are set (plus a key
 * for hosted providers); nothing is sent anywhere while it is off. See docs/ai.md.
 */

export const AI_PROVIDERS = ["anthropic", "openai", "google", "opencode-go", "openai-compatible", "ollama", "lmstudio"] as const;
export type AiProviderKind = (typeof AI_PROVIDERS)[number];

/** Chat providers whose requests go to our own server or network by default. */
const LOCAL_DEFAULT_URLS: Partial<Record<AiProviderKind, string>> = {
  ollama: "http://localhost:11434/v1",
  lmstudio: "http://localhost:1234/v1",
};

/** Where a hosted provider's OpenAI-compatible embeddings endpoint is, when it has one. */
const HOSTED_EMBEDDING_URLS: Partial<Record<AiProviderKind, string>> = {
  openai: "https://api.openai.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta/openai",
};

/** The provider's own key variable, read when AI_API_KEY is not set. */
const PROVIDER_KEY_VARS: Partial<Record<AiProviderKind, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
  "opencode-go": "OPENCODE_API_KEY",
};

export type AiChatConfig = {
  provider: AiProviderKind;
  model: string;
  /**
   * A cheaper model at the same provider, with the same key and endpoint, for the simple jobs
   * features.ts marks (AI_FAST_MODEL); those run on `model` without one.
   */
  fastModel?: string;
  /**
   * More models at the same provider, with the same key and endpoint, that people may pick in the
   * AI chat besides `model` and `fastModel` (AI_CHAT_MODELS).
   */
  chatModels?: string[];
  /**
   * Models the library's catalog doesn't know (local and OpenAI-compatible servers, new ids) take
   * images too (AI_IMAGE_INPUT); the catalog says it for the models it knows.
   */
  imageInput?: boolean;
  /** Overrides the provider's endpoint; required for openai-compatible. */
  baseUrl: string | null;
  apiKey: string | null;
  /** Requests go through this instead of the global fetch (a person's own server, see fetch.ts). */
  fetch?: typeof fetch;
};

export type AiEmbeddingsConfig = {
  model: string;
  /** An OpenAI-compatible API root; `/embeddings` is appended. */
  baseUrl: string;
  apiKey: string | null;
  /** Asks the model for vectors of this size, where it supports that. */
  dimensions: number | null;
  /**
   * Semantic search leaves out passages less similar to the query than this (cosine, 0-1). What
   * counts as similar depends on the model; see AI_EMBEDDINGS_MIN_SIMILARITY in docs/ai.md.
   */
  minSimilarity: number;
  fetch?: typeof fetch;
};

export const DEFAULT_MIN_SIMILARITY = 0.3;

/** Where speech goes to be written down: both speak the OpenAI-compatible transcription API. */
export const STT_PROVIDERS = ["openai", "openai-compatible"] as const;
export type SttProviderKind = (typeof STT_PROVIDERS)[number];

/**
 * Speech to text (voice notes), set apart from the chat model because many chat providers can't
 * transcribe. Off unless STT_PROVIDER and STT_MODEL are set.
 */
export type AiSttConfig = {
  provider: SttProviderKind;
  model: string;
  /** An OpenAI-compatible API root; `/audio/transcriptions` is appended. */
  baseUrl: string;
  apiKey: string | null;
  /** Longest recording the app lets people make, in seconds. */
  maxSeconds: number;
  /** Largest audio file one request may send. */
  maxBytes: number;
  timeoutMs: number;
  fetch?: typeof fetch;
};

export type AiLimits = {
  /**
   * Characters of prompt (instructions plus content) one request may send, when set
   * (AI_MAX_INPUT_CHARS). Unset, a request may send what the model's context window takes, and the
   * features that cut what they read to a fixed size use CONTENT_CHARS.
   */
  maxInputChars: number | null;
  /** Tokens one answer may have. */
  maxOutputTokens: number;
  timeoutMs: number;
  /** Requests per person per minute (editor actions, refreshes started). */
  userPerMinute: number;
  /** Requests per workspace per minute, background property values included. */
  workspacePerMinute: number;
  /** Property values worked out at the same time, across the server. */
  concurrency: number;
  /** For openai-compatible servers, whose context size we can't look up. */
  contextWindow: number;
  /**
   * US dollars one chat question, research answer or agent run may spend on the model
   * (AI_RUN_LIMIT_USD): past it, the model answers with what it has. Models without a known price
   * cost nothing here; RUN_ROUNDS bounds them.
   */
  runLimitUsd: number;
};

export type AiConfig = {
  chat: AiChatConfig | null;
  embeddings: AiEmbeddingsConfig | null;
  stt: AiSttConfig | null;
  limits: AiLimits;
  /** Why AI is off although something was set, for the startup log. */
  problems: string[];
};

type Env = Record<string, string | undefined>;

/**
 * Characters of content (a page, a transcript, skills) the features that read a bounded amount
 * take, unless AI_MAX_INPUT_CHARS says otherwise: AI property values over many rows, voice notes,
 * an agent's skills. It keeps their cost per request steady; the chat and agents use the model's
 * context window instead.
 */
export const CONTENT_CHARS = 48_000;

/** The content budget of the features that read a bounded amount (see CONTENT_CHARS). */
export const contentChars = (limits: AiLimits) => limits.maxInputChars ?? CONTENT_CHARS;

const clean = (value: string | undefined) => {
  const v = value?.trim();
  return v ? v : null;
};

/** A positive number from `name`, else `fallback`; a whole one unless `fractions` (dollars). */
function positive(env: Env, name: string, fallback: number, problems: string[], fractions = false) {
  const raw = clean(env[name]);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    problems.push(`${name} must be a positive number (using ${fallback})`);
    return fallback;
  }
  return fractions ? n : Math.floor(n);
}

/**
 * Model turns one chat question, research answer or agent run may take, for models whose price
 * isn't known (local and openai-compatible ones): AI_RUN_LIMIT_USD never stops them.
 */
export const RUN_ROUNDS = 100;

function url(raw: string | null, name: string, problems: string[]) {
  if (raw === null) return null;
  const parsed = URL.parse(raw);
  if (!parsed || !/^https?:$/.test(parsed.protocol)) {
    problems.push(`${name} must be an http(s) URL`);
    return undefined;
  }
  return raw.replace(/\/+$/, "");
}

export function readAiConfig(env: Env = process.env): AiConfig {
  const problems: string[] = [];
  const limits: AiLimits = {
    maxInputChars: clean(env.AI_MAX_INPUT_CHARS) === null ? null : positive(env, "AI_MAX_INPUT_CHARS", CONTENT_CHARS, problems),
    maxOutputTokens: positive(env, "AI_MAX_OUTPUT_TOKENS", 8_192, problems),
    timeoutMs: positive(env, "AI_TIMEOUT_SECONDS", 60, problems) * 1000,
    userPerMinute: positive(env, "AI_RATE_LIMIT", 20, problems),
    workspacePerMinute: positive(env, "AI_WORKSPACE_RATE_LIMIT", 120, problems),
    concurrency: positive(env, "AI_CONCURRENCY", 2, problems),
    contextWindow: positive(env, "AI_CONTEXT_WINDOW", 32_768, problems),
    runLimitUsd: positive(env, "AI_RUN_LIMIT_USD", 10, problems, true),
  };

  const providerRaw = clean(env.AI_PROVIDER)?.toLowerCase() ?? null;
  const model = clean(env.AI_MODEL);
  const fastModel = clean(env.AI_FAST_MODEL);
  const chatModels = [...new Set((env.AI_CHAT_MODELS ?? "").split(",").map((m) => m.trim()))].filter((m) => m && m !== model && m !== fastModel);
  const imageInput = ["1", "true", "yes"].includes(clean(env.AI_IMAGE_INPUT)?.toLowerCase() ?? "");
  let chat: AiChatConfig | null = null;
  let provider: AiProviderKind | null = null;
  if (providerRaw !== null) {
    if (!(AI_PROVIDERS as readonly string[]).includes(providerRaw)) {
      problems.push(`AI_PROVIDER must be one of ${AI_PROVIDERS.join(", ")}`);
    } else {
      provider = providerRaw as AiProviderKind;
      const baseUrl = url(clean(env.AI_BASE_URL), "AI_BASE_URL", problems);
      const keyVar = PROVIDER_KEY_VARS[provider];
      const apiKey = clean(env.AI_API_KEY) ?? (keyVar ? clean(env[keyVar]) : null);
      const resolvedUrl = baseUrl === undefined ? undefined : (baseUrl ?? LOCAL_DEFAULT_URLS[provider] ?? null);
      if (!model) problems.push("AI_MODEL is not set");
      else if (resolvedUrl === undefined) {
        // Reported above.
      } else if (provider === "openai-compatible" && !resolvedUrl) problems.push("AI_BASE_URL is required with AI_PROVIDER=openai-compatible");
      else if (keyVar && !apiKey) problems.push(`AI_API_KEY is required with AI_PROVIDER=${provider}`);
      else {
        chat = {
          provider,
          model,
          ...(fastModel && fastModel !== model ? { fastModel } : {}),
          ...(chatModels.length ? { chatModels } : {}),
          ...(imageInput ? { imageInput } : {}),
          baseUrl: resolvedUrl,
          apiKey,
        };
      }
    }
  } else if (model) {
    problems.push("AI_MODEL is set but AI_PROVIDER is not");
  }
  if (fastModel && providerRaw === null) problems.push("AI_FAST_MODEL is set but AI_PROVIDER is not");
  if (chatModels.length && providerRaw === null) problems.push("AI_CHAT_MODELS is set but AI_PROVIDER is not");

  // Embeddings (semantic search) speak the OpenAI-compatible /embeddings API. They default to the
  // chat provider's endpoint and key; a key is only reused for that same endpoint, never sent to a
  // different host.
  let embeddings: AiEmbeddingsConfig | null = null;
  const embeddingModel = clean(env.AI_EMBEDDINGS_MODEL);
  if (embeddingModel) {
    const explicit = url(clean(env.AI_EMBEDDINGS_BASE_URL), "AI_EMBEDDINGS_BASE_URL", problems);
    const inherited = chat ? inheritedEmbeddingsUrl(chat) : null;
    const baseUrl = explicit === undefined ? null : (explicit ?? inherited);
    const sameEndpoint = baseUrl !== null && baseUrl === inherited;
    const apiKey = clean(env.AI_EMBEDDINGS_API_KEY) ?? (sameEndpoint ? (chat?.apiKey ?? null) : null);
    const dimensions = clean(env.AI_EMBEDDINGS_DIMENSIONS) ? positive(env, "AI_EMBEDDINGS_DIMENSIONS", 0, problems) || null : null;
    const minSimilarity = similarity(env, problems);
    if (!baseUrl) {
      if (explicit !== undefined) problems.push("AI_EMBEDDINGS_BASE_URL is required for embeddings with this AI_PROVIDER");
    } else embeddings = { model: embeddingModel, baseUrl, apiKey, dimensions, minSimilarity };
  }

  const stt = readSttConfig(env, chat, problems);

  return { chat, embeddings, stt, limits, problems };
}

/**
 * Speech to text over the OpenAI-compatible `/audio/transcriptions` API: OpenAI itself, or a
 * server of your own (a local Whisper server, a hosted compatible one) with STT_BASE_URL. Like
 * embeddings, a key is only reused for the endpoint it belongs to.
 */
function readSttConfig(env: Env, chat: AiChatConfig | null, problems: string[]): AiSttConfig | null {
  const providerRaw = clean(env.STT_PROVIDER)?.toLowerCase() ?? null;
  const model = clean(env.STT_MODEL);
  if (providerRaw === null) {
    if (model) problems.push("STT_MODEL is set but STT_PROVIDER is not");
    return null;
  }
  if (!(STT_PROVIDERS as readonly string[]).includes(providerRaw)) {
    problems.push(`STT_PROVIDER must be one of ${STT_PROVIDERS.join(", ")}`);
    return null;
  }
  const provider = providerRaw as SttProviderKind;
  const explicit = url(clean(env.STT_BASE_URL), "STT_BASE_URL", problems);
  if (explicit === undefined) return null;
  const openAi = HOSTED_EMBEDDING_URLS.openai!;
  const baseUrl = explicit ?? (provider === "openai" ? openAi : null);
  if (!model) {
    problems.push("STT_MODEL is not set");
    return null;
  }
  if (!baseUrl) {
    problems.push("STT_BASE_URL is required with STT_PROVIDER=openai-compatible");
    return null;
  }
  const inherited = chat ? inheritedEmbeddingsUrl(chat) : null;
  const apiKey =
    clean(env.STT_API_KEY) ??
    (baseUrl === openAi ? clean(env.OPENAI_API_KEY) : null) ??
    (baseUrl === inherited ? (chat?.apiKey ?? null) : null);
  if (provider === "openai" && !apiKey) {
    problems.push("STT_API_KEY is required with STT_PROVIDER=openai");
    return null;
  }
  return { provider, model, baseUrl, apiKey, ...readSttLimits(env, problems) };
}

/** How long and large recordings may be, and how long transcribing one may take. */
export function readSttLimits(env: Env, problems: string[]) {
  return {
    maxSeconds: positive(env, "STT_MAX_SECONDS", 600, problems),
    maxBytes: positive(env, "STT_MAX_MB", 25, problems) * 1024 * 1024,
    timeoutMs: positive(env, "STT_TIMEOUT_SECONDS", 120, problems) * 1000,
  };
}

/** What an own AI account (server/ai-accounts.ts) holds, its key opened. */
export type AiAccountSettings = {
  provider: Exclude<AiProviderKind, "ollama" | "lmstudio">;
  model: string;
  /** openai-compatible only; ignored for hosted providers, which have fixed endpoints. */
  baseUrl: string | null;
  apiKey: string | null;
  embeddingsModel: string | null;
  sttModel: string | null;
};

/**
 * The settings a workspace's AI runs on when it uses an own AI account: its chat model, and
 * embeddings and speech to text at the same provider with the same key when the account names
 * models for them (never the server's: one account pays for all of a workspace's AI). The server's
 * limits still apply. Requests to a typed base URL go through `guardedFetch`.
 *
 * The account's model answers every feature, the simple jobs too: AI_FAST_MODEL names a model at
 * the server's provider, which the account may not offer, and the account's owner chose what
 * their key pays for. Each feature's thinking level still applies.
 */
export function accountAiConfig(account: AiAccountSettings, guardedFetch: typeof fetch, env: Env = process.env): AiConfig {
  const problems: string[] = [];
  const base = readAiConfig(env);
  const typed = account.provider === "openai-compatible";
  const chat: AiChatConfig = {
    provider: account.provider,
    model: account.model,
    baseUrl: typed ? account.baseUrl : null,
    apiKey: account.apiKey,
    ...(typed ? { fetch: guardedFetch } : {}),
  };
  const embeddingsUrl = inheritedEmbeddingsUrl(chat);
  const embeddings: AiEmbeddingsConfig | null =
    account.embeddingsModel && embeddingsUrl
      ? { model: account.embeddingsModel, baseUrl: embeddingsUrl, apiKey: account.apiKey, dimensions: null, minSimilarity: DEFAULT_MIN_SIMILARITY, fetch: guardedFetch }
      : null;
  const sttUrl = account.provider === "openai" ? HOSTED_EMBEDDING_URLS.openai! : typed ? account.baseUrl : null;
  const stt: AiSttConfig | null =
    account.sttModel && sttUrl
      ? {
          provider: typed ? "openai-compatible" : "openai",
          model: account.sttModel,
          baseUrl: sttUrl,
          apiKey: account.apiKey,
          ...readSttLimits(env, problems),
          fetch: guardedFetch,
        }
      : null;
  return { chat, embeddings, stt, limits: base.limits, problems };
}

function similarity(env: Env, problems: string[]) {
  const raw = clean(env.AI_EMBEDDINGS_MIN_SIMILARITY);
  if (raw === null) return DEFAULT_MIN_SIMILARITY;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n >= 1) {
    problems.push(`AI_EMBEDDINGS_MIN_SIMILARITY must be a number from 0 to below 1 (using ${DEFAULT_MIN_SIMILARITY})`);
    return DEFAULT_MIN_SIMILARITY;
  }
  return n;
}

/**
 * The chat provider's OpenAI-compatible API root, where embeddings go by default: the configured
 * server for local and compatible providers, OpenAI's (or its override) and Google's compatible
 * endpoint. Anthropic and OpenCode Go have no embeddings API.
 */
function inheritedEmbeddingsUrl(chat: AiChatConfig): string | null {
  switch (chat.provider) {
    case "openai":
      return chat.baseUrl ?? HOSTED_EMBEDDING_URLS.openai!;
    case "google":
      return HOSTED_EMBEDDING_URLS.google!;
    case "anthropic":
    case "opencode-go":
      return null;
    default:
      return chat.baseUrl;
  }
}

/** One line for the startup log; never includes keys. */
export function describeAiConfig(config: AiConfig): string {
  const parts: string[] = [];
  if (config.chat) {
    const where = config.chat.baseUrl ? ` at ${config.chat.baseUrl}` : "";
    parts.push(`AI: ${config.chat.provider} ${config.chat.model}${where}`);
    if (config.chat.fastModel) parts.push(`fast model: ${config.chat.fastModel}`);
    if (config.chat.chatModels?.length) parts.push(`chat models: ${config.chat.chatModels.join(", ")}`);
  } else {
    parts.push("AI: off");
  }
  if (config.embeddings) parts.push(`embeddings: ${config.embeddings.model} at ${config.embeddings.baseUrl}`);
  if (config.stt) parts.push(`speech to text: ${config.stt.model} at ${config.stt.baseUrl}`);
  if (config.problems.length) parts.push(`(${config.problems.join("; ")})`);
  return parts.join(", ");
}

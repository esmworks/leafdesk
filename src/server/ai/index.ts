/**
 * The app's AI interface. Features (the editor's writing assistant, AI autofill properties, and
 * later semantic search and the chat panel) call these functions and never the AI library, so the
 * library behind them (pi-ai, see backend.ts) can be swapped.
 *
 * - `isEnabled()` / `aiInfo()`: whether a provider is configured (env, see config.ts).
 * - `complete()` / `stream()`: one model turn, optionally with tools (tool calls come back for the
 *   caller to run and answer with `role: "tool"` messages).
 * - `embed()`: vectors for texts, over an OpenAI-compatible /embeddings endpoint.
 *
 * Every request is size-checked, time-limited, rate-limited per person and workspace, and logged
 * with its token usage but never its content. Callers check page access before building prompts:
 * nothing here knows about pages.
 */
import { randomUUID } from "node:crypto";
import { Type, type Api, type AssistantMessage, type Context, type Message, type Model, type Tool } from "@earendil-works/pi-ai";
import { sharedLimiter, takeAll, type SlidingWindowLimiter } from "@/lib/rate-limit";
import { redactText } from "@/lib/redact";
import { createBackend, type AiBackend } from "./backend";
import { DEFAULT_MIN_SIMILARITY, describeAiConfig, readAiConfig, type AiConfig } from "./config";
import { fetchEmbeddings } from "./embeddings";
import { AiError } from "./errors";

export { AiError, aiErrorStatus, isAiError } from "./errors";
export type { AiConfig, AiLimits } from "./config";

// ------------------------------------------------------------------------------------ types

export type AiToolCall = { id: string; name: string; arguments: Record<string, unknown> };

/** A tool the model may call; `parameters` is a JSON Schema object. */
export type AiTool = { name: string; description: string; parameters: Record<string, unknown> };

export type AiMessage =
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string;
      toolCalls?: AiToolCall[];
      /** The library's own message, so a conversation passed back keeps provider details. */
      raw?: unknown;
    }
  | { role: "tool"; toolCallId: string; name: string; content: string; isError?: boolean };

export type AiRequest = {
  /** What asks, for usage logs and limits, e.g. "editor.improve" or "property.summary". */
  feature: string;
  /** Who asks: limited per person and workspace (see AI_RATE_LIMIT / AI_WORKSPACE_RATE_LIMIT). */
  userId?: string | null;
  workspaceId?: string | null;
  /** Background work takes from the workspace's allowance itself (see takeWorkspaceCapacity). */
  skipRateLimit?: boolean;
  system?: string;
  messages: AiMessage[];
  tools?: AiTool[];
  /** At most AI_MAX_OUTPUT_TOKENS. */
  maxOutputTokens?: number;
  signal?: AbortSignal;
  /**
   * The same for every turn of one conversation, for providers that want it (OpenCode Go); a
   * request without one is its own session.
   */
  sessionId?: string;
};

export type AiUsage = { inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number };

export type AiResult = {
  text: string;
  toolCalls: AiToolCall[];
  /** "length": the answer hit the output limit and is cut off. */
  stopReason: "stop" | "length" | "tool_use";
  usage: AiUsage;
  /** The answer as a message, to append to `messages` for the next turn. */
  message: Extract<AiMessage, { role: "assistant" }>;
};

export type AiStreamEvent = { type: "text"; delta: string };

/** Text as it arrives; `result()` settles with the whole answer, or rejects with an AiError. */
export type AiStream = AsyncIterable<AiStreamEvent> & { result(): Promise<AiResult> };

// ---------------------------------------------------------------------------------- runtime

type Runtime = {
  config?: AiConfig;
  backend?: Promise<AiBackend | null>;
  /** Tests (see testing.ts) replace the settings and the backend. */
  override?: { config: AiConfig; backend: AiBackend | null };
};

// On globalThis: Next bundles route handlers apart from the custom server, and both must share one
// configuration, one set of limits and the test override.
const KEY = "__leafdeskAi";
const runtime = ((globalThis as Record<string, unknown>)[KEY] ??= {}) as Runtime;

export function aiConfig(): AiConfig {
  if (runtime.override) return runtime.override.config;
  return (runtime.config ??= readAiConfig());
}

async function backend(): Promise<AiBackend> {
  if (runtime.override?.backend) return runtime.override.backend;
  const config = aiConfig();
  if (!config.chat) throw new AiError("disabled", "AI is not configured on this server");
  runtime.backend ??= createBackend(config).catch((error) => {
    runtime.backend = undefined;
    throw error;
  });
  const found = await runtime.backend;
  if (!found) throw new AiError("disabled", "AI is not configured on this server");
  return found;
}

/** For testing.ts only. */
export function setAiOverride(override: Runtime["override"]) {
  runtime.override = override;
  runtime.backend = undefined;
}

/** Whether a chat model is configured (the server's setting; workspaces may still turn AI off). */
export function isEnabled(): boolean {
  return aiConfig().chat !== null;
}

export function embeddingsEnabled(): boolean {
  const override = runtime.override;
  if (override) return Boolean(override.backend?.embed) || override.config.embeddings !== null;
  return aiConfig().embeddings !== null;
}

/**
 * The embeddings model's name, stored with each vector so vectors of another model are never
 * compared; null without embeddings. Tests that embed in-process use "test".
 */
export function embeddingModel(): string | null {
  const config = aiConfig();
  if (config.embeddings) return config.embeddings.model;
  return runtime.override?.backend?.embed ? "test" : null;
}

/** How similar a passage must be to a query to count as a semantic match (see config.ts). */
export function minSimilarity(): number {
  return aiConfig().embeddings?.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
}

/** Provider and model names for settings pages and logs; null while AI is off. */
export function aiInfo(): { provider: string; model: string } | null {
  const chat = aiConfig().chat;
  return chat ? { provider: chat.provider, model: chat.model } : null;
}

export function describeAiSetup(): string {
  return describeAiConfig(aiConfig());
}

// ----------------------------------------------------------------------------------- limits

const WINDOW_MS = 60_000;
const userLimiter = (): SlidingWindowLimiter => sharedLimiter("ai:user", aiConfig().limits.userPerMinute, WINDOW_MS);
const workspaceLimiter = (): SlidingWindowLimiter => sharedLimiter("ai:workspace", aiConfig().limits.workspacePerMinute, WINDOW_MS);

/** Takes one request from the person's and the workspace's allowance, or throws "rateLimited". */
export function takeRateLimit(who: { userId?: string | null; workspaceId?: string | null }) {
  const entries: [SlidingWindowLimiter, string][] = [];
  if (who.userId) entries.push([userLimiter(), who.userId]);
  if (who.workspaceId) entries.push([workspaceLimiter(), who.workspaceId]);
  const wait = takeAll(entries);
  if (wait > 0) throw new AiError("rateLimited", "Too many AI requests; try again shortly", wait);
}

/**
 * For background work: takes one request from the workspace's allowance and returns 0, or returns
 * how many milliseconds to wait before trying again (nothing taken).
 */
export function takeWorkspaceCapacity(workspaceId: string): number {
  return takeAll([[workspaceLimiter(), workspaceId]]);
}

function promptSize(request: AiRequest) {
  let size = request.system?.length ?? 0;
  for (const m of request.messages) size += m.content.length;
  for (const t of request.tools ?? []) size += t.description.length + JSON.stringify(t.parameters).length;
  return size;
}

// ------------------------------------------------------------------------------ conversions

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function toContext(request: AiRequest, model: Model<Api>): Context {
  const now = Date.now();
  const messages: Message[] = request.messages.map((m): Message => {
    if (m.role === "user") return { role: "user", content: m.content, timestamp: now };
    if (m.role === "tool") {
      return {
        role: "toolResult",
        toolCallId: m.toolCallId,
        toolName: m.name,
        content: [{ type: "text", text: m.content }],
        isError: m.isError ?? false,
        timestamp: now,
      } as Message;
    }
    if (m.raw) return m.raw as AssistantMessage;
    return {
      role: "assistant",
      content: [
        ...(m.content ? [{ type: "text" as const, text: m.content }] : []),
        ...(m.toolCalls ?? []).map((c) => ({ type: "toolCall" as const, id: c.id, name: c.name, arguments: c.arguments as never })),
      ],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: ZERO_USAGE,
      stopReason: m.toolCalls?.length ? "toolUse" : "stop",
      timestamp: now,
    } as AssistantMessage;
  });
  const tools: Tool[] | undefined = request.tools?.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: Type.Unsafe(t.parameters),
  }));
  return { systemPrompt: request.system, messages, ...(tools?.length ? { tools } : {}) };
}

function toResult(message: AssistantMessage): AiResult {
  const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  const toolCalls = message.content.flatMap((b) =>
    b.type === "toolCall" ? [{ id: b.id, name: b.name, arguments: (b.arguments ?? {}) as Record<string, unknown> }] : [],
  );
  return {
    text,
    toolCalls,
    stopReason: message.stopReason === "length" ? "length" : message.stopReason === "toolUse" ? "tool_use" : "stop",
    usage: {
      inputTokens: message.usage.input + message.usage.cacheRead + message.usage.cacheWrite,
      outputTokens: message.usage.output,
      totalTokens: message.usage.totalTokens,
      costUsd: message.usage.cost.total,
    },
    message: { role: "assistant", content: text, ...(toolCalls.length ? { toolCalls } : {}), raw: message },
  };
}

// ------------------------------------------------------------------------------------- logs

type LogEntry = {
  feature: string;
  userId?: string | null;
  workspaceId?: string | null;
  status: string;
  ms: number;
  usage?: AiUsage;
  model?: string;
  detail?: string;
};

/** One line per request: who, what for, tokens and time. Never the prompt or the answer; a provider's error with credentials masked. */
function logUsage(entry: LogEntry) {
  const parts = [
    `feature=${entry.feature}`,
    `status=${entry.status}`,
    entry.model ? `model=${entry.model}` : null,
    entry.userId ? `user=${entry.userId}` : null,
    entry.workspaceId ? `workspace=${entry.workspaceId}` : null,
    entry.usage ? `in=${entry.usage.inputTokens} out=${entry.usage.outputTokens}` : null,
    entry.usage?.costUsd ? `cost=$${entry.usage.costUsd.toFixed(5)}` : null,
    `ms=${Math.round(entry.ms)}`,
    entry.detail ? `detail=${JSON.stringify(redactText(entry.detail).slice(0, 300))}` : null,
  ];
  const line = `[ai] ${parts.filter(Boolean).join(" ")}`;
  if (entry.status === "ok" || entry.status === "aborted") console.log(line);
  else console.warn(line);
}

// ------------------------------------------------------------------------------- requests

/** Checks, limits and a combined abort signal (the caller's plus AI_TIMEOUT_SECONDS). */
function prepare(request: AiRequest) {
  const config = aiConfig();
  if (!config.chat && !runtime.override?.backend) throw new AiError("disabled", "AI is not configured on this server");
  if (!request.messages.length) throw new AiError("invalid", "Nothing to send");
  if (promptSize(request) > config.limits.maxInputChars) {
    throw new AiError("tooLarge", `The request is larger than ${config.limits.maxInputChars} characters`);
  }
  if (!request.skipRateLimit) takeRateLimit(request);
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), config.limits.timeoutMs);
  const signal = request.signal ? AbortSignal.any([request.signal, timeout.signal]) : timeout.signal;
  const maxTokens = Math.min(request.maxOutputTokens ?? config.limits.maxOutputTokens, config.limits.maxOutputTokens);
  return {
    signal,
    maxTokens,
    timedOut: () => timeout.signal.aborted,
    cancelled: () => request.signal?.aborted === true,
    done: () => clearTimeout(timer),
  };
}

/** Turns a failed or cancelled answer into an AiError (and logs it). */
function failure(
  message: AssistantMessage | null,
  error: unknown,
  state: { timedOut: boolean; cancelled: boolean },
  entry: Omit<LogEntry, "status">,
): AiError {
  let result: AiError;
  // The caller's cancel wins, however the provider reported it (an error, a closed stream).
  if (state.cancelled) result = new AiError("aborted", "Cancelled");
  else if (state.timedOut) result = new AiError("timeout", "The AI provider took too long to answer");
  else if (message?.stopReason === "aborted" || (error instanceof Error && error.name === "AbortError")) {
    result = new AiError("aborted", "Cancelled");
  } else if (error instanceof AiError) result = error;
  else {
    const detail = message?.errorMessage ?? (error instanceof Error ? error.message : String(error));
    result = new AiError("provider", `The AI provider failed: ${detail}`);
  }
  logUsage({ ...entry, status: result.code, detail: result.code === "provider" ? result.message : undefined });
  return result;
}

/** One model turn, waiting for the whole answer. Throws AiError. */
export async function complete(request: AiRequest): Promise<AiResult> {
  const s = stream(request);
  return s.result();
}

/**
 * One model turn, streamed. Iterate for text as it arrives; `result()` settles when the answer is
 * complete (and rejects with an AiError when it fails, times out or is cancelled). Checks and
 * limits run before anything is sent, so this throws synchronously for oversized or rate-limited
 * requests and when AI is off.
 */
export function stream(request: AiRequest): AiStream {
  const prepared = prepare(request);
  const started = performance.now();
  const queue: AiStreamEvent[] = [];
  let wake = null as (() => void) | null;
  let finished = false;

  const settle = (async (): Promise<AiResult> => {
    let final: AssistantMessage | null = null;
    let model = "";
    try {
      const { models, model: m, sessions } = await backend();
      model = m.id;
      const events = models.stream(m, toContext(request, m), {
        signal: prepared.signal,
        maxTokens: prepared.maxTokens,
        // Only where asked for: other providers would also turn it into prompt-cache keys.
        ...(sessions ? { sessionId: request.sessionId ?? randomUUID() } : {}),
      });
      for await (const event of events) {
        if (event.type === "text_delta" && event.delta) {
          queue.push({ type: "text", delta: event.delta });
          wake?.();
        }
      }
      final = await events.result();
      if (final.stopReason === "error" || final.stopReason === "aborted") throw new Error(final.errorMessage ?? final.stopReason);
      const result = toResult(final);
      logUsage({ feature: request.feature, userId: request.userId, workspaceId: request.workspaceId, status: "ok", ms: performance.now() - started, usage: result.usage, model });
      return result;
    } catch (error) {
      throw failure(final, error, { timedOut: prepared.timedOut(), cancelled: prepared.cancelled() }, {
        feature: request.feature,
        userId: request.userId,
        workspaceId: request.workspaceId,
        ms: performance.now() - started,
        usage: final ? toResult(final).usage : undefined,
        model,
      });
    } finally {
      prepared.done();
      finished = true;
      wake?.();
    }
  })();
  // Callers that only iterate still see the failure through the iterator.
  settle.catch(() => {});

  return {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (queue.length) {
          yield queue.shift()!;
          continue;
        }
        if (finished) {
          await settle;
          return;
        }
        await new Promise<void>((resolve) => (wake = resolve));
        wake = null;
      }
    },
    result: () => settle,
  };
}

/** Vectors for `texts`, in order. Throws AiError ("disabled" without an embeddings model). */
export async function embed(
  texts: string[],
  request: { feature: string; userId?: string | null; workspaceId?: string | null; signal?: AbortSignal; skipRateLimit?: boolean },
): Promise<number[][]> {
  if (!texts.length) return [];
  const config = aiConfig();
  const testing = runtime.override?.backend?.embed;
  if (!testing && !config.embeddings) throw new AiError("disabled", "No embeddings model is configured on this server");
  const size = texts.reduce((n, t) => n + t.length, 0);
  if (size > config.limits.maxInputChars * 4) throw new AiError("tooLarge", "Too much text for one embeddings request");
  if (!request.skipRateLimit) takeRateLimit(request);
  const timeout = AbortSignal.timeout(config.limits.timeoutMs);
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
  const started = performance.now();
  try {
    const { vectors, tokens } = testing
      ? { vectors: await testing(texts), tokens: 0 }
      : await fetchEmbeddings(config.embeddings!, texts, signal);
    logUsage({
      feature: request.feature,
      userId: request.userId,
      workspaceId: request.workspaceId,
      status: "ok",
      ms: performance.now() - started,
      usage: { inputTokens: tokens, outputTokens: 0, totalTokens: tokens, costUsd: 0 },
      model: config.embeddings?.model ?? "test",
    });
    return vectors;
  } catch (error) {
    throw failure(null, error, { timedOut: timeout.aborted, cancelled: request.signal?.aborted === true }, {
      feature: request.feature,
      userId: request.userId,
      workspaceId: request.workspaceId,
      ms: performance.now() - started,
      model: config.embeddings?.model ?? "test",
    });
  }
}

/**
 * The app's AI interface. Features (the editor's writing assistant, AI autofill properties, and
 * later semantic search and the chat panel) call these functions and never the AI library, so the
 * library behind them (pi-ai, see backend.ts) can be swapped.
 *
 * - `aiTargetFor(workspaceId)`: what a workspace's AI runs on: the own AI account attached to it
 *   (OWN_AI_KEYS_ENABLED, see server/ai-accounts.ts), else the server's AI_* settings (unless
 *   AI_ONLY_OWN_KEYS), else nothing. Every request names its workspace and runs on that one
 *   account: one payer per workspace, background work included.
 * - `aiEnabledFor()` / `aiInfoFor()` / `embeddingModelFor()` / `sttLimitsFor()`: per workspace.
 * - `complete()` / `stream()`: one model turn, optionally with tools (tool calls come back for the
 *   caller to run and answer with `role: "tool"` messages).
 * - `embed()`: vectors for texts, over an OpenAI-compatible /embeddings endpoint.
 * - `transcribe()`: the text of spoken audio, over an OpenAI-compatible /audio/transcriptions
 *   endpoint (STT_PROVIDER, set apart from the chat model).
 *
 * Every request is size-checked, time-limited, rate-limited per person and workspace, and logged
 * with its token usage but never its content. Callers check page access before building prompts:
 * nothing here knows about pages.
 */
import { randomUUID } from "node:crypto";
import { Type, type Api, type AssistantMessage, type Context, type Message, type Model, type Tool } from "@earendil-works/pi-ai";
import { sharedLimiter, takeAll, type SlidingWindowLimiter } from "@/lib/rate-limit";
import { env } from "@/lib/env";
import { redactText } from "@/lib/redact";
import { createBackend, streamTurn, type AiBackend, type AiThinking } from "./backend";
import { accountAiConfig, DEFAULT_MIN_SIMILARITY, describeAiConfig, readAiConfig, readSttLimits, type AiConfig } from "./config";
import { fetchEmbeddings } from "./embeddings";
import { AiError } from "./errors";
import { featurePlan } from "./features";
import { guardedAiFetch } from "./fetch";
import { fetchTranscription } from "./transcribe";

export { AiError, aiErrorStatus, isAiError } from "./errors";
export type { AiConfig, AiLimits } from "./config";
export type { AiThinking } from "./backend";

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
  /**
   * What asks, for usage logs and limits, e.g. "editor.improve" or "property.summary"; also picks
   * the model and thinking (see features.ts).
   */
  feature: string;
  /** Who asks: limited per person and workspace (see AI_RATE_LIMIT / AI_WORKSPACE_RATE_LIMIT). */
  userId?: string | null;
  /** The workspace the request is for: its AI account answers and pays. Required: no workspace, no AI. */
  workspaceId: string;
  /** Background work takes from the workspace's allowance itself (see takeWorkspaceCapacity). */
  skipRateLimit?: boolean;
  system?: string;
  messages: AiMessage[];
  tools?: AiTool[];
  /**
   * At most AI_MAX_OUTPUT_TOKENS. Models that think get all of AI_MAX_OUTPUT_TOKENS instead: their
   * thinking comes out of the same tokens and could leave a smaller cap no room for the answer.
   */
  maxOutputTokens?: number;
  /**
   * How much a model that thinks should think: "off" (or as little as the model allows) and "low"
   * for small answers where thinking costs more than it adds, "medium" below the default. Unset,
   * the feature's (features.ts), else the model's default.
   */
  thinking?: AiThinking;
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

type CachedBackend = { fingerprint: string; backend: Promise<AiBackend | null> };

type Runtime = {
  config?: AiConfig;
  backend?: Promise<AiBackend | null>;
  /** Own AI accounts' backends, by account id; made again when the account changes. */
  accounts?: Map<string, CachedBackend>;
  /**
   * Tests (see testing.ts) replace the server's settings and the backend. Own AI accounts still
   * answer for the workspaces they are attached to.
   */
  override?: { config: AiConfig; backend: AiBackend | null };
};

// On globalThis: Next bundles route handlers apart from the custom server, and both must share one
// configuration, one set of limits and the test override.
const KEY = "__leafdeskAi";
const runtime = ((globalThis as Record<string, unknown>)[KEY] ??= {}) as Runtime;

/** The server's own settings (AI_*), and the limits every request is held to. */
export function aiConfig(): AiConfig {
  if (runtime.override) return runtime.override.config;
  return (runtime.config ??= readAiConfig());
}

/**
 * What a workspace's AI runs on: `accountId` names the own AI account attached to it, null means
 * the server's AI_* settings. `key` changes with what requests are sent with.
 */
export type AiTarget = { key: string; config: AiConfig; accountId: string | null; broken?: boolean };

const instanceTarget = (): AiTarget => ({ key: "instance", config: aiConfig(), accountId: null });

/** The database side of own AI accounts, loaded only once they are on (tests and scripts without a database never load it). */
let accountTargetModule: Promise<typeof import("./account-target")> | undefined;
const accountTarget = () => (accountTargetModule ??= import("./account-target"));

/**
 * What the workspace's AI runs on: its own AI account (while OWN_AI_KEYS_ENABLED), else the
 * server's settings, unless AI_ONLY_OWN_KEYS keeps those from workspaces (null then). With own keys
 * off this reads nothing from the database: the server's settings, as always.
 */
export async function aiTargetFor(workspaceId: string): Promise<AiTarget | null> {
  if (!env.ownAiKeysEnabled) return instanceTarget();
  const { workspaceAiAccount } = await accountTarget();
  const account = await workspaceAiAccount(workspaceId);
  if (account) {
    return {
      key: `account:${account.id}:${account.fingerprint}`,
      config: accountAiConfig(account.settings, guardedAiFetch),
      accountId: account.id,
      broken: account.status === "broken",
    };
  }
  return env.aiOnlyOwnKeys ? null : instanceTarget();
}

/** The test backend, which stands in for the server's settings only (never for an own account). */
const testBackend = (target: AiTarget | null) => (target && target.accountId === null ? runtime.override?.backend : null) ?? null;

/** Whether a workspace without an account of its own gets the server's chat model. */
export const serverAiServesWorkspaces = () => instanceUsable() && chatOn(instanceTarget());

async function backendFor(target: AiTarget): Promise<AiBackend> {
  const testing = testBackend(target);
  if (testing) return testing;
  if (!target.config.chat) throw new AiError("disabled", "AI is not configured for this workspace");
  let pending: Promise<AiBackend | null>;
  if (target.accountId === null) {
    pending = runtime.backend ??= createBackend(target.config).catch((error) => {
      runtime.backend = undefined;
      throw error;
    });
  } else {
    const accounts = (runtime.accounts ??= new Map());
    const id = target.accountId;
    const cached = accounts.get(id);
    if (cached?.fingerprint === target.key) pending = cached.backend;
    else {
      pending = createBackend(target.config).catch((error) => {
        if (accounts.get(id)?.backend === pending) accounts.delete(id);
        throw error;
      });
      accounts.set(id, { fingerprint: target.key, backend: pending });
    }
  }
  const found = await pending;
  if (!found) throw new AiError("disabled", "AI is not configured for this workspace");
  return found;
}

/** Drops an own AI account's cached backend (it changed or is gone). */
export function forgetAiAccount(accountId: string) {
  runtime.accounts?.delete(accountId);
}

/**
 * A backend for settings that aren't saved yet (an own AI account being added or tested), never
 * cached. Answers one short request; throws AiError.
 */
export async function tryAiConfig(config: AiConfig, signal?: AbortSignal): Promise<void> {
  const backend = await createBackend(config);
  if (!backend) throw new AiError("disabled", "Nothing to try");
  const timeout = AbortSignal.timeout(Math.min(config.limits.timeoutMs, 30_000));
  const s = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let final: AssistantMessage | null = null;
  try {
    const context = toContext({ feature: "account.test", workspaceId: "", messages: [{ role: "user", content: "Reply with the word OK." }] }, backend.model);
    // A thinking model could spend all 16 tokens thinking (and the account's money on a word).
    const options = { signal: s, maxTokens: 16, ...(backend.fetch ? { fetch: backend.fetch } : {}), ...(backend.sessions ? { sessionId: randomUUID() } : {}) };
    const events = streamTurn(backend.models, backend.model, context, options, "off");
    final = await events.result();
    if (final.stopReason === "error" || final.stopReason === "aborted") throw new Error(final.errorMessage ?? final.stopReason);
  } catch (error) {
    throw failure(final, error, { timedOut: timeout.aborted, cancelled: signal?.aborted === true }, { feature: "account.test", ms: 0, model: config.chat?.model });
  }
  if (config.embeddings) await fetchEmbeddings(config.embeddings, ["test"], s).catch((error: unknown) => {
    throw failure(null, error, { timedOut: timeout.aborted, cancelled: signal?.aborted === true }, { feature: "account.test", ms: 0, model: config.embeddings?.model });
  });
}

/** For testing.ts only. */
export function setAiOverride(override: Runtime["override"]) {
  runtime.override = override;
  runtime.backend = undefined;
  runtime.accounts?.clear();
}

/** Whether the server's own AI_* settings may serve workspaces (AI_ONLY_OWN_KEYS keeps them from it). */
const instanceUsable = () => !env.aiOnlyOwnKeys;

/**
 * Whether AI could be on in some workspace: the server has a chat model workspaces may use, or
 * people may bring their own keys. Per workspace, see aiEnabledFor.
 */
export function isEnabled(): boolean {
  return (instanceUsable() && aiConfig().chat !== null) || env.ownAiKeysEnabled;
}

const chatOn = (target: AiTarget | null) => Boolean(target && (target.config.chat !== null || testBackend(target)));

/** Whether the workspace has a chat model (its own account's or the server's); owners may still turn AI off there. */
export async function aiEnabledFor(workspaceId: string): Promise<boolean> {
  return chatOn(await aiTargetFor(workspaceId));
}

/** Whether semantic search could run somewhere (the background index's quick check). */
export function embeddingsEnabled(): boolean {
  const override = runtime.override;
  if (env.ownAiKeysEnabled) return true;
  if (override) return Boolean(override.backend?.embed) || override.config.embeddings !== null;
  return aiConfig().embeddings !== null;
}

/**
 * The server's embeddings model's name (see embeddingModelFor); null without one. Tests that embed
 * in-process use "test".
 */
export function embeddingModel(): string | null {
  return modelOf(instanceUsable() ? instanceTarget() : null);
}

function modelOf(target: AiTarget | null): string | null {
  if (!target) return null;
  if (target.config.embeddings) return target.config.embeddings.model;
  return testBackend(target)?.embed ? "test" : null;
}

/**
 * The embeddings model a workspace's semantic search uses, stored with each vector so vectors of
 * another model are never compared (a workspace that switches models is indexed again); null
 * without one.
 */
export async function embeddingModelFor(workspaceId: string): Promise<string | null> {
  return modelOf(await aiTargetFor(workspaceId));
}

/** The embeddings model of a target already looked up (see embeddingModelFor). */
export const embeddingModelOf = (target: AiTarget | null) => modelOf(target);

/** How similar a passage must be to a query to count as a semantic match in the workspace (see config.ts). */
export async function minSimilarityFor(workspaceId: string): Promise<number> {
  return minSimilarityOf(await aiTargetFor(workspaceId));
}

/** minSimilarityFor for a target already looked up. */
export const minSimilarityOf = (target: AiTarget | null) => target?.config.embeddings?.minSimilarity ?? DEFAULT_MIN_SIMILARITY;

/**
 * Whether speech to text could be on somewhere (voice notes' shortcut in the app's manifest);
 * workspaces without it, or with AI off, still go without.
 */
export function sttEnabled(): boolean {
  return (instanceUsable() && aiConfig().stt !== null) || env.ownAiKeysEnabled;
}

/**
 * The largest recordings any workspace may send, for sizing a request before its workspace is
 * known (an own AI account has the server's STT_* limits); null without speech to text anywhere.
 */
export function sttLimits(): { maxSeconds: number; maxBytes: number } | null {
  const stt = instanceUsable() ? aiConfig().stt : null;
  const limits = stt ?? (env.ownAiKeysEnabled ? readSttLimits(process.env, []) : null);
  return limits ? { maxSeconds: limits.maxSeconds, maxBytes: limits.maxBytes } : null;
}

/** The recording limits the browser holds to in the workspace; null without speech to text there. */
export async function sttLimitsFor(workspaceId: string): Promise<{ maxSeconds: number; maxBytes: number } | null> {
  const stt = (await aiTargetFor(workspaceId))?.config.stt;
  return stt ? { maxSeconds: stt.maxSeconds, maxBytes: stt.maxBytes } : null;
}

/**
 * The provider and model names for the workspace's settings and logs, and whether they are an own
 * AI account's; null while the workspace has no AI.
 */
export async function aiInfoFor(workspaceId: string): Promise<{ provider: string; model: string; accountId: string | null; embeddings: string | null } | null> {
  const target = await aiTargetFor(workspaceId);
  const chat = target?.config.chat;
  if (!target || !chat) return null;
  return { provider: chat.provider, model: chat.model, accountId: target.accountId, embeddings: modelOf(target) };
}

/** The server's provider and model names (its AI_* settings); null while unset. */
export function aiInfo(): { provider: string; model: string } | null {
  const chat = aiConfig().chat;
  return chat ? { provider: chat.provider, model: chat.model } : null;
}

export function describeAiSetup(): string {
  const line = describeAiConfig(aiConfig());
  if (!env.ownAiKeysEnabled) return line;
  return `${line}, own AI keys: on${env.aiOnlyOwnKeys ? " (only own keys: the server's AI serves no workspace)" : ""}`;
}

/**
 * Records how an own AI account's request went: a refused key marks it broken for its owner's
 * settings, a request that works marks a broken one working again.
 */
async function noteAccount(target: AiTarget, error: AiError | null) {
  if (!target.accountId) return;
  const { markAccountBroken, markAccountWorking, refusesKey } = await accountTarget();
  if (!error) {
    if (target.broken) await markAccountWorking(target.accountId);
  } else if (error.code === "provider" && refusesKey(error.message)) {
    await markAccountBroken(target.accountId, error.message);
  }
}

const noted = (target: AiTarget, error: AiError | null) => void noteAccount(target, error).catch(() => undefined);

// ----------------------------------------------------------------------------------- limits

const WINDOW_MS = 60_000;
const userLimiter = (): SlidingWindowLimiter => sharedLimiter("ai:user", aiConfig().limits.userPerMinute, WINDOW_MS);
const workspaceLimiter = (): SlidingWindowLimiter => sharedLimiter("ai:workspace", aiConfig().limits.workspacePerMinute, WINDOW_MS);

/**
 * Takes one request from the person's and the workspace's allowance, or throws "rateLimited". Only
 * the person's without a workspace (a refresh that queues background work, which then takes from
 * the workspace's itself); nothing is sent to a provider without one (see AiRequest).
 */
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
  /** The own AI account that answered; none for the server's settings. */
  accountId?: string | null;
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
    entry.accountId ? `account=${entry.accountId}` : null,
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
  if (!request.workspaceId) throw new AiError("disabled", "AI runs only for a workspace");
  // Without own keys this is the whole answer, as it always was; with them the workspace decides
  // (in stream, once its account is read).
  if (!env.ownAiKeysEnabled && !config.chat && !runtime.override?.backend) throw new AiError("disabled", "AI is not configured on this server");
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
    // Never above the model's own output limit (a few older models allow 4096).
    maxTokens: (model: Model<Api>) => Math.min(model.reasoning ? config.limits.maxOutputTokens : maxTokens, model.maxTokens || Infinity),
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
 * requests and when the server has no AI at all; a workspace without AI (own keys, see
 * aiTargetFor) rejects `result()` with "disabled".
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
    let target: AiTarget | null = null;
    try {
      target = await aiTargetFor(request.workspaceId);
      if (!chatOn(target)) throw new AiError("disabled", "AI is not configured for this workspace");
      const plan = featurePlan(request.feature);
      const { models, model: main, fast, sessions, fetch: viaFetch } = await backendFor(target!);
      const m = plan.fast && fast ? fast : main;
      model = m.id;
      const events = streamTurn(
        models,
        m,
        toContext(request, m),
        {
          signal: prepared.signal,
          maxTokens: prepared.maxTokens(m),
          ...(viaFetch ? { fetch: viaFetch } : {}),
          // Only where asked for: other providers would also turn it into prompt-cache keys.
          ...(sessions ? { sessionId: request.sessionId ?? randomUUID() } : {}),
        },
        request.thinking ?? plan.thinking,
      );
      for await (const event of events) {
        if (event.type === "text_delta" && event.delta) {
          queue.push({ type: "text", delta: event.delta });
          wake?.();
        }
      }
      final = await events.result();
      if (final.stopReason === "error" || final.stopReason === "aborted") throw new Error(final.errorMessage ?? final.stopReason);
      const result = toResult(final);
      logUsage({
        feature: request.feature,
        userId: request.userId,
        workspaceId: request.workspaceId,
        accountId: target!.accountId,
        status: "ok",
        ms: performance.now() - started,
        usage: result.usage,
        model,
      });
      noted(target!, null);
      return result;
    } catch (error) {
      const failed = failure(final, error, { timedOut: prepared.timedOut(), cancelled: prepared.cancelled() }, {
        feature: request.feature,
        userId: request.userId,
        workspaceId: request.workspaceId,
        accountId: target?.accountId,
        ms: performance.now() - started,
        usage: final ? toResult(final).usage : undefined,
        model,
      });
      if (target) noted(target, failed);
      throw failed;
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

/**
 * The text of spoken audio (`type`: a supported media type, see lib/voice-notes). Size-checked
 * (STT_MAX_MB), time-limited (STT_TIMEOUT_SECONDS) and rate-limited like any AI request; the audio
 * is only held in memory and never stored. Throws AiError: "disabled" without speech to text,
 * "tooLarge", "rateLimited", "timeout", "aborted", "provider", "empty" when nothing was heard.
 */
export async function transcribe(
  audio: { bytes: Blob; type: string },
  request: { feature: string; userId?: string | null; workspaceId: string; signal?: AbortSignal; skipRateLimit?: boolean },
): Promise<string> {
  if (!request.workspaceId) throw new AiError("disabled", "AI runs only for a workspace");
  const target = await aiTargetFor(request.workspaceId);
  const stt = target?.config.stt;
  if (!target || !stt) throw new AiError("disabled", "Speech to text is not configured for this workspace");
  if (!audio.bytes.size) throw new AiError("invalid", "The recording is empty");
  if (audio.bytes.size > stt.maxBytes) throw new AiError("tooLarge", `Recordings can be at most ${Math.round(stt.maxBytes / 1024 / 1024)} MB`);
  if (!request.skipRateLimit) takeRateLimit(request);
  const timeout = AbortSignal.timeout(stt.timeoutMs);
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
  const started = performance.now();
  const testing = testBackend(target)?.transcribe;
  try {
    const { text, seconds } = testing ? { text: await testing(audio), seconds: null } : await fetchTranscription(stt, audio, signal);
    if (!text) throw new AiError("empty", "Nothing was heard in the recording");
    noted(target, null);
    logUsage({
      feature: request.feature,
      userId: request.userId,
      workspaceId: request.workspaceId,
      accountId: target.accountId,
      status: "ok",
      ms: performance.now() - started,
      model: stt.model,
      detail: `bytes=${audio.bytes.size}${seconds ? ` seconds=${Math.round(seconds)}` : ""}`,
    });
    return text;
  } catch (error) {
    const failed = failure(null, error, { timedOut: timeout.aborted, cancelled: request.signal?.aborted === true }, {
      feature: request.feature,
      userId: request.userId,
      workspaceId: request.workspaceId,
      accountId: target.accountId,
      ms: performance.now() - started,
      model: stt.model,
    });
    noted(target, failed);
    throw failed;
  }
}

/** Vectors for `texts`, in order. Throws AiError ("disabled" without an embeddings model). */
export async function embed(
  texts: string[],
  request: { feature: string; userId?: string | null; workspaceId: string; signal?: AbortSignal; skipRateLimit?: boolean },
): Promise<number[][]> {
  if (!texts.length) return [];
  if (!request.workspaceId) throw new AiError("disabled", "AI runs only for a workspace");
  const target = await aiTargetFor(request.workspaceId);
  const config = target?.config ?? aiConfig();
  const testing = testBackend(target)?.embed;
  if (!target || (!testing && !config.embeddings)) throw new AiError("disabled", "No embeddings model is configured for this workspace");
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
    noted(target, null);
    logUsage({
      feature: request.feature,
      userId: request.userId,
      workspaceId: request.workspaceId,
      accountId: target.accountId,
      status: "ok",
      ms: performance.now() - started,
      usage: { inputTokens: tokens, outputTokens: 0, totalTokens: tokens, costUsd: 0 },
      model: config.embeddings?.model ?? "test",
    });
    return vectors;
  } catch (error) {
    const failed = failure(null, error, { timedOut: timeout.aborted, cancelled: request.signal?.aborted === true }, {
      feature: request.feature,
      userId: request.userId,
      workspaceId: request.workspaceId,
      accountId: target.accountId,
      ms: performance.now() - started,
      model: config.embeddings?.model ?? "test",
    });
    noted(target, failed);
    throw failed;
  }
}

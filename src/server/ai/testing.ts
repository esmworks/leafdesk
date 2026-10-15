/**
 * Test doubles for the AI layer, built on pi-ai's faux provider: scripted answers with real
 * streaming, token usage and abort handling, and no network. For unit tests and scripts/ai-e2e.ts;
 * the app itself never imports this.
 */
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, type AssistantMessage } from "@earendil-works/pi-ai";
import { readAiConfig, type AiConfig } from "./config";
import { setAiOverride } from "./index";

/** What an answer script sees of a request: its system prompt and the last user message. */
export type FauxRequest = { system: string; prompt: string };
/** Returns the answer's text, or throws to make the provider fail with that message. */
export type FauxScript = (request: FauxRequest) => string | Promise<string>;

type ContextLike = { systemPrompt?: string; messages: { role: string; content: unknown }[] };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (c && typeof c === "object" && "text" in c ? String(c.text) : "")).join("");
  return "";
}

/**
 * Sends every AI request to a faux model answering with `script`. Settings come from the real
 * environment's limits unless `config` overrides some. Returns the faux handle and a way to change
 * the script.
 */
export function installFauxAi(
  script: FauxScript,
  options: {
    config?: Partial<AiConfig["limits"]>;
    tokensPerSecond?: number;
    embed?: (texts: string[]) => Promise<number[][]>;
    /** Turns speech to text on, answering every recording with this. */
    transcribe?: (audio: { bytes: Blob; type: string }) => Promise<string>;
  } = {},
) {
  let current = script;
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-writer" }], tokensPerSecond: options.tokensPerSecond });
  const answer = async (context: ContextLike): Promise<AssistantMessage> => {
    // The faux provider hands the system prompt over as a "system" message.
    const system = context.systemPrompt ?? context.messages.filter((m) => m.role === "system").map((m) => textOf(m.content)).join("\n");
    const users = context.messages.filter((m) => m.role === "user");
    const prompt = textOf(users[users.length - 1]?.content);
    try {
      return fauxAssistantMessage([fauxText(await current({ system, prompt }))]);
    } catch (error) {
      return fauxAssistantMessage([], { stopReason: "error", errorMessage: (error as Error).message });
    }
  };
  // The faux provider takes answers from a queue; every answer puts another one at its end, so the
  // queue never runs dry however many requests a test makes.
  const step = (context: ContextLike) => {
    faux.appendResponses([step]);
    return answer(context);
  };
  const refill = () => faux.setResponses(Array.from({ length: 50 }, () => step));
  refill();
  const models = createModels();
  models.setProvider(faux.provider);
  const base = readAiConfig({});
  const config: AiConfig = {
    chat: { provider: "openai-compatible", model: "faux-writer", baseUrl: "http://faux.invalid", apiKey: null },
    embeddings: null,
    stt: options.transcribe
      ? { provider: "openai-compatible", model: "faux-listener", baseUrl: "http://faux.invalid", apiKey: null, maxSeconds: 600, maxBytes: 25 * 1024 * 1024, timeoutMs: 60_000 }
      : null,
    limits: { ...base.limits, ...options.config },
    problems: [],
  };
  setAiOverride({ config, backend: { models, model: faux.getModel(), embed: options.embed, transcribe: options.transcribe } });
  return {
    faux,
    setScript(next: FauxScript) {
      current = next;
      refill();
    },
    /** Answers still queued; refilled on setScript. */
    refill,
  };
}

/** Turns AI off (as without AI_PROVIDER), whatever the environment says. */
export function disableAi() {
  setAiOverride({ config: { ...readAiConfig({}), chat: null, embeddings: null, stt: null }, backend: null });
}

/** Uses the real providers with settings read from `env` instead of process.env. */
export function setAiEnv(env: Record<string, string | undefined>) {
  setAiOverride({ config: readAiConfig(env), backend: null });
}

/** Back to the environment's settings. */
export function resetAi() {
  setAiOverride(undefined);
}

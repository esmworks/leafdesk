/**
 * The real request paths (OpenAI-compatible servers such as Ollama, LM Studio, vLLM, Anthropic and
 * OpenCode Go) against a small local stand-in: streamed answers through pi-ai, and embeddings
 * through fetch.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createBackend } from "./backend";
import { readAiConfig } from "./config";
import { complete, embed, stream, tryAiConfig } from "./index";
import { resetAi, setAiEnv } from "./testing";

let server: Server;
let base = "";
const seen: { path: string; auth?: string; headers: IncomingMessage["headers"]; body: Record<string, unknown> }[] = [];
let failNext = false;

async function readBody(req: IncomingMessage) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const body = await readBody(req);
    seen.push({ path: req.url ?? "", auth: req.headers.authorization ?? (req.headers["x-api-key"] as string | undefined), headers: req.headers, body });
    if (failNext) {
      failNext = false;
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "bad key" } }));
      return;
    }
    if (req.url?.startsWith("/v1/messages")) {
      // Anthropic's Messages API, streamed.
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const send = (event: string, data: Record<string, unknown>) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
      send("message_start", { message: { id: "m1", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: 9, output_tokens: 0 } } });
      send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      send("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Bonjour" } });
      send("content_block_stop", { index: 0 });
      send("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } });
      send("message_stop", {});
      res.end();
      return;
    }
    if (req.url === "/v1/embeddings") {
      const input = body.input as string[];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: input.map((t, i) => ({ index: i, embedding: [t.length, i] })).reverse(), usage: { prompt_tokens: 7 } }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
      `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    res.write(chunk({ role: "assistant", content: "Hello" }));
    res.write(chunk({ content: " there" }));
    res.write(chunk({}, "stop"));
    res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: body.model, choices: [], usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
afterEach(() => {
  resetAi();
  seen.length = 0;
});

describe("providers over HTTP", () => {
  it("streams a chat completion with the configured model, system prompt and limits", async () => {
    setAiEnv({ AI_PROVIDER: "ollama", AI_MODEL: "llama3.2", AI_BASE_URL: base, AI_MAX_OUTPUT_TOKENS: "300" });
    const s = stream({ feature: "test", workspaceId: "w1", system: "Be brief.", messages: [{ role: "user", content: "hi" }] });
    let text = "";
    for await (const e of s) if (e.type === "text") text += e.delta;
    const result = await s.result();
    expect(text).toBe("Hello there");
    expect(result.usage).toMatchObject({ inputTokens: 12, outputTokens: 2 });
    const request = seen[0];
    expect(request.path).toBe("/v1/chat/completions");
    // Keyless servers get a placeholder the OpenAI client insists on.
    expect(request.auth).toBe("Bearer none");
    expect(request.body.model).toBe("llama3.2");
    expect(request.body.max_tokens).toBe(300);
    // Older servers don't know the "developer" role.
    expect((request.body.messages as { role: string }[])[0]).toMatchObject({ role: "system", content: "Be brief." });
  });

  it("sends the key and reports the server's refusal", async () => {
    setAiEnv({ AI_PROVIDER: "openai-compatible", AI_MODEL: "m", AI_BASE_URL: base, AI_API_KEY: "sk-local" });
    await complete({ feature: "test", workspaceId: "w1", messages: [{ role: "user", content: "hi" }] });
    expect(seen[0].auth).toBe("Bearer sk-local");
    failNext = true;
    await expect(complete({ feature: "test", workspaceId: "w1", messages: [{ role: "user", content: "hi" }] })).rejects.toMatchObject({ code: "provider" });
  });

  it("speaks Anthropic's Messages API with the key from AI_API_KEY", async () => {
    setAiEnv({ AI_PROVIDER: "anthropic", AI_MODEL: "claude-haiku-4-5", AI_API_KEY: "sk-ant-test", AI_BASE_URL: base.replace(/\/v1$/, "") });
    const result = await complete({ feature: "test", workspaceId: "w1", system: "Translate.", messages: [{ role: "user", content: "Hello" }] });
    expect(result.text).toBe("Bonjour");
    expect(result.usage).toMatchObject({ inputTokens: 9, outputTokens: 3 });
    const request = seen[0];
    expect(request.path).toMatch(/^\/v1\/messages/);
    expect(request.auth).toBe("sk-ant-test");
    expect(request.body.model).toBe("claude-haiku-4-5");
    expect(request.body.stream).toBe(true);
  });

  it.each(["claude-haiku-5-5", "claude-sonnet-5-5"])("knows %s, which thinks, and gives it the whole output limit", async (model) => {
    setAiEnv({ AI_PROVIDER: "anthropic", AI_MODEL: model, AI_API_KEY: "sk-ant-test", AI_BASE_URL: base.replace(/\/v1$/, "") });
    // A feature's smaller cap would leave the answer no room once the model has thought.
    await complete({ feature: "test", workspaceId: "w1", messages: [{ role: "user", content: "Hello" }], maxOutputTokens: 800 });
    const { body } = seen[0];
    expect(body.model).toBe(model);
    expect(body.max_tokens).toBe(8192);
    // Only the library's catalog entry asks for adaptive thinking; an unknown model id gets none.
    expect(body.thinking).toMatchObject({ type: "adaptive" });
  });

  describe("a request that asks for little thinking", () => {
    const anthropic = (model: string) => ({ AI_PROVIDER: "anthropic", AI_MODEL: model, AI_API_KEY: "sk-ant-test", AI_BASE_URL: base.replace(/\/v1$/, "") });
    const ask = (thinking: "off" | "low") =>
      complete({ feature: "test", workspaceId: "w1", messages: [{ role: "user", content: "Hello" }], maxOutputTokens: 800, thinking });
    // The effort for the answer is the last message: a system turn with only output_config.
    const lastEffort = (body: Record<string, unknown>) => (body.messages as { role: string; output_config?: { effort: string } }[]).at(-1);

    it("turns thinking off where the model can stop thinking (claude-haiku-5-5)", async () => {
      setAiEnv(anthropic("claude-haiku-5-5"));
      await ask("off");
      const { body } = seen[0];
      expect(body.thinking).toEqual({ type: "disabled" });
      expect(body.output_config).toBeUndefined();
      expect(lastEffort(body)).toMatchObject({ role: "user" });
      // Still the whole limit: the rule for models that think stays.
      expect(body.max_tokens).toBe(8192);
    });

    it("asks for low effort where the model always thinks (claude-sonnet-5-5)", async () => {
      setAiEnv(anthropic("claude-sonnet-5-5"));
      await ask("off");
      const { body } = seen[0];
      expect(body.thinking).toMatchObject({ type: "adaptive" });
      expect(lastEffort(body)).toEqual({ role: "system", content: [], output_config: { effort: "low" } });
    });

    it("asks for low effort when asked for a little thinking", async () => {
      setAiEnv(anthropic("claude-haiku-5-5"));
      await ask("low");
      expect(seen[0].body.thinking).toMatchObject({ type: "adaptive" });
      expect(lastEffort(seen[0].body)).toMatchObject({ output_config: { effort: "low" } });
    });

    it("leaves the model's own thinking alone otherwise", async () => {
      setAiEnv(anthropic("claude-sonnet-5-5"));
      await complete({ feature: "test", workspaceId: "w1", messages: [{ role: "user", content: "Hello" }] });
      expect(lastEffort(seen[0].body)).toMatchObject({ output_config: { effort: "high" } });
    });

    it("tests an AI account without thinking", async () => {
      await tryAiConfig(readAiConfig(anthropic("claude-haiku-5-5")));
      expect(seen[0].body).toMatchObject({ max_tokens: 16, thinking: { type: "disabled" } });
    });
  });

  describe("each feature's model and thinking", () => {
    // A function: the stand-in's address is known only once it listens.
    const anthropic = () => ({ AI_PROVIDER: "anthropic", AI_MODEL: "claude-opus-5-5", AI_API_KEY: "sk-ant-test", AI_BASE_URL: base.replace(/\/v1$/, "") });
    const send = async (feature: string) => {
      await complete({ feature, workspaceId: "w1", messages: [{ role: "user", content: "Hello" }] });
      const { body } = seen.at(-1)!;
      const last = (body.messages as { output_config?: { effort: string } }[]).at(-1);
      return { model: body.model, thinking: (body.thinking as { type: string }).type, effort: last?.output_config?.effort ?? null };
    };

    it("sends the simple jobs to AI_FAST_MODEL, with the same key, and the rest to AI_MODEL", async () => {
      setAiEnv({ ...anthropic(), AI_FAST_MODEL: "claude-haiku-5-5" });
      expect(await send("property.summary")).toEqual({ model: "claude-haiku-5-5", thinking: "disabled", effort: null });
      expect(await send("property.custom")).toMatchObject({ model: "claude-haiku-5-5", thinking: "disabled" });
      expect(await send("voice.rewrite")).toEqual({ model: "claude-haiku-5-5", thinking: "adaptive", effort: "low" });
      expect(await send("editor.improve")).toEqual({ model: "claude-opus-5-5", thinking: "adaptive", effort: "low" });
      expect(await send("editor.translate")).toMatchObject({ model: "claude-opus-5-5", effort: "low" });
      expect(await send("editor.custom")).toMatchObject({ model: "claude-opus-5-5", effort: "medium" });
      expect(await send("chat")).toEqual({ model: "claude-opus-5-5", thinking: "adaptive", effort: "medium" });
      expect(await send("agent")).toEqual({ model: "claude-opus-5-5", thinking: "adaptive", effort: "high" });
      // An agent its owners put on the fast model.
      expect(await send("agent.fast")).toEqual({ model: "claude-haiku-5-5", thinking: "adaptive", effort: "low" });
      // A feature no one planned for: the main model as it comes.
      expect(await send("something.new")).toMatchObject({ model: "claude-opus-5-5", effort: "high" });
      expect(seen.every((r) => r.auth === "sk-ant-test")).toBe(true);
    });

    it("keeps everything on AI_MODEL without AI_FAST_MODEL, each at its feature's thinking", async () => {
      setAiEnv(anthropic());
      // Opus 5.5 can't stop thinking: as little as it can is low effort.
      expect(await send("property.summary")).toEqual({ model: "claude-opus-5-5", thinking: "adaptive", effort: "low" });
      expect(await send("voice.rewrite")).toMatchObject({ model: "claude-opus-5-5", effort: "low" });
      expect(await send("chat")).toMatchObject({ model: "claude-opus-5-5", effort: "medium" });
      // An agent set to the fast model is an agent like any other here.
      expect(await send("agent.fast")).toEqual({ model: "claude-opus-5-5", thinking: "adaptive", effort: "high" });
    });

    it("lets a request ask for its own thinking", async () => {
      setAiEnv(anthropic());
      await complete({ feature: "chat", workspaceId: "w1", messages: [{ role: "user", content: "Hello" }], thinking: "low" });
      expect((seen[0].body.messages as { output_config?: { effort: string } }[]).at(-1)).toMatchObject({ output_config: { effort: "low" } });
    });

    it("lets a request ask for the model's own thinking over its feature's (the chat's Deep)", async () => {
      setAiEnv(anthropic());
      await complete({ feature: "chat", workspaceId: "w1", messages: [{ role: "user", content: "Hello" }], thinking: "model" });
      expect((seen[0].body.messages as { output_config?: { effort: string } }[]).at(-1)).toMatchObject({ output_config: { effort: "high" } });
    });

    it("takes a fast model the catalog doesn't know as written", async () => {
      setAiEnv({ AI_PROVIDER: "ollama", AI_MODEL: "llama3.2", AI_FAST_MODEL: "llama3.2:1b", AI_BASE_URL: base });
      await complete({ feature: "property.summary", workspaceId: "w1", messages: [{ role: "user", content: "hi" }], maxOutputTokens: 800 });
      await complete({ feature: "chat", workspaceId: "w1", messages: [{ role: "user", content: "hi" }] });
      expect(seen.map((r) => r.body.model)).toEqual(["llama3.2:1b", "llama3.2"]);
      // A model that doesn't think keeps the feature's cap.
      expect(seen[0].body.max_tokens).toBe(800);
    });
  });

  it("asks no more than the model's own output limit", async () => {
    setAiEnv({ AI_PROVIDER: "openai", AI_MODEL: "gpt-4-turbo", AI_API_KEY: "sk-test", AI_BASE_URL: base });
    await complete({ feature: "test", workspaceId: "w1", messages: [{ role: "user", content: "hi" }] }).catch(() => {});
    expect(seen[0].body.max_output_tokens).toBe(4096);
  });

  it("keeps a feature's smaller cap for a model that doesn't think", async () => {
    setAiEnv({ AI_PROVIDER: "ollama", AI_MODEL: "llama3.2", AI_BASE_URL: base });
    await complete({ feature: "test", workspaceId: "w1", messages: [{ role: "user", content: "hi" }], maxOutputTokens: 800 });
    expect(seen[0].body.max_tokens).toBe(800);
  });

  it("sends OpenCode Go a stable session id per conversation and names the client", async () => {
    setAiEnv({ AI_PROVIDER: "opencode-go", AI_MODEL: "kimi-k3", OPENCODE_API_KEY: "sk-go", AI_BASE_URL: base });
    const ask = (sessionId?: string) => complete({ feature: "test", workspaceId: "w1", messages: [{ role: "user", content: "hi" }], sessionId });
    await ask("conv-1");
    await ask("conv-1");
    await ask();
    await ask();
    expect(seen.map((r) => r.path)).toEqual(Array(4).fill("/v1/chat/completions"));
    expect(seen[0].auth).toBe("Bearer sk-go");
    expect(seen[0].body.model).toBe("kimi-k3");
    expect(seen[0].headers["user-agent"]).toBe("Leafdesk");
    const ids = seen.map((r) => r.headers["x-opencode-session"]);
    expect(ids.slice(0, 2)).toEqual(["conv-1", "conv-1"]);
    // Requests outside a conversation are each their own session.
    expect(ids[2]).toMatch(/^[0-9a-f-]{36}$/);
    expect(ids[3]).not.toBe(ids[2]);
  });

  it("sends OpenCode Go's Messages-API models to the Anthropic endpoint, with the session id", async () => {
    setAiEnv({ AI_PROVIDER: "opencode-go", AI_MODEL: "minimax-m3", AI_API_KEY: "sk-go", AI_BASE_URL: base });
    const result = await complete({ feature: "test", workspaceId: "w1", messages: [{ role: "user", content: "Hello" }], sessionId: "conv-2" });
    expect(result.text).toBe("Bonjour");
    expect(seen[0].path).toMatch(/^\/v1\/messages/);
    expect(seen[0].headers["x-opencode-session"]).toBe("conv-2");
    expect(seen[0].headers["user-agent"]).toBe("Leafdesk");
  });

  it("sends OpenRouter's Anthropic models over the Messages API and the rest over chat completions", async () => {
    const openRouter = (model: string) => ({ AI_PROVIDER: "openrouter", AI_MODEL: model, AI_API_KEY: "sk-or-test", AI_BASE_URL: base });
    setAiEnv(openRouter("anthropic/claude-sonnet-5.5"));
    expect((await complete({ feature: "test", workspaceId: "w1", messages: [{ role: "user", content: "Hello" }] })).text).toBe("Bonjour");
    resetAi();
    setAiEnv(openRouter("moonshotai/kimi-k3"));
    expect((await complete({ feature: "test", workspaceId: "w1", messages: [{ role: "user", content: "hi" }] })).text).toBe("Hello there");
    expect(seen.map((r) => r.path.split("?")[0])).toEqual(["/v1/messages", "/v1/chat/completions"]);
    expect(seen.map((r) => r.body.model)).toEqual(["anthropic/claude-sonnet-5.5", "moonshotai/kimi-k3"]);
  });

  it("answers from Moonshot, Z.AI and MiniMax models over their own APIs", async () => {
    setAiEnv({ AI_PROVIDER: "moonshotai", AI_MODEL: "kimi-k3", AI_API_KEY: "sk-moon", AI_BASE_URL: base });
    expect((await complete({ feature: "test", workspaceId: "w1", messages: [{ role: "user", content: "hi" }] })).text).toBe("Hello there");
    resetAi();
    setAiEnv({ AI_PROVIDER: "zai", AI_MODEL: "glm-5.3", AI_API_KEY: "sk-zai", AI_BASE_URL: base });
    expect((await complete({ feature: "test", workspaceId: "w1", messages: [{ role: "user", content: "hi" }] })).text).toBe("Hello there");
    resetAi();
    setAiEnv({ AI_PROVIDER: "minimax", AI_MODEL: "MiniMax-M3", AI_API_KEY: "sk-mm", AI_BASE_URL: base.replace(/\/v1$/, "") });
    expect((await complete({ feature: "test", workspaceId: "w1", messages: [{ role: "user", content: "Hello" }] })).text).toBe("Bonjour");
    expect(seen.map((r) => r.path.split("?")[0])).toEqual(["/v1/chat/completions", "/v1/chat/completions", "/v1/messages"]);
    expect(seen.map((r) => r.auth)).toEqual(["Bearer sk-moon", "Bearer sk-zai", expect.stringContaining("sk-mm")]);
  });

  it("sends xAI's models to its Responses API", async () => {
    setAiEnv({ AI_PROVIDER: "xai", AI_MODEL: "grok-4.7", AI_API_KEY: "xai-test", AI_BASE_URL: base });
    await complete({ feature: "test", workspaceId: "w1", messages: [{ role: "user", content: "hi" }] }).catch(() => {});
    expect(seen[0].path).toBe("/v1/responses");
    expect(seen[0].body.model).toBe("grok-4.7");
  });

  it("calls Z.AI at its pay-as-you-go endpoint, not the coding plan's", async () => {
    for (const model of ["glm-5.3", "glm-9-preview"]) {
      const backend = await createBackend(readAiConfig({ AI_PROVIDER: "zai", AI_MODEL: model, AI_API_KEY: "sk-zai" }));
      expect(backend?.model.baseUrl).toBe("https://api.z.ai/api/paas/v4");
    }
  });

  it("sends no OpenCode session id to other providers", async () => {
    setAiEnv({ AI_PROVIDER: "openai-compatible", AI_MODEL: "m", AI_BASE_URL: base });
    await complete({ feature: "test", workspaceId: "w1", messages: [{ role: "user", content: "hi" }], sessionId: "conv-3" });
    expect(seen[0].headers["x-opencode-session"]).toBeUndefined();
  });

  it("embeds in input order over /embeddings", async () => {
    setAiEnv({ AI_PROVIDER: "ollama", AI_MODEL: "m", AI_BASE_URL: base, AI_EMBEDDINGS_MODEL: "nomic-embed-text" });
    expect(await embed(["abc", "de"], { feature: "test", workspaceId: "w1" })).toEqual([
      [3, 0],
      [2, 1],
    ]);
    expect(seen[0].body).toEqual({ model: "nomic-embed-text", input: ["abc", "de"] });
    failNext = true;
    await expect(embed(["x"], { feature: "test", workspaceId: "w1" })).rejects.toMatchObject({ code: "provider" });
  });
});

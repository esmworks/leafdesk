/**
 * People's own AI accounts (OWN_AI_KEYS_ENABLED) in the AI layer: what an account's settings turn
 * into, the checks a typed base URL goes through, and which settings a workspace's requests run on
 * (its account, the server's, or none). The database side is stubbed (account-target.ts); the
 * e2e script (scripts/own-ai-keys-e2e.ts) covers it.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiAccountSettings } from "./config";
import { accountAiConfig } from "./config";
import { startFakeOpenAi, type FakeOpenAi } from "./fake-openai";
import { checkAiUrl, guardedAiFetch } from "./fetch";
import { aiEnabledFor, aiInfoFor, aiTargetFor, complete, describeAiSetup, embed, embeddingModelFor, isEnabled, sttLimitsFor } from "./index";
import { resetAi, setAiEnv } from "./testing";

const target = vi.hoisted(() => ({
  account: null as null | { id: string; userId: string; status: "active" | "broken"; fingerprint: string; settings: AiAccountSettings },
  lookups: 0,
  broken: [] as { id: string; message: string }[],
  working: [] as string[],
}));

vi.mock("./account-target", () => ({
  workspaceAiAccount: async () => {
    target.lookups++;
    return target.account;
  },
  refusesKey: (message: string) => /\b401\b|incorrect api key/i.test(message),
  markAccountBroken: async (id: string, message: string) => void target.broken.push({ id, message }),
  markAccountWorking: async (id: string) => void target.working.push(id),
}));

const settings = (over: Partial<AiAccountSettings> = {}): AiAccountSettings => ({
  provider: "openai-compatible",
  model: "own-model",
  baseUrl: "https://models.example.com/v1",
  apiKey: "own-key",
  embeddingsModel: null,
  sttModel: null,
  ...over,
});

beforeEach(() => {
  target.account = null;
  target.lookups = 0;
  target.broken = [];
  target.working = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetAi();
});

describe("an own AI account's settings", () => {
  it("runs chat, embeddings and speech to text at the account's provider with its key, and nothing of the server's", () => {
    const viaFetch = vi.fn() as unknown as typeof fetch;
    const openai = accountAiConfig(settings({ provider: "openai", baseUrl: "https://ignored.example.com", embeddingsModel: "emb", sttModel: "whisper" }), viaFetch, {
      AI_EMBEDDINGS_MODEL: "server-emb",
      AI_EMBEDDINGS_BASE_URL: "https://server.example.com/v1",
      STT_PROVIDER: "openai",
      STT_MODEL: "server-stt",
      STT_API_KEY: "server-key",
    });
    // Hosted providers have fixed endpoints: a typed address is ignored, and their own fetch is used.
    expect(openai.chat).toEqual({ provider: "openai", model: "own-model", baseUrl: null, apiKey: "own-key" });
    expect(openai.embeddings).toMatchObject({ model: "emb", baseUrl: "https://api.openai.com/v1", apiKey: "own-key" });
    expect(openai.stt).toMatchObject({ provider: "openai", model: "whisper", baseUrl: "https://api.openai.com/v1", apiKey: "own-key" });

    const typed = accountAiConfig(settings({ embeddingsModel: "emb", sttModel: "stt" }), viaFetch, {});
    expect(typed.chat).toMatchObject({ baseUrl: "https://models.example.com/v1", apiKey: "own-key", fetch: viaFetch });
    expect(typed.embeddings).toMatchObject({ baseUrl: "https://models.example.com/v1", fetch: viaFetch });
    expect(typed.stt).toMatchObject({ provider: "openai-compatible", baseUrl: "https://models.example.com/v1", fetch: viaFetch });

    // No embeddings or speech to text where the provider has none, whatever the server has.
    const anthropic = accountAiConfig(settings({ provider: "anthropic", baseUrl: null, embeddingsModel: "emb", sttModel: "stt" }), viaFetch, {
      AI_EMBEDDINGS_MODEL: "server-emb",
      AI_EMBEDDINGS_BASE_URL: "https://server.example.com/v1",
    });
    expect(anthropic.embeddings).toBeNull();
    expect(anthropic.stt).toBeNull();
    // The server's limits still hold.
    expect(accountAiConfig(settings(), viaFetch, { AI_MAX_INPUT_CHARS: "1234" }).limits.maxInputChars).toBe(1234);
  });
});

describe("a typed base URL", () => {
  it("must be a public https address", () => {
    expect(checkAiUrl("https://models.example.com/v1/")).toEqual({ url: "https://models.example.com/v1", allowed: false });
    for (const bad of [
      "http://models.example.com/v1",
      "https://127.0.0.1/v1",
      "https://[::1]/v1",
      "https://10.0.0.5/v1",
      "https://169.254.169.254/latest",
      "https://localhost:11434/v1",
      "https://ollama.local/v1",
      "https://gpu/v1",
      "https://user:pass@models.example.com/v1",
      "ftp://models.example.com",
      "not a url",
    ]) {
      expect(() => checkAiUrl(bad), bad).toThrow();
    }
  });

  it("may be a local one on AI_ALLOWED_HOSTS, by name or name and port", () => {
    vi.stubEnv("AI_ALLOWED_HOSTS", "gpu, 127.0.0.1:8080");
    expect(checkAiUrl("http://gpu/v1").allowed).toBe(true);
    expect(checkAiUrl("http://127.0.0.1:8080/v1").allowed).toBe(true);
    expect(() => checkAiUrl("http://127.0.0.1:8081/v1")).toThrow(/private address|https/);
  });

  describe("the guarded fetch", () => {
    let server: Server;
    let origin: string;
    beforeAll(async () => {
      server = createServer((req, res) => {
        if (req.url === "/redirect") res.writeHead(302, { Location: "http://169.254.169.254/" }).end();
        else res.writeHead(200).end("ok");
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

    it("refuses a loopback server unless allowed, and never follows a redirect", async () => {
      await expect(guardedAiFetch(`${origin}/ok`)).rejects.toMatchObject({ code: "invalid" });
      vi.stubEnv("AI_ALLOWED_HOSTS", origin.replace("http://", ""));
      expect(await (await guardedAiFetch(`${origin}/ok`)).text()).toBe("ok");
      await expect(guardedAiFetch(`${origin}/redirect`)).rejects.toMatchObject({ code: "provider" });
    });
  });
});

describe("which AI a workspace runs on", () => {
  let fake: FakeOpenAi;
  beforeAll(async () => {
    fake = await startFakeOpenAi(() => ({ text: "from the fake" }));
  });
  afterAll(() => fake.close());
  const allowFake = () => vi.stubEnv("AI_ALLOWED_HOSTS", new URL(fake.baseUrl).host);
  const serverAi = { AI_PROVIDER: "openai-compatible", AI_MODEL: "server-model", AI_BASE_URL: "", AI_API_KEY: "server-key" };

  it("is the server's settings with own keys off, without reading any account", async () => {
    setAiEnv({ ...serverAi, AI_BASE_URL: fake.baseUrl });
    target.account = { id: "a1", userId: "u1", status: "active", fingerprint: "f", settings: settings() };
    expect(await aiTargetFor("w1")).toMatchObject({ key: "instance", accountId: null });
    expect(target.lookups).toBe(0);
    await complete({ feature: "test", workspaceId: "w1", messages: [{ role: "user", content: "hi" }] });
    expect(fake.keys.at(-1)).toBe("server-key");
    expect(describeAiSetup()).not.toMatch(/own AI keys/);
  });

  it("is the workspace's own account with own keys on, with its key and through the guarded fetch", async () => {
    vi.stubEnv("OWN_AI_KEYS_ENABLED", "true");
    allowFake();
    setAiEnv({ ...serverAi, AI_BASE_URL: fake.baseUrl });
    target.account = { id: "a1", userId: "u1", status: "broken", fingerprint: "f", settings: settings({ baseUrl: fake.baseUrl, embeddingsModel: "own-emb" }) };
    const result = await complete({ feature: "test", workspaceId: "w1", messages: [{ role: "user", content: "hi" }] });
    expect(result.text).toBe("from the fake");
    expect(fake.chats.at(-1)?.model).toBe("own-model");
    expect(fake.keys.at(-1)).toBe("own-key");
    expect(await embeddingModelFor("w1")).toBe("own-emb");
    await embed(["a text"], { feature: "test", workspaceId: "w1" });
    expect(fake.keys.at(-1)).toBe("own-key");
    // It worked, so a broken account works again.
    await vi.waitFor(() => expect(target.working).toContain("a1"));

    // Without an account: the server's settings.
    target.account = null;
    await complete({ feature: "test", workspaceId: "w2", messages: [{ role: "user", content: "hi" }] });
    expect(fake.keys.at(-1)).toBe("server-key");
    expect(fake.chats.at(-1)?.model).toBe("server-model");
  });

  it("runs an own account's simple jobs and fast agents on its own model too, never the server's fast model", async () => {
    vi.stubEnv("OWN_AI_KEYS_ENABLED", "true");
    allowFake();
    setAiEnv({ ...serverAi, AI_BASE_URL: fake.baseUrl, AI_FAST_MODEL: "server-fast" });
    target.account = { id: "a2", userId: "u1", status: "active", fingerprint: "f", settings: settings({ baseUrl: fake.baseUrl }) };
    await complete({ feature: "property.summary", workspaceId: "w1", messages: [{ role: "user", content: "hi" }] });
    expect(fake.chats.at(-1)?.model).toBe("own-model");
    expect(fake.keys.at(-1)).toBe("own-key");
    // An agent its owners put on the fast model, too.
    const agent = await complete({ feature: "agent.fast", workspaceId: "w1", messages: [{ role: "user", content: "hi" }] });
    expect(fake.chats.at(-1)?.model).toBe("own-model");
    expect(agent.model).toBe("own-model");
    // So its settings offer agents no choice of model.
    expect(await aiInfoFor("w1")).toMatchObject({ model: "own-model", fastModel: null });
    // A workspace on the server's settings gets the server's fast model.
    target.account = null;
    await complete({ feature: "property.summary", workspaceId: "w2", messages: [{ role: "user", content: "hi" }] });
    expect(fake.chats.at(-1)?.model).toBe("server-fast");
    expect(fake.keys.at(-1)).toBe("server-key");
    await complete({ feature: "agent.fast", workspaceId: "w2", messages: [{ role: "user", content: "hi" }] });
    expect(fake.chats.at(-1)?.model).toBe("server-fast");
    expect(await aiInfoFor("w2")).toMatchObject({ model: "server-model", fastModel: "server-fast" });
  });

  it("is off without an account when only own keys may be used, and the server's key is never sent", async () => {
    vi.stubEnv("OWN_AI_KEYS_ENABLED", "true");
    vi.stubEnv("AI_ONLY_OWN_KEYS", "true");
    setAiEnv({ ...serverAi, AI_BASE_URL: fake.baseUrl, STT_PROVIDER: "openai-compatible", STT_MODEL: "stt", STT_BASE_URL: fake.baseUrl });
    const sent = fake.chats.length;
    expect(await aiTargetFor("w3")).toBeNull();
    expect(await aiEnabledFor("w3")).toBe(false);
    expect(await sttLimitsFor("w3")).toBeNull();
    expect(isEnabled()).toBe(true); // own keys may still turn it on somewhere
    await expect(complete({ feature: "test", workspaceId: "w3", messages: [{ role: "user", content: "hi" }] })).rejects.toMatchObject({ code: "disabled" });
    await expect(embed(["x"], { feature: "test", workspaceId: "w3" })).rejects.toMatchObject({ code: "disabled" });
    expect(fake.chats.length).toBe(sent);
    expect(describeAiSetup()).toMatch(/only own keys/);
  });

  it("refuses a request that names no workspace", async () => {
    setAiEnv({ ...serverAi, AI_BASE_URL: fake.baseUrl });
    await expect(complete({ feature: "test", workspaceId: "", messages: [{ role: "user", content: "hi" }] })).rejects.toMatchObject({ code: "disabled" });
    await expect(embed(["x"], { feature: "test", workspaceId: "" })).rejects.toMatchObject({ code: "disabled" });
  });

  it("marks an account whose key the provider refuses as broken", async () => {
    vi.stubEnv("OWN_AI_KEYS_ENABLED", "true");
    allowFake();
    setAiEnv({});
    fake.setAcceptedKeys(["someone-else"]);
    try {
      target.account = { id: "a2", userId: "u1", status: "active", fingerprint: "g", settings: settings({ baseUrl: fake.baseUrl }) };
      await expect(complete({ feature: "test", workspaceId: "w1", messages: [{ role: "user", content: "hi" }] })).rejects.toMatchObject({ code: "provider" });
      await vi.waitFor(() => expect(target.broken.map((b) => b.id)).toEqual(["a2"]));
    } finally {
      fake.setAcceptedKeys(null);
    }
  });

  it("refuses an account whose base URL became a private address", async () => {
    vi.stubEnv("OWN_AI_KEYS_ENABLED", "true");
    setAiEnv({});
    // Not on AI_ALLOWED_HOSTS: the loopback fake is refused before anything is sent.
    target.account = { id: "a3", userId: "u1", status: "active", fingerprint: "h", settings: settings({ baseUrl: fake.baseUrl }) };
    const sent = fake.chats.length;
    await expect(complete({ feature: "test", workspaceId: "w1", messages: [{ role: "user", content: "hi" }] })).rejects.toBeTruthy();
    expect(fake.chats.length).toBe(sent);
  });
});

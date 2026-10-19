/**
 * How semantic search groups the workspaces it searches by what embeds their queries: each
 * workspace's AI target is read once (an own AI account is a database read each time).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiAccountSettings } from "@/server/ai/config";
import { resetAi, setAiEnv } from "@/server/ai/testing";

const accounts = vi.hoisted(() => ({ lookups: 0 }));

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/server/access", () => ({ pageVisibleTo: vi.fn(), workspacesHeldBack: vi.fn() }));
vi.mock("@/server/semantic-index", () => ({ maybeSweep: vi.fn() }));
vi.mock("@/server/workspaces", () => ({ listWorkspaces: vi.fn(), workspaceSettings: vi.fn() }));
vi.mock("@/server/ai/account-target", () => ({
  workspaceAiAccount: async (workspaceId: string) => {
    accounts.lookups++;
    if (workspaceId !== "own") return null;
    const settings: AiAccountSettings = {
      provider: "openai-compatible",
      model: "own-model",
      baseUrl: "https://models.example.com/v1",
      apiKey: "own-key",
      embeddingsModel: "own-emb",
      sttModel: null,
    };
    return { id: "a1", userId: "u1", status: "active", fingerprint: "f", settings };
  },
  refusesKey: () => false,
  markAccountBroken: vi.fn(),
  markAccountWorking: vi.fn(),
}));

const { embeddingGroups } = await import("./semantic-search");

afterEach(() => {
  vi.unstubAllEnvs();
  resetAi();
});

describe("semantic search's embedding groups", () => {
  it("reads each workspace's AI target once", async () => {
    vi.stubEnv("OWN_AI_KEYS_ENABLED", "true");
    setAiEnv({
      AI_PROVIDER: "openai-compatible",
      AI_MODEL: "server-model",
      AI_BASE_URL: "https://server.example.com/v1",
      AI_API_KEY: "server-key",
      AI_EMBEDDINGS_MODEL: "server-emb",
    });
    accounts.lookups = 0;
    const groups = await embeddingGroups(["own", "plain-1", "plain-2"]);
    expect(groups.map((g) => [g.model, g.workspaceIds])).toEqual([
      ["own-emb", ["own"]],
      ["server-emb", ["plain-1", "plain-2"]],
    ]);
    expect(accounts.lookups).toBe(3);
  });
});

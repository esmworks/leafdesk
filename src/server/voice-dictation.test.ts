/**
 * Dictation in the AI chat's box and in a page: who may dictate where, and what AI usage it counts as.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aiUsageGroup } from "@/lib/ai-usage";
import { installFauxAi, resetAi } from "@/server/ai/testing";
import { memoryAiUsageLedger } from "@/server/ai/usage";

const settings = vi.hoisted(() => ({ ai: true as boolean | undefined }));

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/server/collab/bridge", () => ({ getCollab: vi.fn() }));
vi.mock("@/server/pages", () => ({ createPage: vi.fn() }));
vi.mock("@/server/databases", () => ({ knownProperties: vi.fn() }));
vi.mock("@/server/mail/locale", () => ({ recipientLocale: vi.fn() }));
vi.mock("@/server/ai-writing", () => ({ aiAvailable: vi.fn() }));
vi.mock("@/server/workspaces", () => ({ workspaceSettings: async () => ({ ai: settings.ai }) }));
vi.mock("@/server/access", async () => {
  class AccessError extends Error {}
  class WorkspacePolicyError extends AccessError {}
  class ConnectedAppReadOnlyError extends AccessError {}
  return {
    AccessError,
    WorkspacePolicyError,
    ConnectedAppReadOnlyError,
    accessRank: vi.fn(),
    hasLevel: vi.fn(),
    levelFromRank: vi.fn(),
    requirePageAccess: vi.fn(),
    requireMembership: async (userId: string) => {
      if (userId !== "member") throw new AccessError("Not a member");
    },
  };
});

const { transcribeDictation } = await import("./voice-notes");

const audio = { bytes: new Blob([new Uint8Array(512)], { type: "audio/webm" }), type: "audio/webm" };
let ledger: ReturnType<typeof memoryAiUsageLedger>;
let heard: string[];

beforeEach(() => {
  settings.ai = true;
  heard = [];
  ledger = memoryAiUsageLedger();
  installFauxAi(() => "unused", {
    usage: ledger,
    transcribe: async ({ type }) => {
      heard.push(type);
      return "  What did we decide about the launch?  ";
    },
  });
});

afterEach(() => resetAi());

describe("transcribeDictation", () => {
  it("writes down what was said, counted as the chat's usage", async () => {
    expect(await transcribeDictation("member", "w1", audio)).toBe("What did we decide about the launch?");
    expect(heard).toEqual(["audio/webm"]);
    expect(ledger.rows).toMatchObject([{ workspaceId: "w1", feature: "chat.dictate", model: "faux-listener", requests: 1 }]);
    expect(aiUsageGroup("chat.dictate")).toBe("chat");
  });

  it("counts dictation into a page as voice usage", async () => {
    expect(await transcribeDictation("member", "w1", audio, { inPage: true })).toBe("What did we decide about the launch?");
    expect(ledger.rows).toMatchObject([{ workspaceId: "w1", feature: "voice.dictate", requests: 1 }]);
    expect(aiUsageGroup("voice.dictate")).toBe("voice");
  });

  it("is only for the workspace's members", async () => {
    await expect(transcribeDictation("stranger", "w1", audio)).rejects.toMatchObject({ code: "noAccess" });
    expect(heard).toEqual([]);
  });

  it("is off where the workspace turned AI off or the server can't transcribe", async () => {
    settings.ai = false;
    await expect(transcribeDictation("member", "w1", audio)).rejects.toMatchObject({ code: "disabled" });
    settings.ai = true;
    installFauxAi(() => "unused");
    await expect(transcribeDictation("member", "w1", audio)).rejects.toMatchObject({ code: "disabled" });
    expect(heard).toEqual([]);
    expect(ledger.rows).toEqual([]);
  });

  it("passes the transcription's failures on", async () => {
    installFauxAi(() => "unused", { usage: ledger, transcribe: async () => "" });
    await expect(transcribeDictation("member", "w1", audio)).rejects.toMatchObject({ code: "empty" });
    const big = { bytes: new Blob([new Uint8Array(26 * 1024 * 1024)]), type: "audio/webm" };
    await expect(transcribeDictation("member", "w1", big)).rejects.toMatchObject({ code: "tooLarge" });
  });
});

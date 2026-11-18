import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ stream: vi.fn(), complete: vi.fn() }));
vi.mock("@/server/ai", async (original) => ({ ...(await original<object>()), stream: mocks.stream, complete: mocks.complete }));

import { AiError } from "@/server/ai";
import { runTurns, type TurnHooks } from "./turns";

const result = (text: string) => ({ text, toolCalls: [], stopReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0 }, message: { role: "assistant", content: text }, model: "m" });

/** Turns of a `complete` call: each is a result or an error. */
function script(...turns: (ReturnType<typeof result> | AiError)[]) {
  for (const turn of turns) {
    if (turn instanceof AiError) mocks.complete.mockRejectedValueOnce(turn);
    else mocks.complete.mockResolvedValueOnce(turn);
  }
}

function hooks(extra: Partial<TurnHooks<never, never>>): TurnHooks<never, never> {
  return {
    request: () => ({ feature: "chat", userId: "u", workspaceId: "w" }),
    streaming: false,
    spentUsd: () => 0,
    limitUsd: 100,
    afterTurn: async () => null,
    makeRoom: () => false,
    answerCalls: async function* () {
      return null;
    },
    ...extra,
  };
}

async function run(extra: Partial<TurnHooks<never, never>>) {
  const turns = runTurns<never, never>([{ role: "user", content: "hi" }], { round: 0, pending: false }, hooks(extra));
  for (;;) {
    const next = await turns.next();
    if (next.done) return next.value;
  }
}

describe("runTurns retryTurn", () => {
  beforeEach(() => vi.clearAllMocks());

  it("asks the same turn again when the hook says so", async () => {
    script(new AiError("provider", "down"), result("answered"));
    let model = "fast";
    const request = vi.fn(() => ({ feature: "chat", userId: "u", workspaceId: "w", model }));
    const outcome = await run({
      request,
      retryTurn: () => {
        model = "main";
        return true;
      },
    });
    expect(outcome).toMatchObject({ answered: true, text: "answered" });
    expect(request.mock.results.map((r) => (r.value as { model: string }).model)).toEqual(["fast", "main"]);
  });

  it("throws the error when the hook declines", async () => {
    script(new AiError("provider", "down"));
    await expect(run({ retryTurn: () => false })).rejects.toThrow("down");
    expect(mocks.complete).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, it } from "vitest";
import { CHAT_THINKING } from "@/lib/ai-chat";
import { featurePlan } from "./features";
import { THINKING_LEVELS } from "./thinking-levels";

describe("THINKING_LEVELS", () => {
  it("maps every level the chat and agents offer", () => {
    expect(Object.keys(THINKING_LEVELS).sort()).toEqual([...CHAT_THINKING].sort());
  });

  it("leaves balanced to the feature, so an agent left at it thinks as agents always did", () => {
    expect(THINKING_LEVELS.balanced).toBeUndefined();
    // What the AI layer then uses (ai/index.ts: request.thinking ?? plan.thinking).
    expect(THINKING_LEVELS.balanced ?? featurePlan("agent.fast").thinking).toBe("low");
    expect(THINKING_LEVELS.balanced ?? featurePlan("agent").thinking).toBeUndefined();
  });

  it("asks for as little thinking as possible when fast, and the model's own when deep", () => {
    expect(THINKING_LEVELS.fast).toBe("off");
    expect(THINKING_LEVELS.deep).toBe("model");
  });
});

import { describe, expect, it } from "vitest";
import { RUN_ROUNDS } from "./config";
import type { AiMessage, AiResult } from "./index";
import { ANSWER_NOW, isLastTurn, refuseLastCalls } from "./turns";

describe("the last turn", () => {
  it("comes once the turns have spent the limit", () => {
    expect(isLastTurn(3, 9.99, 10)).toBe(false);
    expect(isLastTurn(3, 10, 10)).toBe(true);
    expect(isLastTurn(0, 12.5, 10)).toBe(true);
    expect(isLastTurn(3, 0.3, 0.25)).toBe(true);
  });

  it("comes after RUN_ROUNDS turns for a model without a price", () => {
    expect(isLastTurn(RUN_ROUNDS - 2, 0, 10)).toBe(false);
    expect(isLastTurn(RUN_ROUNDS - 1, 0, 10)).toBe(true);
    expect(isLastTurn(RUN_ROUNDS + 5, 0, 10)).toBe(true);
  });

  it("answers its calls as not run, so the model is asked once more", () => {
    const messages: AiMessage[] = [{ role: "user", content: "Tidy the tickets" }];
    const message = { role: "assistant", content: [] } as unknown as AiResult["message"];
    const result = {
      text: "Let me look once more.",
      message,
      toolCalls: [
        { id: "a", name: "search_pages", arguments: { query: "tickets" } },
        { id: "b", name: "read_page", arguments: { page_id: "p" } },
      ],
    } as unknown as AiResult;
    refuseLastCalls(messages, result);
    expect(messages[1]).toBe(message);
    expect(messages.slice(2)).toEqual([
      { role: "tool", toolCallId: "a", name: "search_pages", content: `Not run: there are no turns left for tools. ${ANSWER_NOW}`, isError: true },
      { role: "tool", toolCallId: "b", name: "read_page", content: `Not run: there are no turns left for tools. ${ANSWER_NOW}`, isError: true },
    ]);
  });
});

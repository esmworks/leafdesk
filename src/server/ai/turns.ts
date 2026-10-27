// The turns of a chat question, research answer or agent run: each goes on until the model answers
// or the turns have spent AI_RUN_LIMIT_USD (RUN_ROUNDS for a model without a price); the last one
// answers with what it has.

import { RUN_ROUNDS } from "./config";
import type { AiMessage, AiResult } from "./index";

/** Whether turn `round` (from 0), after turns that cost `spentUsd`, is the last: it must answer. */
export function isLastTurn(round: number, spentUsd: number, limitUsd: number): boolean {
  return round >= RUN_ROUNDS - 1 || spentUsd >= limitUsd;
}

/** Added to the tool results the last turn reads. */
export const ANSWER_NOW = "(No more tool calls: answer now with what you have, and say what is left to do.)";

/**
 * The last turn called tools: its message goes in with each call answered as not run, so the model
 * is asked once more, and what it writes then is the answer. Text it wrote beside the calls was it
 * thinking aloud, not the answer.
 */
export function refuseLastCalls(messages: AiMessage[], result: AiResult): void {
  messages.push(result.message);
  for (const call of result.toolCalls) {
    messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: `Not run: there are no turns left for tools. ${ANSWER_NOW}`, isError: true });
  }
}

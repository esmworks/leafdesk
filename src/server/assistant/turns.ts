/**
 * The one turn loop of every answer the model gives with tools: a person's AI chat question
 * (ai-chat.ts converseChat), research, and every agent run (agents/run.ts converse). Each turn asks
 * the model; the tool calls it makes are answered (and may be asked about, which pauses or parks the
 * run), and the next turn reads their results, until it answers or the turns run out (ai/turns.ts:
 * the last one answers with what it has).
 *
 * What differs between them comes in as hooks: what waits before a turn (the workspace's allowance,
 * an agent's limits), what a turn's cost counts against, how room is made when the prompt is too
 * long, how a thought is kept, and how the calls are answered (`answerCalls`, which owns asking:
 * the chat parks and waits for the person; an agent's run pauses and leaves the worker). Either can
 * end the run early with an ending of its own (`E`), which the loop hands back untouched.
 *
 * The loop yields what a page shows as it happens (`thinking`, `reasoning`, `text`, `reset`) and
 * whatever the hooks yield; Stop is the request's `signal`, which ends the model's stream.
 */
import { complete, isAiError, stream, type AiMessage, type AiRequest, type AiResult, type AiToolCall } from "@/server/ai";
import { isLastTurn, refuseLastCalls } from "@/server/ai/turns";

/** What the loop itself shows: a turn starting, the model's thinking and text as they come, and text taken back (it called tools after all). */
export type TurnEvent = { type: "thinking" } | { type: "reasoning"; text: string } | { type: "text"; text: string } | { type: "reset" };

/** How the loop ended: the model answered, or a hook ended the run (its own ending, as it gave it). */
export type TurnOutcome<E> = { answered: true; text: string; stopReason: "stop" | "length"; model: string } | { answered: false; ending: E };

export type TurnHooks<Y, E> = {
  /** The request of the next turn (the messages are the loop's). */
  request: () => Omit<AiRequest, "messages">;
  /** Streams turns (a page or a chat follows the text); else each turn is one call. */
  streaming: boolean;
  /** What every turn so far cost, for the limit of the run (ai/turns.ts isLastTurn). */
  spentUsd: () => number;
  limitUsd: number;
  /**
   * Before each turn (`first`: the first in this process): waiting for the workspace's AI
   * allowance, a limit reached since. An ending stops the run there.
   */
  beforeTurn?: (round: number, first: boolean) => AsyncGenerator<Y, E | null>;
  /** A turn's result came back: counted where it counts. An ending stops the run there. */
  afterTurn: (result: AiResult) => Promise<E | null>;
  /** The model found the prompt too long: drops what it can and says whether it did (`streamed`: text already shown this turn). */
  makeRoom: (streamed: boolean) => boolean;
  /** What the model wrote before calling tools: thinking aloud, kept as a step where the hook keeps it. */
  thought?: (text: string) => Promise<Y | null>;
  /**
   * Answers the calls of a turn in order (null: those waiting from before, the first decided on),
   * adding their results to the messages; `answerNext`: the next turn must answer. An ending stops
   * the run (an agent's run paused for an owner's approval, finish_run).
   */
  answerCalls: (calls: AiToolCall[] | null, answerNext: boolean) => AsyncGenerator<Y, E | null>;
};

/**
 * Runs the turns from `round` (turns that called tools so far). `pending`: calls of the last turn
 * still wait for answers (a run going on after a decision, or after a restart), answered first.
 */
export async function* runTurns<Y, E>(
  messages: AiMessage[],
  { round: start, pending }: { round: number; pending: boolean },
  hooks: TurnHooks<Y, E>,
): AsyncGenerator<Y | TurnEvent, TurnOutcome<E>> {
  let round = start;
  // The last turn called tools instead of answering: it's asked once more, with none run.
  let closing = false;
  let waiting = pending;
  let first = true;
  for (;;) {
    if (!waiting) {
      if (hooks.beforeTurn) {
        const ended = yield* hooks.beforeTurn(round, first);
        if (ended !== null) return { answered: false, ending: ended };
      }
      first = false;
      const last = isLastTurn(round, hooks.spentUsd(), hooks.limitUsd);
      yield { type: "thinking" };
      let streamed = "";
      // Text shown since the last reset: once a tool call starts, it was the model thinking aloud.
      let shown = false;
      let result: AiResult;
      try {
        const request: AiRequest = { ...hooks.request(), messages };
        if (hooks.streaming) {
          const turn = stream(request);
          for await (const event of turn) {
            // The model's thinking is shown as it comes, and not kept.
            if (event.type === "thinking") {
              yield { type: "reasoning", text: event.delta };
              continue;
            }
            // Writing a tool call's arguments (rows to add) can take minutes: the page shows it works.
            if (event.type === "toolCall") {
              if (shown) yield { type: "reset" };
              shown = false;
              yield { type: "thinking" };
              continue;
            }
            streamed += event.delta;
            shown = true;
            yield { type: "text", text: event.delta };
          }
          result = await turn.result();
        } else {
          result = await complete(request);
          streamed = result.text;
        }
      } catch (error) {
        // Too long for the model: the same turn is asked again with room made.
        if (isAiError(error) && error.code === "tooLarge" && hooks.makeRoom(Boolean(streamed))) continue;
        throw error;
      }
      const ended = await hooks.afterTurn(result);
      if (ended !== null) return { answered: false, ending: ended };
      if (last && result.toolCalls.length && !closing) {
        closing = true;
        if (shown) yield { type: "reset" };
        refuseLastCalls(messages, result);
        continue;
      }
      if (!result.toolCalls.length || last) {
        return { answered: true, text: result.text, stopReason: result.stopReason === "length" ? "length" : "stop", model: result.model };
      }
      // Text before a tool call is the model thinking aloud, not the answer.
      if (shown) yield { type: "reset" };
      if (hooks.thought) {
        const step = await hooks.thought(streamed);
        if (step !== null) yield step;
      }
      messages.push(result.message);
      round += 1;
      const ended2 = yield* hooks.answerCalls(result.toolCalls, isLastTurn(round, hooks.spentUsd(), hooks.limitUsd));
      if (ended2 !== null) return { answered: false, ending: ended2 };
      continue;
    }
    waiting = false;
    const ended = yield* hooks.answerCalls(null, isLastTurn(round, hooks.spentUsd(), hooks.limitUsd));
    if (ended !== null) return { answered: false, ending: ended };
  }
}

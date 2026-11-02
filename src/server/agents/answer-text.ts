/**
 * An agent's chat answer while it is written (run.ts converse), as the person chatting follows it
 * in the run's events (ai-chat-runs.ts). Only the text of the model's turn under way: a turn that
 * ends in tool calls starts over (its text becomes a thought step), and the answer itself is still
 * the run's `answer`, read when the run ends.
 *
 * The text is published as the run will keep it: credentials masked (lib/redact.ts) and cut at
 * ANSWER_CHARS. While a turn is written its last word is held back, so a token being written
 * shows only once it is whole and can be masked.
 */
import { redactText } from "@/lib/redact";

/** As much of an answer as a run keeps (run.ts finish). */
export const ANSWER_CHARS = 8_000;

/** What of a turn's text so far is shown: masked, without its last word while it may still grow. */
export function shownText(text: string, whole: boolean): string {
  // What lies past what is kept is never shown: masked from a little further, for a credential across the cut.
  const kept = text.slice(0, ANSWER_CHARS + 500);
  const ready = whole || kept.length < text.length ? kept : kept.slice(0, kept.search(/\S*$/));
  return redactText(ready).slice(0, ANSWER_CHARS);
}

export type AnswerEvent = { type: "text"; text: string } | { type: "reset" };

/**
 * Turns a turn's text so far into the AI chat's text events: `write` takes all of it (`whole` once
 * the turn has ended with it as the answer) and publishes what was added; `clear` starts over (a
 * new turn, or one that called tools). When masking changes what was already shown (a credential
 * completed past a word), the follower is told to start over and gets all of it again.
 */
export function answerEvents(publish: (event: AnswerEvent) => void) {
  let shown = "";
  return {
    write(text: string, whole = false) {
      const next = shownText(text, whole);
      if (next === shown) return;
      if (next.startsWith(shown)) publish({ type: "text", text: next.slice(shown.length) });
      else {
        publish({ type: "reset" });
        if (next) publish({ type: "text", text: next });
      }
      shown = next;
    },
    clear() {
      if (!shown) return;
      shown = "";
      publish({ type: "reset" });
    },
  };
}

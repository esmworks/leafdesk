/**
 * What an agent's chat run is writing, while it writes it: run.ts converse publishes it into the
 * answers' store the AI chat's answers go through (ai-chat-runs.ts), as `text` and `reset` events,
 * and the follow route `/api/agents/chat/live` and the Telegram bot read them back. Only the text of
 * the model's turn under way: a turn that ends in tool calls starts over (a `reset`; its text becomes
 * a thought step), and the answer itself is still the run's `answer`, read when the run ends. The
 * store's run is also what Stop aborts (run.ts stopRun). A run taken by another process's worker has
 * none here; its answer then comes whole at the end.
 *
 * The text is published as the run will keep it: credentials masked (lib/redact.ts) and cut at
 * ANSWER_CHARS. While a turn is written its last word is held back, so a token being written
 * shows only once it is whole and can be masked; should masking change what was sent already, the
 * text is sent again whole after a `reset`.
 */
import type { ChatEvent } from "@/lib/ai-chat";
import { redactText } from "@/lib/redact";
import { abortRun, endRun, followRun, knownRun, openRun, pushEvent, stopRun } from "@/server/ai-chat-runs";

/** As much of an answer as a run keeps (run.ts finish). */
export const ANSWER_CHARS = 8_000;
/** How long a follower goes without an event before it is sent a ping. */
const PING_MS = 20_000;

/** An agent's run in the answers' store: a key the AI chat's browser-picked ids (`[\w-]`) never take. */
const key = (runId: string) => `agent:${runId}`;

/** What of a turn's text so far is shown: masked, without its last word while it may still grow. */
export function shownText(text: string, whole: boolean): string {
  // What lies past what is kept is never shown: masked from a little further, for a credential across the cut.
  const kept = text.slice(0, ANSWER_CHARS + 500);
  const ready = whole || kept.length < text.length ? kept : kept.slice(0, kept.search(/\S*$/));
  return redactText(ready).slice(0, ANSWER_CHARS);
}

/**
 * Starts publishing a chat run's text (again, for a run going on after an approval), for the person
 * chatting (`userId`). `write` takes the turn's text so far, `whole` once the turn has ended with it
 * as the answer; `clear` starts over (a new turn, or one that called tools); `end` when the run
 * stops, however it went. `signal` aborts when the person stops the answer. Null when the run is
 * under way here already.
 */
export function startLiveText(runId: string, userId: string, workspaceId: string) {
  const answer = openRun({ id: key(runId), userId, workspaceId, conversationId: null, agent: true });
  if (!answer) return null;
  let sent = "";
  const show = (text: string) => {
    if (text === sent) return;
    if (sent && !text.startsWith(sent)) pushEvent(answer, { type: "reset" });
    const added = text.startsWith(sent) ? text.slice(sent.length) : text;
    if (added) pushEvent(answer, { type: "text", text: added });
    sent = text;
  };
  return {
    signal: answer.controller.signal,
    write: (text: string, whole = false) => show(shownText(text, whole)),
    clear: () => show(""),
    end: () => endRun(answer),
  };
}

export type LiveTextWriter = NonNullable<ReturnType<typeof startLiveText>>;

/**
 * The person's chat run's text events from its start, then as they come, until it ends or `signal`
 * aborts; nothing when it isn't under way here (not started yet, waiting for an approval, ended a
 * while ago). The caller checks first that the run is the person's chat (chat.ts mayFollowChatTurn).
 */
export function followLiveText(userId: string, runId: string, signal: AbortSignal): AsyncGenerator<ChatEvent> {
  return followRun(userId, key(runId), signal, PING_MS) ?? (async function* () {})();
}

/**
 * Stops the person's chat run if it answers here: true when it did, or when it was taken but hasn't
 * started answering yet (`taken`: it stops as it starts). Never one waiting for an approval.
 */
export function stopLiveText(userId: string, runId: string, taken: boolean): boolean {
  if (abortRun(userId, key(runId))) return true;
  // One that answered here has ended already.
  if (!taken || knownRun(key(runId))) return false;
  stopRun(userId, key(runId));
  return true;
}

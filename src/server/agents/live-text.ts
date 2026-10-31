/**
 * What an agent's chat run is writing, while it writes it (run.ts converse publishes it, the
 * follow route `/api/agents/chat/live` sends it to the person chatting). Only the text of the
 * model's turn under way: a turn that ends in tool calls starts over (its text becomes a thought
 * step), and the answer itself is still the run's `answer`, read when the run ends. Nothing here is
 * kept: it lives in this process for the run's time and a short while after, so a follower arriving
 * just then still gets it. A run taken by another process's worker has none here; its answer then
 * comes whole at the end, as before.
 *
 * The text is published as the run will keep it: credentials masked (lib/redact.ts) and cut at
 * ANSWER_CHARS. While a turn is written its last word is held back, so a token being written
 * shows only once it is whole and can be masked.
 */
import type { LiveTextEdit } from "@/lib/agent-chat";
import { redactText } from "@/lib/redact";

/** As much of an answer as a run keeps (run.ts finish). */
export const ANSWER_CHARS = 8_000;
/** How long an ended run's text stays for a follower arriving just then. */
const KEEP_MS = 60_000;
/** How long a follower goes without an edit before it is sent one that changes nothing. */
const PING_MS = 20_000;
/** The longest one follow goes on; the chat opens another while the run goes on. */
const FOLLOW_MS = 10 * 60_000;

type Live = {
  text: string;
  /** Started by the run's worker in this process (not only waited for by a follower). */
  started: boolean;
  ended: boolean;
  followers: Set<() => void>;
  timer: ReturnType<typeof setTimeout> | null;
};

// On globalThis: the worker (server.ts) and the follow route (Next's bundle) are separate module graphs.
const KEY = "__leafdeskAgentLiveText";
const store = ((globalThis as Record<string, unknown>)[KEY] ??= { runs: new Map<string, Live>() }) as { runs: Map<string, Live> };

function entry(runId: string): Live {
  let live = store.runs.get(runId);
  if (!live) {
    live = { text: "", started: false, ended: false, followers: new Set(), timer: null };
    store.runs.set(runId, live);
  }
  return live;
}

function publish(live: Live, text: string) {
  if (text === live.text) return;
  live.text = text;
  for (const wake of live.followers) wake();
}

/** What of a turn's text so far is shown: masked, without its last word while it may still grow. */
export function shownText(text: string, whole: boolean): string {
  // What lies past what is kept is never shown: masked from a little further, for a credential across the cut.
  const kept = text.slice(0, ANSWER_CHARS + 500);
  const ready = whole || kept.length < text.length ? kept : kept.slice(0, kept.search(/\S*$/));
  return redactText(ready).slice(0, ANSWER_CHARS);
}

/**
 * Starts publishing a chat run's text (again, for a run going on after an approval). `write` takes
 * the turn's text so far, `whole` once the turn has ended with it as the answer; `clear` starts
 * over (a new turn, or one that called tools); `end` when the run stops, however it went.
 */
export function startLiveText(runId: string) {
  const live = entry(runId);
  if (live.timer) clearTimeout(live.timer);
  live.timer = null;
  live.started = true;
  live.ended = false;
  publish(live, "");
  return {
    write: (text: string, whole = false) => {
      if (!live.ended) publish(live, shownText(text, whole));
    },
    clear: () => {
      if (!live.ended) publish(live, "");
    },
    end: () => {
      if (live.ended) return;
      live.ended = true;
      for (const wake of live.followers) wake();
      // Then it is as if it never started here; a follower still waiting forgets it as it goes.
      live.timer = setTimeout(() => {
        live.started = false;
        if (store.runs.get(runId) === live && !live.followers.size) store.runs.delete(runId);
      }, KEEP_MS);
      live.timer.unref?.();
    },
  };
}

export type LiveTextWriter = ReturnType<typeof startLiveText>;

/** How to go from `from` to `to`: the letters they share at the start are kept. */
export function editBetween(from: string, to: string): LiveTextEdit {
  let at = 0;
  const most = Math.min(from.length, to.length);
  while (at < most && from.charCodeAt(at) === to.charCodeAt(at)) at++;
  // Never between the two halves of an emoji.
  if (at > 0 && at < to.length && /[\uDC00-\uDFFF]/.test(to[at])) at--;
  return { at, add: to.slice(at) };
}

/**
 * A run's text as it changes, until `signal` aborts or FOLLOW_MS have gone by: first all of it,
 * then edits, and an edit that changes nothing after PING_MS without one (a proxy keeps the
 * connection open). A run that hasn't started here yet, or has stopped (waiting for an approval),
 * is waited for: it starts over when it goes on. The caller checks first that the run is the
 * person's chat (chat.ts mayFollowChatTurn), and stops following once the run has ended.
 */
export async function* followLiveText(runId: string, signal: AbortSignal): AsyncGenerator<LiveTextEdit> {
  const live = entry(runId);
  let wake: (() => void) | null = null;
  const listener = () => wake?.();
  live.followers.add(listener);
  signal.addEventListener("abort", listener);
  try {
    const until = Date.now() + FOLLOW_MS;
    let sent = live.text;
    yield { at: 0, add: sent };
    for (;;) {
      if (signal.aborted || Date.now() > until) return;
      // Taken whole each time: changes that came while the last edit was sent run together.
      if (live.text !== sent) {
        const edit = editBetween(sent, live.text);
        sent = live.text;
        yield edit;
        continue;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const pinged = await new Promise<boolean>((resolve) => {
        wake = () => resolve(false);
        timer = setTimeout(() => resolve(true), PING_MS);
      });
      clearTimeout(timer);
      wake = null;
      if (pinged && live.text === sent && !signal.aborted) yield { at: sent.length, add: "" };
    }
  } finally {
    live.followers.delete(listener);
    signal.removeEventListener("abort", listener);
    // Waited for here only, by no one now: the run is another process's, or never started.
    if (!live.started && !live.followers.size && store.runs.get(runId) === live) store.runs.delete(runId);
  }
}

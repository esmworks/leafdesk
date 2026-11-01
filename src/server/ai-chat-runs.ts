/**
 * Answers on their way: the AI chat's (`/api/ai/chat`, see ai-chat.ts) and agents' chat runs
 * (agents/live-text.ts, which publishes only their text, masked). Each runs apart from the request
 * that asked for it: a page reloaded or closed mid-answer doesn't stop it, and it saves its turn as
 * usual. Its events so far are kept (text run together, without pings and the model's thinking), so
 * the page coming back, or another tab, follows it again from the start: what was written, its
 * steps and a change waiting for approval, then what comes next. Stop is a request of its own
 * (stopRun), only from the person whose answer it is; one that comes before its answer has started
 * stops it as it starts. Kept in this process like the approvals they may wait on
 * (ai-chat-approvals.ts); an answer that ended stays a minute for a page reading it just then.
 * An agent's run is kept under a key no browser picks (live-text.ts), and the AI chat's questions
 * about its own conversations (runningIn, answeringIn, conversationBusy, stopRunsIn) skip it.
 */
import type { ChatEvent } from "@/lib/ai-chat";

/** How long an ended answer stays to be followed, and how long a Stop waits for its answer to start. */
const KEEP_MS = 60_000;
/** How long a question waits for the stopped answer before it in its conversation to be saved. */
const SETTLE_MS = 10_000;
/** The most Stops kept for answers that haven't started (a flood of made-up ids goes no further). */
const MAX_EARLY_STOPS = 10_000;

type Run = {
  id: string;
  userId: string;
  workspaceId: string;
  /** Known once the answer has said it (its `conversation` event), for a new conversation. */
  conversationId: string | null;
  /** An agent's chat run: only its text is published, and it is no AI chat conversation's. */
  agent: boolean;
  controller: AbortController;
  /** The events so far, as a page following the answer from the start needs them. */
  log: ChatEvent[];
  /** Pages following it: told each event as it comes, and null once it has ended. */
  followers: Set<(event: ChatEvent | null) => void>;
  ended: boolean;
  settled: Promise<void>;
  settle: () => void;
};

// On globalThis: the server actions that stop an answer and show conversations are bundled apart
// from the route that runs it.
const KEY = "__leafdeskAiChatRuns";
const store = ((globalThis as Record<string, unknown>)[KEY] ??= { runs: new Map<string, Run>(), earlyStops: new Map<string, number>() }) as {
  runs: Map<string, Run>;
  /** Stops of answers not started yet, by `userId:runId`, with when they came. */
  earlyStops: Map<string, number>;
};

/** What a run id sent by the browser may look like. */
export const isRunId = (id: unknown): id is string => typeof id === "string" && /^[\w-]{8,100}$/.test(id);

/**
 * Registers an answer about to start, under the id the browser picked (or its run's, going on);
 * null when an answer under way has that id.
 * Its signal is what the answer runs with (aborted already when a Stop came first). Hand it the
 * answer's events with runEvents, or drop it with dropRun when the answer was refused.
 */
export function openRun({ agent = false, ...meta }: { id: string; userId: string; workspaceId: string; conversationId: string | null; agent?: boolean }): Run | null {
  // An answer that ended may go on again under its id (a run taken up again: ai-chat.ts resumeChatRun).
  if (store.runs.get(meta.id)?.ended === false) return null;
  let settle = () => {};
  const settled = new Promise<void>((resolve) => (settle = resolve));
  const run: Run = { ...meta, agent, controller: new AbortController(), log: [], followers: new Set(), ended: false, settled, settle };
  if (store.earlyStops.delete(`${meta.userId}:${meta.id}`)) run.controller.abort();
  store.runs.set(meta.id, run);
  return run;
}

/** Forgets a run whose answer was refused before it started. */
export function dropRun(run: Run) {
  if (store.runs.get(run.id) === run) store.runs.delete(run.id);
  run.settle();
}

export type AnswerRun = Run;

/** Runs the answer's events to their end, whoever follows them: kept, and told to its followers. */
export async function runEvents(run: Run, events: AsyncIterable<ChatEvent>) {
  try {
    for await (const event of events) pushEvent(run, event);
  } catch (error) {
    console.error("[ai] chat answer failed", error);
    if (!run.ended) pushEvent(run, { type: "error", code: "provider" });
  } finally {
    endRun(run);
  }
}

/** One event of an answer (an agent's run publishes its own, live-text.ts): kept, and told to its followers. */
export function pushEvent(run: Run, event: ChatEvent) {
  if (run.ended) return;
  if (event.type === "conversation") run.conversationId = event.id;
  // An agent's run publishes only text: what a reset takes back needn't be read again from the start.
  if (run.agent && event.type === "reset") run.log = [];
  // Not kept: pings only keep a connection open, and the model's thinking is never kept.
  else if (event.type !== "ping" && event.type !== "reasoning") {
    const last = run.log.at(-1);
    if (event.type === "text" && last?.type === "text") run.log[run.log.length - 1] = { type: "text", text: last.text + event.text };
    else run.log.push(event);
  }
  for (const follower of run.followers) follower(event);
  // The turn is saved before these: the conversation is free for its next question at once.
  if (event.type === "done" || event.type === "error") endRun(run);
}

/** Ends an answer: its followers stop following, and it stays a minute for one reading it just then. */
export function endRun(run: Run) {
  if (run.ended) return;
  run.ended = true;
  for (const follower of run.followers) follower(null);
  run.followers.clear();
  run.settle();
  const timer = setTimeout(() => {
    if (store.runs.get(run.id) === run) store.runs.delete(run.id);
  }, KEEP_MS);
  timer.unref?.();
}

/**
 * The person's answer's events from its start, then as they come, until it ends or `signal`
 * aborts (the page went: the answer goes on). Null when there is no such answer of theirs.
 * `pingMs`: a ping after that long without an event (an agent's run publishes none of its own while
 * a tool answers), so a proxy keeps the connection open.
 */
export function followRun(userId: string, runId: string, signal?: AbortSignal, pingMs?: number): AsyncGenerator<ChatEvent> | null {
  const run = store.runs.get(runId);
  if (!run || run.userId !== userId) return null;
  return follow(run, signal, pingMs);
}

async function* follow(run: Run, signal?: AbortSignal, pingMs?: number): AsyncGenerator<ChatEvent> {
  // Taken together, in one go: nothing comes between what was kept and what follows.
  const queue = [...run.log];
  let ended = run.ended;
  let wake: (() => void) | null = null;
  const listener = (event: ChatEvent | null) => {
    if (event) queue.push(event);
    else ended = true;
    wake?.();
  };
  const onAbort = () => wake?.();
  if (!ended) run.followers.add(listener);
  signal?.addEventListener("abort", onAbort);
  try {
    for (;;) {
      while (queue.length && !signal?.aborted) yield queue.shift()!;
      if (ended || signal?.aborted) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const pinged = await new Promise<boolean>((resolve) => {
        wake = () => resolve(false);
        if (pingMs) timer = setTimeout(() => resolve(true), pingMs);
      });
      clearTimeout(timer);
      wake = null;
      if (pinged && !queue.length && !ended && !signal?.aborted) yield { type: "ping" };
    }
  } finally {
    run.followers.delete(listener);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Stops the person's answer: true when it was on its way. One that hasn't started yet (the Stop
 * came first) is stopped as it starts.
 */
export function stopRun(userId: string, runId: string): boolean {
  if (store.runs.has(runId)) return abortRun(userId, runId);
  const now = Date.now();
  for (const [key, at] of store.earlyStops) if (now - at > KEEP_MS) store.earlyStops.delete(key);
  if (store.earlyStops.size < MAX_EARLY_STOPS) store.earlyStops.set(`${userId}:${runId}`, now);
  return false;
}

/** Whether an answer has that id here: on its way, or ended a moment ago. */
export const knownRun = (runId: string) => store.runs.has(runId);

/** Stops the person's answer if it is on its way here: true when it was. Never one not started yet. */
export function abortRun(userId: string, runId: string): boolean {
  const run = store.runs.get(runId);
  if (!run || run.userId !== userId || run.ended) return false;
  run.controller.abort();
  return true;
}

/** Stops the person's answers in these conversations (being deleted), or in all of theirs in the workspace. */
export function stopRunsIn(userId: string, workspaceId: string, conversationIds: string[] | "all") {
  for (const run of store.runs.values()) {
    if (run.ended || run.agent || run.userId !== userId || run.workspaceId !== workspaceId) continue;
    if (conversationIds === "all" || (run.conversationId && conversationIds.includes(run.conversationId))) run.controller.abort();
  }
}

/** The person's answer on its way in a conversation, if any. */
function liveRun(userId: string, conversationId: string): Run | null {
  for (const run of store.runs.values()) if (!run.ended && !run.agent && run.userId === userId && run.conversationId === conversationId) return run;
  return null;
}

/** The id of the person's answer on its way in a conversation, or null. */
export function runningIn(userId: string, conversationId: string): string | null {
  return liveRun(userId, conversationId)?.id ?? null;
}

/** The person's conversations in the workspace that an answer is on its way in. */
export function answeringIn(userId: string, workspaceId: string): Set<string> {
  const ids = new Set<string>();
  for (const run of store.runs.values()) if (!run.ended && !run.agent && run.userId === userId && run.workspaceId === workspaceId && run.conversationId) ids.add(run.conversationId);
  return ids;
}

/**
 * Whether a conversation is still being answered, so a question asked there now would be saved
 * beside that answer. One that was stopped is waited for (it saves what it wrote first), a while.
 */
export async function conversationBusy(userId: string, conversationId: string): Promise<boolean> {
  const run = liveRun(userId, conversationId);
  if (!run) return false;
  if (!run.controller.signal.aborted) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([run.settled, new Promise<void>((resolve) => (timer = setTimeout(resolve, SETTLE_MS)))]);
  clearTimeout(timer);
  return !run.ended;
}

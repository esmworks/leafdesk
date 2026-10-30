/**
 * AI chat answers on their way (`/api/ai/chat`, see ai-chat.ts). Each runs apart from the request
 * that asked for it: a page reloaded or closed mid-answer doesn't stop it, and it saves its turn as
 * usual. Its events so far are kept (text run together, without pings and the model's thinking), so
 * the page coming back, or another tab, follows it again from the start: what was written, its
 * steps and a change waiting for approval, then what comes next. Stop is a request of its own
 * (stopRun), only from the person whose answer it is; one that comes before its answer has started
 * stops it as it starts. Kept in this process like the approvals they may wait on
 * (ai-chat-approvals.ts); an answer that ended stays a minute for a page reading it just then.
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
 * Registers an answer about to start, under the id the browser picked; null when that id is taken.
 * Its signal is what the answer runs with (aborted already when a Stop came first). Hand it the
 * answer's events with runEvents, or drop it with dropRun when the answer was refused.
 */
export function openRun(meta: { id: string; userId: string; workspaceId: string; conversationId: string | null }): Run | null {
  if (store.runs.has(meta.id)) return null;
  let settle = () => {};
  const settled = new Promise<void>((resolve) => (settle = resolve));
  const run: Run = { ...meta, controller: new AbortController(), log: [], followers: new Set(), ended: false, settled, settle };
  if (store.earlyStops.delete(`${meta.userId}:${meta.id}`)) run.controller.abort();
  store.runs.set(meta.id, run);
  return run;
}

/** Forgets a run whose answer was refused before it started. */
export function dropRun(run: Run) {
  if (store.runs.get(run.id) === run) store.runs.delete(run.id);
  run.settle();
}

/** Runs the answer's events to their end, whoever follows them: kept, and told to its followers. */
export async function runEvents(run: Run, events: AsyncIterable<ChatEvent>) {
  try {
    for await (const event of events) push(run, event);
  } catch (error) {
    console.error("[ai] chat answer failed", error);
    if (!run.ended) push(run, { type: "error", code: "provider" });
  } finally {
    end(run);
  }
}

function push(run: Run, event: ChatEvent) {
  if (event.type === "conversation") run.conversationId = event.id;
  // Not kept: pings only keep a connection open, and the model's thinking is never kept.
  if (event.type !== "ping" && event.type !== "reasoning") {
    const last = run.log.at(-1);
    if (event.type === "text" && last?.type === "text") run.log[run.log.length - 1] = { type: "text", text: last.text + event.text };
    else run.log.push(event);
  }
  for (const follower of run.followers) follower(event);
  // The turn is saved before these: the conversation is free for its next question at once.
  if (event.type === "done" || event.type === "error") end(run);
}

function end(run: Run) {
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
 */
export function followRun(userId: string, runId: string, signal?: AbortSignal): AsyncGenerator<ChatEvent> | null {
  const run = store.runs.get(runId);
  if (!run || run.userId !== userId) return null;
  return follow(run, signal);
}

async function* follow(run: Run, signal?: AbortSignal): AsyncGenerator<ChatEvent> {
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
      await new Promise<void>((resolve) => (wake = resolve));
      wake = null;
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
  const run = store.runs.get(runId);
  if (run) {
    if (run.userId !== userId) return false;
    if (run.ended) return false;
    run.controller.abort();
    return true;
  }
  const now = Date.now();
  for (const [key, at] of store.earlyStops) if (now - at > KEEP_MS) store.earlyStops.delete(key);
  if (store.earlyStops.size < MAX_EARLY_STOPS) store.earlyStops.set(`${userId}:${runId}`, now);
  return false;
}

/** Stops the person's answers in these conversations (being deleted), or in all of theirs in the workspace. */
export function stopRunsIn(userId: string, workspaceId: string, conversationIds: string[] | "all") {
  for (const run of store.runs.values()) {
    if (run.ended || run.userId !== userId || run.workspaceId !== workspaceId) continue;
    if (conversationIds === "all" || (run.conversationId && conversationIds.includes(run.conversationId))) run.controller.abort();
  }
}

/** The person's answer on its way in a conversation, if any. */
function liveRun(userId: string, conversationId: string): Run | null {
  for (const run of store.runs.values()) if (!run.ended && run.userId === userId && run.conversationId === conversationId) return run;
  return null;
}

/** The id of the person's answer on its way in a conversation, or null. */
export function runningIn(userId: string, conversationId: string): string | null {
  return liveRun(userId, conversationId)?.id ?? null;
}

/** The person's conversations in the workspace that an answer is on its way in. */
export function answeringIn(userId: string, workspaceId: string): Set<string> {
  const ids = new Set<string>();
  for (const run of store.runs.values()) if (!run.ended && run.userId === userId && run.workspaceId === workspaceId && run.conversationId) ids.add(run.conversationId);
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

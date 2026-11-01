/**
 * Changes the AI chat waits on the person to approve (mode "ask", see ai-chat.ts), while the answer
 * runs in this process: the run is parked in the database (`awaiting_approval`) and waits here for
 * decideChange (the chat's server action), however long it takes; stopping the answer ends the wait
 * with nothing written. Only the person whose answer it is can decide. A parked run no one waits on
 * here (the server restarted) is decided in the database instead (ai-chat.ts decideParkedChange).
 */
import { AiError } from "@/server/ai";

/** Yes, yes and don't ask again in this answer, or no. */
export type ChatDecision = "approve" | "always" | "decline";

type Waiting = { userId: string; runId: string; settle: (decision: ChatDecision) => void };

// On globalThis: the server action that decides is bundled apart from the route that waits.
const KEY = "__leafdeskAiChatApprovals";
const waiting = ((globalThis as Record<string, unknown>)[KEY] ??= new Map<string, Waiting>()) as Map<string, Waiting>;

/**
 * Starts waiting for the person's decision on a change their answer's run asks about, under a new
 * `id` (short enough for a Telegram button). `decision` settles with it and rejects with
 * AiError("aborted") when `signal` aborts; `cancel` stops waiting (the answer went away without one).
 */
export function awaitDecision(userId: string, runId: string, signal?: AbortSignal): { id: string; decision: Promise<ChatDecision>; cancel: () => void } {
  const id = crypto.randomUUID();
  let cancel = () => {};
  const decision = new Promise<ChatDecision>((resolve, reject) => {
    const done = () => {
      signal?.removeEventListener("abort", onAbort);
      if (waiting.get(id)?.settle === settle) waiting.delete(id);
    };
    const onAbort = () => {
      done();
      reject(new AiError("aborted", "Cancelled"));
    };
    const settle = (d: ChatDecision) => {
      done();
      resolve(d);
    };
    cancel = done;
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    waiting.set(id, { userId, runId, settle });
  });
  // Aborted while the answer is between yielding the approval and waiting on it: not unhandled.
  decision.catch(() => {});
  return { id, decision, cancel };
}

/** Settles a change the person was asked about; false when it isn't theirs or no one here waits on it. */
export function decideChange(userId: string, id: string, decision: ChatDecision): boolean {
  const entry = waiting.get(id);
  if (!entry || entry.userId !== userId) return false;
  entry.settle(decision);
  return true;
}

/** The runs (by id) whose answer waits here on the person: they are parked, not left behind. */
export function runsWaitingHere(): Set<string> {
  return new Set([...waiting.values()].map((w) => w.runId));
}

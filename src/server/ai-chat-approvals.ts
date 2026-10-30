/**
 * Changes the AI chat waits on the person to approve (mode "ask", see ai-chat.ts): the answer waits
 * (a page reloaded meanwhile is asked again, ai-chat-runs.ts), and decideChange (the chat's server
 * action) settles it. Only the person whose answer it is can decide; nothing waits longer than
 * APPROVAL_TIMEOUT_MS, and stopping the answer ends the wait with nothing written.
 */
import { APPROVAL_TIMEOUT_MS } from "@/lib/ai-chat";
import { AiError } from "@/server/ai";

/** Yes, yes and don't ask again in this answer, or no. */
export type ChatDecision = "approve" | "always" | "decline";

type Waiting = { userId: string; settle: (decision: ChatDecision | "timeout") => void };

// On globalThis: the server action that decides is bundled apart from the route that waits.
const KEY = "__leafdeskAiChatApprovals";
const waiting = ((globalThis as Record<string, unknown>)[KEY] ??= new Map<string, Waiting>()) as Map<string, Waiting>;

/**
 * Starts waiting for the person's decision on a change. `decision` settles with it, with "timeout"
 * when none comes in time, and rejects with AiError("aborted") when `signal` aborts.
 */
export function awaitDecision(userId: string, signal?: AbortSignal): { id: string; decision: Promise<ChatDecision | "timeout"> } {
  const id = crypto.randomUUID();
  const decision = new Promise<ChatDecision | "timeout">((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      waiting.delete(id);
    };
    const onAbort = () => {
      done();
      reject(new AiError("aborted", "Cancelled"));
    };
    const timer = setTimeout(() => {
      done();
      resolve("timeout");
    }, APPROVAL_TIMEOUT_MS);
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    waiting.set(id, {
      userId,
      settle: (d) => {
        done();
        resolve(d);
      },
    });
  });
  // Aborted while the answer is between yielding the approval and racing it: not unhandled.
  decision.catch(() => {});
  return { id, decision };
}

/** Settles a change the person was asked about; false when it isn't theirs or no longer waits. */
export function decideChange(userId: string, id: string, decision: ChatDecision): boolean {
  const entry = waiting.get(id);
  if (!entry || entry.userId !== userId) return false;
  entry.settle(decision);
  return true;
}

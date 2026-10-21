import { MAX_HANDOFF_WAIT_MS } from "@/lib/agents";

/**
 * A run's own time: `ms` from now, its signal aborting (as a timeout) when it runs out. While it
 * waits for the agents it asks (pause, resume) its time stands still, for up to MAX_HANDOFF_WAIT_MS
 * of waiting in all: past that, the wait eats into its own time.
 */
export function runClock(ms: number) {
  const controller = new AbortController();
  const cap = Date.now() + ms + MAX_HANDOFF_WAIT_MS;
  let deadline = Date.now() + ms;
  let pausedAt: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const arm = () => {
    timer = setTimeout(() => controller.abort(new DOMException("The run took too long", "TimeoutError")), Math.max(0, deadline - Date.now()));
    timer.unref?.();
  };
  arm();
  return {
    signal: controller.signal,
    /** How long a wait starting now may last and leave the run all of its own time. */
    waitLeft: () => (controller.signal.aborted ? 0 : Math.max(0, cap - Math.max(deadline, Date.now()))),
    pause() {
      if (timer) clearTimeout(timer);
      pausedAt = Date.now();
    },
    resume() {
      if (pausedAt === null) return;
      deadline = Math.min(deadline + (Date.now() - pausedAt), cap);
      pausedAt = null;
      arm();
    },
  };
}
export type RunClock = ReturnType<typeof runClock>;

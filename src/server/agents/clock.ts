import { MAX_HANDOFF_WAIT_MS } from "@/lib/agents";

/**
 * What a run may still wait for the agents it asks (pause, resume): MAX_HANDOFF_WAIT_MS in all. A
 * run has no time limit of its own; what it may spend is AI_RUN_LIMIT_USD.
 */
export function runClock() {
  let waited = 0;
  let pausedAt: number | null = null;
  return {
    /** How long a wait starting now may last. */
    waitLeft: () => Math.max(0, MAX_HANDOFF_WAIT_MS - waited - (pausedAt === null ? 0 : Date.now() - pausedAt)),
    pause() {
      pausedAt = Date.now();
    },
    resume() {
      if (pausedAt === null) return;
      waited += Date.now() - pausedAt;
      pausedAt = null;
    },
  };
}
export type RunClock = ReturnType<typeof runClock>;

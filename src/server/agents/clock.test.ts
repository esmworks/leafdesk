import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_HANDOFF_WAIT_MS } from "@/lib/agents";
import { runClock } from "./clock";

describe("a run's clock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts only the waits for the agents it asks", () => {
    const clock = runClock();
    vi.advanceTimersByTime(60 * 60_000);
    expect(clock.waitLeft()).toBe(MAX_HANDOFF_WAIT_MS);
    clock.pause();
    vi.advanceTimersByTime(60_000);
    expect(clock.waitLeft()).toBe(MAX_HANDOFF_WAIT_MS - 60_000);
    clock.resume();
    vi.advanceTimersByTime(60 * 60_000);
    expect(clock.waitLeft()).toBe(MAX_HANDOFF_WAIT_MS - 60_000);
  });

  it("never lets the waits pass the most a run may wait", () => {
    const clock = runClock();
    clock.pause();
    vi.advanceTimersByTime(MAX_HANDOFF_WAIT_MS + 10_000);
    clock.resume();
    expect(clock.waitLeft()).toBe(0);
  });
});
